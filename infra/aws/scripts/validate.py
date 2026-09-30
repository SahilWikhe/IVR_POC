"""Account-free infrastructure guards; complementary to cfn-lint, not AWS approval."""

from __future__ import annotations

import json
import re
from pathlib import Path

from common import ROOT, OperationError, compact_template, exit_safely


def require(condition: bool, message: str) -> None:
    if not condition:
        raise OperationError(message)


def statements(role: dict) -> list[dict]:
    return [s for policy in role["Properties"].get("Policies", []) for s in policy["PolicyDocument"]["Statement"]]


def actions(statement: dict) -> list[str]:
    value = statement.get("Action", [])
    return [value] if isinstance(value, str) else value


def recovery_keys(value):
    if isinstance(value, dict):
        if "dynamodb:LeadingKeys" in value:
            yield value["dynamodb:LeadingKeys"]
        for child in value.values():
            yield from recovery_keys(child)
    elif isinstance(value, list):
        for child in value:
            yield from recovery_keys(child)


def validate(templates: dict[str, dict]) -> None:
    for name, template in templates.items():
        require(template.get("AWSTemplateFormatVersion") == "2010-09-09", f"Missing template version: {name}")
        compact_template(template)
    data, app, bootstrap = (templates[n] for n in ["data", "application", "bootstrap"])
    keys = list(recovery_keys(app)) + list(recovery_keys(bootstrap))
    require(len(keys) == 3 and all(value == [{"Fn::Sub": "INSTALLATION#${RecoveryInstallationId}"}] for value in keys), "Runtime recovery IAM keys must match the SDK installation partition prefix.")
    persistent = {"Database", "RecoveryTable", "DataKey", "ImageRepository", "AuditBucket", "AuditTrail", "PrivateAppZone"}
    for name in persistent:
        resource = data["Resources"][name]
        require(resource.get("DeletionPolicy") == "Retain" and resource.get("UpdateReplacePolicy") == "Retain", f"Persistent resource lacks retention: {name}")
    db = data["Resources"]["Database"]["Properties"]
    require(db.get("StorageEncrypted") is True and db.get("PubliclyAccessible") is False and db.get("DeletionProtection") is True and db.get("BackupRetentionPeriod", 0) >= 14, "Database protection was weakened.")
    table = data["Resources"]["RecoveryTable"]["Properties"]
    require(table.get("DeletionProtectionEnabled") is True and table["PointInTimeRecoverySpecification"].get("PointInTimeRecoveryEnabled") is True and table["SSESpecification"].get("SSEEnabled") is True, "Recovery authority protection was weakened.")
    require(data["Resources"]["ImageRepository"]["Properties"].get("ImageTagMutability") == "IMMUTABLE", "Images must remain immutable.")
    require(data["Resources"]["AuditTrail"].get("DependsOn") == "AuditBucketPolicy", "Audit trail must wait for its write policy.")
    for name in ["NatAddress1", "NatAddress2", "Nat1", "Nat2"]:
        require(data["Resources"][name].get("DependsOn") == "InternetAttachment", "NAT resources must wait for the internet attachment.")
    forbidden = {"AWS::RDS::DBInstance", "AWS::DynamoDB::Table", "AWS::KMS::Key", "AWS::ECR::Repository", "AWS::S3::Bucket", "AWS::Route53::HostedZone"}
    for name, resource in app["Resources"].items():
        require(resource["Type"] not in forbidden and not resource["Type"].startswith("AWS::EC2::"), f"Persistent/network allocation leaked into application cleanup: {name}")
        if resource["Type"] == "AWS::IAM::Role":
            require(resource["Properties"].get("PermissionsBoundary") == {"Ref": "RuntimeBoundaryArn"}, f"Missing task-role boundary: {name}")
        if resource["Type"] == "AWS::ECS::TaskDefinition":
            container = resource["Properties"]["ContainerDefinitions"][0]
            require(container.get("ReadonlyRootFilesystem") is True and container.get("User") == "10001", f"Unsafe container privilege: {name}")
            require(container.get("Image") == {"Ref": "ImageUri"}, f"Unpinned image: {name}")
        if resource["Type"] == "AWS::ECS::Service":
            require(resource["Properties"]["NetworkConfiguration"]["AwsvpcConfiguration"]["AssignPublicIp"] == "DISABLED", f"Public task IP: {name}")
            require(resource["Properties"].get("EnableExecuteCommand") is False, "Interactive ECS execution must remain disabled.")
    for flag in ["LiveVoiceEnabled", "VoiceActionsEnabled", "VoiceTransfersEnabled", "StatusReaderEnabled"]:
        require(app["Parameters"][flag].get("Default") == "false", f"Capability defaults on: {flag}")
    private_rule = next((r for r in app["Resources"]["WafAcl"]["Properties"]["Rules"] if r["Name"] == "BlockDecodedPrivatePaths"), None)
    require(private_rule is not None, "Public WAF must block decoded private routes.")
    match = private_rule["Statement"]["ByteMatchStatement"]
    require(private_rule["Priority"] == 0 and private_rule["Action"] == {"Block": {}} and match["FieldToMatch"] == {"UriPath": {}} and match["SearchString"] == "/internal" and match["PositionalConstraint"] == "STARTS_WITH" and match["TextTransformations"] == [{"Priority": 0, "Type": "URL_DECODE"}, {"Priority": 1, "Type": "NORMALIZE_PATH"}, {"Priority": 2, "Type": "LOWERCASE"}], "Private-path WAF decoding/normalization boundary was weakened.")
    require(app["Resources"]["ApiPublicTargets"]["Properties"]["HealthCheckPath"] == "/api/ready", "API target health must check readiness.")
    require(app["Resources"]["ApiInternalTargets"]["Properties"]["HealthCheckPath"] == "/api/ready", "Private API target health must check readiness.")
    for name in ["ApiRuntimeRole", "WorkerRuntimeRole"]:
        granted = [action for statement in statements(app["Resources"][name]) for action in actions(statement) if action.startswith("dynamodb:")]
        require(granted == ["dynamodb:GetItem"], "Runtime cannot modify the independent recovery authority.")
    for statement in statements(bootstrap["Resources"]["GitHubDeploymentRole"]):
        require(not any(action in {"secretsmanager:GetSecretValue", "kms:Decrypt", "rds:DeleteDBInstance", "dynamodb:DeleteTable"} or action == "*" for action in actions(statement)), "GitHub must not read secrets or delete retained data.")
    for statement in statements(bootstrap["Resources"]["CloudFormationExecutionRole"]):
        for action in actions(statement):
            require(not action.startswith("ec2:") or action.startswith("ec2:Describe"), "Application CloudFormation cannot mutate retained network resources.")
        if "route53:ChangeResourceRecordSets" in actions(statement):
            require(bool(statement.get("Condition", {}).get("ForAllValues:StringEquals", {}).get("route53:ChangeResourceRecordSetsNormalizedRecordNames")), "DNS writes need exact hostname restrictions.")


