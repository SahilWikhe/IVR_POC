"""Deploy a verified immutable image to only the replaceable application stack."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import tempfile
import time
import urllib.request

from common import ROOT, OperationError, apply_stack, aws, console_links, exit_safely, identity, image, outputs, required, stack


def parameters(config: dict[str, str], data: dict[str, str], uri: str, sha: str) -> dict[str, str]:
    app_host = required("AWS_APP_DOMAIN")
    voice_host = required("AWS_VOICE_DOMAIN")
    if app_host != data.get("AppDomain"):
        raise OperationError("App domain differs from the retained private DNS setting.")
    if app_host == voice_host or voice_host.endswith(f".{app_host}"):
        raise OperationError("Use distinct sibling app/voice domains; the private app DNS zone must not shadow voice.")
    result = {
        "Namespace": config["namespace"], "Environment": config["environment"],
        "VpcId": data["Vpc"],
        "PrivateAppZoneId": data["PrivateAppZoneId"],
        "PublicAlbSecurityGroupId": data["PublicAlbSecurityGroup"],
        "InternalAlbSecurityGroupId": data["InternalAlbSecurityGroup"],
        "PublicSubnetIds": f"{data['PublicSubnet1']},{data['PublicSubnet2']}",
        "PrivateSubnetIds": f"{data['PrivateSubnet1']},{data['PrivateSubnet2']}",
        "ImageUri": uri, "ImageCommit": sha, "RepositoryArn": data["RepositoryArn"],
        "DataKeyArn": data["DataKeyArn"], "RuntimeBoundaryArn": required("AWS_RUNTIME_BOUNDARY_ARN"),
        "RecoveryTableArn": data["RecoveryTableArn"], "RecoveryTableName": data["RecoveryTableName"],
        "RecoveryInstallationId": required("AWS_RECOVERY_INSTALLATION_ID"),
        "RecoveryEpoch": required("AWS_RECOVERY_EPOCH"),
        "RecoveryDatabaseResourceId": data["DatabaseResourceId"],
        "RecoveryDatabaseInstanceId": data["DatabaseInstanceId"],
        "DatabaseArn": data["DatabaseArn"],
        "TrustedProxyCidrs": f"{data['PublicAlbSubnetCidrs']},{data['InternalAlbSubnetCidrs']}",
        "CertificateArn": required("AWS_CERTIFICATE_ARN"),
        "AppDomain": app_host, "VoiceDomain": voice_host,
        "PublicHostedZoneId": os.environ.get("AWS_PUBLIC_HOSTED_ZONE_ID", ""),
        "OidcIssuer": required("AWS_OIDC_ISSUER"), "OidcClientId": required("AWS_OIDC_CLIENT_ID"),
        "VoiceTenantId": required("AWS_VOICE_TENANT_ID"),
        "TwilioAccountSid": os.environ.get("AWS_TWILIO_ACCOUNT_SID", ""),
        "TwilioPhoneNumber": os.environ.get("AWS_TWILIO_PHONE_NUMBER", ""),
        "DesiredCount": "1", "EnableWaf": "true",
    }
    for name in ["Api", "Voice", "Worker", "Migration"]:
        if name != "Migration":
            result[f"{name}SecurityGroupId"] = data[f"{name}SecurityGroup"]
        result[f"{name}SecretArn"] = required(f"AWS_{name.upper()}_SECRET_ARN")
    for name, variable in [
        ("LiveVoiceEnabled", "AWS_LIVE_VOICE_ENABLED"),
        ("VoiceActionsEnabled", "AWS_VOICE_ACTIONS_ENABLED"),
        ("VoiceTransfersEnabled", "AWS_VOICE_TRANSFERS_ENABLED"),
        ("StatusReaderEnabled", "AWS_STATUS_READER_ENABLED"),
    ]:
        value = os.environ.get(variable) or "false"
        if value not in {"true", "false"}:
            raise OperationError(f"Invalid exact capability flag: {variable}")
        result[name] = value
    return result


def migrate(config: dict[str, str], current: dict[str, str], data: dict[str, str], uri: str) -> None:
    original = aws("ecs", "describe-task-definition", "--task-definition", current["MigrationTaskDefinition"])["taskDefinition"]
    allowed = {"family", "taskRoleArn", "executionRoleArn", "networkMode", "containerDefinitions", "volumes", "placementConstraints", "requiresCompatibilities", "cpu", "memory", "runtimePlatform", "ephemeralStorage"}
    definition = {key: value for key, value in original.items() if key in allowed}
    definition["family"] = f"{config['namespace']}-{config['environment']}-deploy-migration"
    containers = definition["containerDefinitions"]
    if len(containers) != 1 or containers[0]["name"] != "migration":
        raise OperationError("Migration task definition has an unexpected container layout.")
    containers[0]["image"] = uri
    containers[0]["command"] = ["node", "apps/migrate/dist/index.js"]
    with tempfile.TemporaryDirectory(prefix="hostline-migration-") as directory:
        body = Path(directory, "task.json")
        body.write_text(json.dumps(definition))
        created = aws("ecs", "register-task-definition", "--cli-input-json", f"file://{body}")
    task_definition = created["taskDefinition"]["taskDefinitionArn"]
    try:
        network = {"awsvpcConfiguration": {"subnets": [data["PrivateSubnet1"], data["PrivateSubnet2"]], "securityGroups": [data["MigrationSecurityGroup"]], "assignPublicIp": "DISABLED"}}
        launched = aws("ecs", "run-task", "--cluster", current["ClusterName"], "--launch-type", "FARGATE", "--platform-version", "1.4.0", "--task-definition", task_definition, "--network-configuration", json.dumps(network), "--count", "1")
        if launched.get("failures") or len(launched.get("tasks", [])) != 1:
            raise OperationError("Migration task could not be admitted.")
        task_arn = launched["tasks"][0]["taskArn"]
        aws("ecs", "wait", "tasks-stopped", "--cluster", current["ClusterName"], "--tasks", task_arn)
        final = aws("ecs", "describe-tasks", "--cluster", current["ClusterName"], "--tasks", task_arn)
        tasks = final.get("tasks", [])
        if final.get("failures") or len(tasks) != 1 or tasks[0].get("lastStatus") != "STOPPED":
            raise OperationError("Migration task outcome is unavailable.")
        finished = tasks[0].get("containers", [])
        if len(finished) != 1 or finished[0].get("exitCode") != 0:
            raise OperationError("Migration failed; services were not advanced to the new image.")
    finally:
        aws("ecs", "deregister-task-definition", "--task-definition", task_definition, allow_failure=True)


def health(current: dict[str, str]) -> None:
    services = [current[f"{name}Service"] for name in ["Api", "Voice", "Worker"]]
    aws("ecs", "wait", "services-stable", "--cluster", current["ClusterName"], "--services", *services)
    state = aws("ecs", "describe-services", "--cluster", current["ClusterName"], "--services", *services)
    found = state.get("services", [])
    if state.get("failures") or len(found) != 3 or any(s.get("desiredCount") != 1 or s.get("runningCount") != 1 for s in found):
        raise OperationError("ECS services did not establish the expected running count.")
    opener = urllib.request.build_opener(NoRedirect())
    for url, expected in [(current["AppUrl"] + "/api/ready", "ready"), (current["VoiceUrl"] + "/health", "ok")]:
        try:
            with opener.open(url, timeout=10) as response:
                payload = response.read(8193)
                if response.status != 200 or len(payload) > 8192:
                    raise OperationError("HTTPS health check failed.")
                if json.loads(payload).get("status") != expected:
                    raise OperationError("HTTPS readiness did not return the expected status.")
        except (OSError, ValueError) as error:
            raise OperationError("HTTPS health check failed; inspect service/target health.") from error


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, new_url):
        raise OperationError("Health endpoint unexpectedly redirected.")


def run() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sha", required=True)
    parser.add_argument("--redeploy", action="store_true", help="Existing artifact only; no schema migration rollback.")
    args = parser.parse_args()
    config = identity()
    if config["environment"] == "production":
        raise OperationError("Production deployment remains blocked by application readiness requirements.")
    data_record = stack(config["data_stack"])
    assert data_record is not None
    data = outputs(data_record)
    uri = image(args.sha, config, data)
    template = json.loads((ROOT / "templates/application.json").read_text())
    params = parameters(config, data, uri, args.sha)
    previous = stack(config["app_stack"], missing_ok=True)
    previous_template = None
    if previous:
        previous_template = aws("cloudformation", "get-template", "--stack-name", config["app_stack"])["TemplateBody"]
        if isinstance(previous_template, str):
            previous_template = json.loads(previous_template)
        if previous.get("StackStatus") not in {"CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"}:
            raise OperationError("Application stack is not in a stable deployable state.")
    if args.redeploy and not previous:
        raise OperationError("Redeployment requires an existing application stack.")
    if not previous:
        apply_stack(config, template, {**params, "DesiredCount": "0"}, False)
    current_record = stack(config["app_stack"])
    assert current_record is not None
    current = outputs(current_record)
    if not args.redeploy:
        migrate(config, current, data, uri)
    try:
        changed = apply_stack(config, template, params, True)
        current_record = stack(config["app_stack"])
        assert current_record is not None
        current = outputs(current_record)
        if args.redeploy and not changed:
            for name in ["Api", "Voice", "Worker"]:
                aws("ecs", "update-service", "--cluster", current["ClusterName"], "--service", current[f"{name}Service"], "--force-new-deployment")
        if current.get("ImageUri") != uri or current.get("ImageCommit") != args.sha:
            raise OperationError("Deployed stack does not match the exact requested artifact.")
        health(current)
    except (OperationError, OSError, ValueError):
        # ECS's circuit breaker/CloudFormation rollback handles failed updates.
        # After successful stack completion but failed external health, restore
        # the prior app template/parameters; never roll back PostgreSQL data.
        observed = stack(config["app_stack"], missing_ok=True)
        if observed and observed.get("StackStatus") in {"CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"}:
            if previous and previous_template:
                old_params = {entry["ParameterKey"]: entry["ParameterValue"] for entry in previous.get("Parameters", [])}
                apply_stack(config, previous_template, old_params, True)
                restored = stack(config["app_stack"])
                assert restored is not None
                try:
                    health(outputs(restored))
                except (OperationError, OSError, ValueError) as error:
                    raise OperationError("Previous image could not establish readiness against retained schema/recovery state; operator intervention is required.") from error
                print("Previous application established readiness; database migrations were preserved.")
            else:
                apply_stack(config, template, {**params, "DesiredCount": "0"}, True)
                print("Initial application activation failed; services remain stopped and data is retained.")
        raise
    console_links(config, current)


if __name__ == "__main__":
    exit_safely(run)
