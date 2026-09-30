"""Publish one full-SHA image, reusing an existing immutable artifact on reruns."""

from __future__ import annotations

import argparse
import subprocess

from common import SHA, OperationError, aws, exit_safely, identity, outputs, stack


def run() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sha", required=True)
    args = parser.parse_args()
    config = identity()
    if not SHA.fullmatch(args.sha):
        raise OperationError("Image publishing requires the full immutable commit SHA.")
    actual = subprocess.run(["git", "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
    if actual != args.sha:
        raise OperationError("Checkout does not match the requested image commit.")
    data_record = stack(config["data_stack"])
    assert data_record is not None
    data = outputs(data_record)
    expected = f"{config['account']}.dkr.ecr.{config['region']}.amazonaws.com/{config['repository']}"
    if data.get("RepositoryUri") != expected:
        raise OperationError("Image repository does not match the configured environment.")
    existing = aws("ecr", "describe-images", "--repository-name", config["repository"], "--image-ids", f"imageTag={args.sha}", allow_failure=True)
    if existing and existing.get("imageDetails"):
        print("Existing immutable commit artifact reused; no retagging or replacement occurred.")
        return
    image = f"{expected}:{args.sha}"
    # Registry authentication is handled by the official GitHub action. No
    # password or token is passed through an argv or application log.
    subprocess.run(["docker", "build", "--platform", "linux/amd64", "--label", f"org.opencontainers.image.revision={args.sha}", "--tag", image, "."], check=True)
    subprocess.run(["docker", "push", image], check=True)


if __name__ == "__main__":
    exit_safely(run)