def validate_workflows(directory: Path) -> None:
    # JSON templates need no parser dependency. Workflow syntax is separately
    # parsed in tests/cfn-lint's isolated tool environment with PyYAML.
    for name in ["aws-deploy.yml", "aws-operations.yml"]:
        text = (directory / name).read_text()
        require(all(re.fullmatch(r"[a-f0-9]{40}", revision) for revision in re.findall(r"uses: [^@\s]+@([^\s]+)", text)), f"Action dependencies must use reviewed full commits: {name}")
        require("persist-credentials: false" in text and "id-token: write" in text, "Use short-lived OIDC access without persisted checkout credentials.")
    deploy = (directory / "aws-deploy.yml").read_text()
    require("vars.AWS_STAGING_READY == 'true'" in deploy and "conclusion == 'success'" in deploy, "Automatic staging must remain readiness and Checks gated.")
    require("python infra/aws/scripts/source.py" in deploy and "ref: ${{ env.TARGET_SHA }}" not in deploy, "Do not replace reviewed deployment controls with historical source.")
    require("actions: read" in deploy, "Exact Checks verification requires Actions read permission.")


def run() -> None:
    templates = {p.stem: json.loads(p.read_text()) for p in (ROOT / "templates").glob("*.json")}
    validate(templates)
    validate_workflows(ROOT.parent.parent / ".github/workflows")
    print("Infrastructure retention, isolation, readiness, and workflow guards passed (no AWS calls).")


if __name__ == "__main__":
    exit_safely(run)
