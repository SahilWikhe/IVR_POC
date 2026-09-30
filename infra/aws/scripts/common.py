"""Bounded AWS deployment helpers. Importing this module never contacts AWS."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SHA = re.compile(r"^[a-f0-9]{40}$")
DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")


class OperationError(RuntimeError):
    """Safe error that deliberately excludes provider bodies and secret values."""


def required(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise OperationError(f"Required configuration is missing: {name}")
    return value


def identity() -> dict[str, str]:
    environment = required("AWS_ENVIRONMENT")
    namespace = os.environ.get("AWS_NAMESPACE", "hostline")
    if environment not in {"staging", "production"} or not re.fullmatch(
        r"[a-z][a-z0-9-]{2,12}", namespace
    ):
        raise OperationError("Invalid deployment namespace or environment.")
    if os.environ.get("AWS_DEPLOYMENT_READY") != "true":
        raise OperationError("Deployment readiness remains disabled.")
    region = required("AWS_REGION")
    account = required("AWS_ACCOUNT_ID")
    if not re.fullmatch(r"[a-z]{2}(?:-[a-z]+)+-[0-9]+", region) or not re.fullmatch(
        r"[0-9]{12}", account
    ):
        raise OperationError("Invalid configured AWS region or account.")
    return {
        "environment": environment,
        "namespace": namespace,
        "region": region,
        "account": account,
        "app_stack": f"{namespace}-{environment}-app",
        "data_stack": f"{namespace}-{environment}-data",
        "repository": f"{namespace}-{environment}",
    }


def aws(*args: str, allow_failure: bool = False) -> Any:
    command = ["aws", *args, "--region", required("AWS_REGION"), "--output", "json", "--no-cli-pager"]
    timeout = 1800 if len(args) > 1 and args[1] == "wait" else 120
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)
    if result.returncode:
        if allow_failure:
            return None
        # SDK/CLI errors may contain configuration or caller text. Operators get
        # console links rather than unbounded provider diagnostics in public CI.
        raise OperationError(f"AWS operation failed: {args[0]} {args[1]}")
    return json.loads(result.stdout) if result.stdout.strip() else {}


def stack(name: str, missing_ok: bool = False) -> dict[str, Any] | None:
    result = aws("cloudformation", "describe-stacks", "--stack-name", name, allow_failure=missing_ok)
    if result is None:
        return None
    stacks = result.get("Stacks", [])
    if len(stacks) != 1 or stacks[0].get("StackName") != name:
        raise OperationError("CloudFormation returned an unexpected stack.")
    return stacks[0]


def outputs(value: dict[str, Any]) -> dict[str, str]:
    return {item["OutputKey"]: item["OutputValue"] for item in value.get("Outputs", [])}


def image(sha: str, config: dict[str, str], data: dict[str, str]) -> str:
    if not SHA.fullmatch(sha):
        raise OperationError("Use the complete lowercase 40-character Git commit SHA.")
    expected = f"{config['account']}.dkr.ecr.{config['region']}.amazonaws.com/{config['repository']}"
    if data.get("RepositoryUri") != expected:
        raise OperationError("Image repository is not bound to the configured account/environment.")
    result = aws("ecr", "describe-images", "--repository-name", config["repository"], "--image-ids", f"imageTag={sha}")
    details = result.get("imageDetails", [])
    if len(details) != 1 or not DIGEST.fullmatch(details[0].get("imageDigest", "")):
        raise OperationError("The requested immutable image artifact is unavailable.")
    if sha not in details[0].get("imageTags", []):
        raise OperationError("Image artifact does not match the requested commit.")
    expected_digest = os.environ.get("AWS_EXPECTED_IMAGE_DIGEST", "")
    if expected_digest and (not DIGEST.fullmatch(expected_digest) or expected_digest != details[0]["imageDigest"]):
        raise OperationError("Requested promotion digest does not match the immutable artifact.")
    return f"{expected}@{details[0]['imageDigest']}"


def compact_template(value: dict[str, Any]) -> str:
    rendered = json.dumps(value, separators=(",", ":"))
    if len(rendered.encode()) > 51_200:
        raise OperationError("Serialized template exceeds the inline CloudFormation limit.")
    return rendered


def apply_stack(
    config: dict[str, str], template: dict[str, Any], parameters: dict[str, str], exists: bool
) -> bool:
    name = config["app_stack"]
    role = required("AWS_CLOUDFORMATION_ROLE_ARN")
    expected_role = f"arn:aws:iam::{config['account']}:role/{config['namespace']}-{config['environment']}-deployment-execution"
    if role != expected_role:
        raise OperationError("CloudFormation role is not bound to this application environment.")
    change_name = f"{name}-{parameters['ImageCommit'][:12]}-{time.time_ns()}"
    with tempfile.TemporaryDirectory(prefix="hostline-change-") as directory:
        body = Path(directory, "template.json")
        values = Path(directory, "parameters.json")
        body.write_text(compact_template(template))
        values.write_text(json.dumps([{"ParameterKey": key, "ParameterValue": value} for key, value in parameters.items()]))
        planned = aws(
            "cloudformation", "create-change-set", "--stack-name", name,
            "--change-set-name", change_name, "--change-set-type", "UPDATE" if exists else "CREATE",
            "--template-body", f"file://{body}", "--parameters", f"file://{values}",
            "--capabilities", "CAPABILITY_NAMED_IAM", "--role-arn", role,
        )
        change_id = planned.get("Id")
        if not isinstance(change_id, str):
            raise OperationError("CloudFormation returned no change-set identity.")
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            state = aws("cloudformation", "describe-change-set", "--change-set-name", change_id)
            if state.get("Status") in {"CREATE_COMPLETE", "FAILED"}:
                break
            time.sleep(5)
        else:
            raise OperationError("Change-set preparation exceeded its deadline.")
        events = aws("cloudformation", "describe-events", "--change-set-name", change_id)
        for event in events.get("OperationEvents", []):
            if event.get("EventType") == "VALIDATION_ERROR":
                raise OperationError("CloudFormation pre-deployment validation failed; inspect the change-set console.")
        if state.get("Status") == "FAILED":
            reason = state.get("StatusReason", "")
            if "didn't contain changes" in reason or "No updates are to be performed" in reason:
                aws("cloudformation", "delete-change-set", "--change-set-name", change_id)
                return False
            raise OperationError("CloudFormation change-set preparation failed; inspect the console.")
        if state.get("Status") != "CREATE_COMPLETE" or state.get("ExecutionStatus") != "AVAILABLE":
            raise OperationError("CloudFormation change set is not executable.")
        aws("cloudformation", "execute-change-set", "--change-set-name", change_id)
        aws("cloudformation", "wait", "stack-update-complete" if exists else "stack-create-complete", "--stack-name", name)
        return True


def console_links(config: dict[str, str], current: dict[str, str] | None = None) -> None:
    origin = f"https://{config['region']}.console.aws.amazon.com"
    print(f"CloudFormation: {origin}/cloudformation/home?region={config['region']}#/stacks")
    print(f"ECS: {origin}/ecs/v2/clusters/{config['namespace']}-{config['environment']}/services?region={config['region']}")
    print(f"CloudWatch: {origin}/cloudwatch/home?region={config['region']}#logsV2:log-groups")
    if current:
        print(f"Application commit: {current.get('ImageCommit', 'not deployed')}")


def exit_safely(work: Any) -> None:
    try:
        work()
    except (OperationError, subprocess.SubprocessError, OSError, ValueError, KeyError) as error:
        message = str(error) if isinstance(error, OperationError) else "Deployment helper failed; inspect bounded console diagnostics."
        print(message)
        raise SystemExit(1) from None
