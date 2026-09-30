"""Require current main source and successful main-push Checks before AWS access."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from common import OperationError, SHA, exit_safely, required


def checked(runs: list[dict], sha: str, repository: str) -> bool:
    return any(
        run.get("head_sha") == sha
        and run.get("head_branch") == "main"
        and run.get("name") == "Checks"
        and run.get("event") == "push"
        and run.get("conclusion") == "success"
        and run.get("head_repository", {}).get("full_name") == repository
        for run in runs
    )


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], text=True).strip()


def gh(path: str) -> dict:
    return json.loads(subprocess.check_output(["gh", "api", path], text=True))


def run() -> None:
    sha = required("TARGET_SHA")
    workflow_sha = required("WORKFLOW_SHA")
    repository = required("GITHUB_REPOSITORY")
    if repository != "SahilWikhe/IVR_POC" or not SHA.fullmatch(sha):
        raise OperationError("Unexpected repository or incomplete source commit.")
    latest = gh(f"repos/{repository}/git/ref/heads/main")["object"]["sha"]
    if sha != latest and os.environ.get("DEPLOY_EVENT") == "workflow_run":
        print("A newer main revision exists; stale automatic deployment skipped.")
        Path(required("GITHUB_OUTPUT")).write_text("eligible=false\n")
        return
    if sha != workflow_sha or sha != latest or git("rev-parse", "HEAD") != workflow_sha:
        raise OperationError("New deployments require the current main workflow/source commit; use operations for historical artifacts.")
    runs = gh(f"repos/{repository}/actions/workflows/ci.yml/runs?head_sha={sha}&branch=main&status=success&per_page=20")
    if not checked(runs.get("workflow_runs", []), sha, repository):
        raise OperationError("The exact current main revision requires a successful main-push Checks run.")
    Path(required("GITHUB_OUTPUT")).write_text("eligible=true\n")


if __name__ == "__main__":
    exit_safely(run)
