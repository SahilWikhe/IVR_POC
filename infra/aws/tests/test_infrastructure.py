"""Infrastructure boundary tests, with provider access forbidden by mocks."""

import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import common
import deploy
import source
import validate


class InfrastructureGuards(unittest.TestCase):
    def setUp(self):
        self.templates = {p.stem: json.loads(p.read_text()) for p in (ROOT / "templates").glob("*.json")}

    def reject(self):
        with self.assertRaises(common.OperationError):
            validate.validate(self.templates)

    def test_reviewed_templates_pass(self):
        validate.validate(self.templates)

    def test_cleanup_cannot_allocate_or_delete_data(self):
        self.templates["application"]["Resources"]["UnsafeDb"] = {"Type": "AWS::RDS::DBInstance"}
        self.reject()

    def test_snapshot_replacement_cannot_drop_authority(self):
        del self.templates["data"]["Resources"]["RecoveryTable"]["UpdateReplacePolicy"]
        self.reject()

    def test_runtime_cannot_write_recovery_authority(self):
        role = self.templates["application"]["Resources"]["ApiRuntimeRole"]
        role["Properties"]["Policies"][0]["PolicyDocument"]["Statement"][0]["Action"] = "dynamodb:PutItem"
        self.reject()

    def test_recovery_partition_prefix_matches_runtime(self):
        statement = next(statement for statement in validate.statements(self.templates["application"]["Resources"]["ApiRuntimeRole"]) if "dynamodb:GetItem" in validate.actions(statement))
        statement["Condition"]["ForAllValues:StringEquals"]["dynamodb:LeadingKeys"] = [{"Ref": "RecoveryInstallationId"}]
        self.reject()

    def test_ci_cannot_mutate_retained_security_groups(self):
        role = self.templates["bootstrap"]["Resources"]["CloudFormationExecutionRole"]
        role["Properties"]["Policies"][0]["PolicyDocument"]["Statement"].append({"Action": "ec2:AuthorizeSecurityGroupIngress", "Resource": "*"})
        self.reject()

    def test_liveness_cannot_substitute_for_readiness(self):
        self.templates["application"]["Resources"]["ApiPublicTargets"]["Properties"]["HealthCheckPath"] = "/api/health"
        self.reject()

    def test_encoded_private_path_requires_waf_decoding(self):
        rule = self.templates["application"]["Resources"]["WafAcl"]["Properties"]["Rules"][0]
        rule["Statement"]["ByteMatchStatement"]["TextTransformations"][0]["Type"] = "NONE"
        self.reject()

    def test_live_voice_cannot_be_enabled_by_default(self):
        self.templates["application"]["Parameters"]["LiveVoiceEnabled"]["Default"] = "true"
        self.reject()

    def test_task_role_requires_permissions_boundary(self):
        del self.templates["application"]["Resources"]["VoiceRuntimeRole"]["Properties"]["PermissionsBoundary"]
        self.reject()

    def test_compact_submission_is_bounded(self):
        with self.assertRaises(common.OperationError):
            common.compact_template({"too_large": "x" * 51200})

    def test_workflow_yaml_and_action_pins(self):
        import yaml
        directory = ROOT.parents[1] / ".github/workflows"
        validate.validate_workflows(directory)
        for name in ["aws-deploy.yml", "aws-operations.yml"]:
            value = yaml.load((directory / name).read_text(), Loader=yaml.BaseLoader)
            self.assertIn("on", value)
            self.assertEqual(value["permissions"]["contents"], "read")


class ArtifactAndSource(unittest.TestCase):
    def setUp(self):
        self.sha = "a" * 40
        self.digest = "sha256:" + "b" * 64
        self.config = {"account": "123456789012", "region": "us-east-1", "repository": "hostline-staging", "environment": "staging"}
        self.uri = "123456789012.dkr.ecr.us-east-1.amazonaws.com/hostline-staging"
        self.response = {"imageDetails": [{"imageDigest": self.digest, "imageTags": [self.sha]}]}

    def test_image_resolves_full_sha_to_digest(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(common, "aws", return_value=self.response):
            self.assertEqual(common.image(self.sha, self.config, {"RepositoryUri": self.uri}), self.uri + "@" + self.digest)

    def test_wrong_promotion_digest_rejected(self):
        with patch.dict(os.environ, {"AWS_EXPECTED_IMAGE_DIGEST": "sha256:" + "c" * 64}), patch.object(common, "aws", return_value=self.response):
            with self.assertRaises(common.OperationError):
                common.image(self.sha, self.config, {"RepositoryUri": self.uri})

    def test_unbound_repository_rejected_before_provider_access(self):
        with patch.object(common, "aws") as sdk:
            with self.assertRaises(common.OperationError):
                common.image(self.sha, self.config, {"RepositoryUri": self.uri + "-other"})
            sdk.assert_not_called()

    def test_main_push_checks_evidence(self):
        run = {"head_sha": self.sha, "head_branch": "main", "name": "Checks", "event": "push", "conclusion": "success", "head_repository": {"full_name": "SahilWikhe/IVR_POC"}}
        self.assertTrue(source.checked([run], self.sha, "SahilWikhe/IVR_POC"))
        for changed in [{"event": "pull_request"}, {"head_sha": "c" * 40}, {"head_branch": "feature"}, {"conclusion": "failure"}, {"head_repository": {"full_name": "fork/IVR_POC"}}]:
            self.assertFalse(source.checked([{**run, **changed}], self.sha, "SahilWikhe/IVR_POC"))

    def test_production_gate_precedes_aws_calls(self):
        with patch.object(sys, "argv", ["deploy.py", "--sha", self.sha]), patch.object(deploy, "identity", return_value={"environment": "production"}), patch.object(deploy, "stack") as sdk:
            with self.assertRaises(common.OperationError):
                deploy.run()
            sdk.assert_not_called()

    def test_readiness_redirect_is_rejected(self):
        with self.assertRaises(common.OperationError):
            deploy.NoRedirect().redirect_request(None, None, 302, "", {}, "https://elsewhere.invalid")


if __name__ == "__main__":
    unittest.main()
