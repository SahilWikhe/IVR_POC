"""Explicit operator actions, scoped to one replaceable application environment."""

from __future__ import annotations

import argparse
import json
import time

from common import OperationError, aws, console_links, exit_safely, identity, outputs, required, stack


def run() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["status", "logs", "cleanup"])
    parser.add_argument("--confirm-stack", default="")
    args = parser.parse_args()
    config = identity()
    current_record = stack(config["app_stack"])
    assert current_record is not None
    current = outputs(current_record)
    console_links(config, current)
    if args.action == "cleanup":
        if args.confirm_stack != config["app_stack"]:
            raise OperationError("Cleanup requires the exact application stack name as confirmation.")
        # No data-stack delete API or permission exists in this workflow role.
        aws("cloudformation", "delete-stack", "--stack-name", config["app_stack"], "--role-arn", required("AWS_CLOUDFORMATION_ROLE_ARN"))
        aws("cloudformation", "wait", "stack-delete-complete", "--stack-name", config["app_stack"])
        print("Application cleanup completed. Retained data, network, recovery table, image repository, and log groups remain.")
        return
    if args.action == "status":
        result = aws("ecs", "describe-services", "--cluster", current["ClusterName"], "--services", *[current[f"{name}Service"] for name in ["Api", "Voice", "Worker"]])
        for service in result.get("services", []):
            print(json.dumps({key: service.get(key) for key in ["serviceName", "desiredCount", "runningCount", "pendingCount", "status"]}))
        # Service event bodies/stopped reasons can contain configuration. View
        # them in the protected AWS console rather than echoing them into CI.
        if result.get("failures"):
            raise OperationError("One or more expected application services were unavailable.")
        return
    end = int(time.time())
    for name in ["Api", "Voice", "Worker", "Migration"]:
        query = aws("logs", "start-query", "--log-group-name", current[f"{name}LogGroup"], "--start-time", str(end - 900), "--end-time", str(end), "--query-string", "filter ispresent(event) | stats count(*) as eventCount by event, code | sort eventCount desc | limit 20")
        query_id = query.get("queryId")
        if not isinstance(query_id, str):
            raise OperationError("CloudWatch returned no bounded query identity.")
        try:
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                result = aws("logs", "get-query-results", "--query-id", query_id)
                if result.get("status") == "Complete":
                    print(f"{name}: safe event/code counts over the last 15 minutes.")
                    for row in result.get("results", [])[:20]:
                        safe = {item["field"]: item["value"] for item in row if item.get("field") in {"event", "code", "eventCount"}}
                        # Event/code values are bounded operational identifiers;
                        # omit anomalous caller-like fields instead of leaking.
                        if all(len(value) <= 120 and all(c.isalnum() or c in "_.-" for c in value) for value in safe.values()):
                            print(json.dumps(safe))
                    break
                if result.get("status") in {"Failed", "Cancelled", "Timeout", "Unknown"}:
                    raise OperationError("CloudWatch query did not complete safely.")
                time.sleep(2)
            else:
                raise OperationError("CloudWatch query exceeded its bounded deadline.")
        finally:
            aws("logs", "stop-query", "--query-id", query_id, allow_failure=True)


if __name__ == "__main__":
    exit_safely(run)
