"""Read the current repository's published Warden audit."""

import argparse
import http.client
import json
from pathlib import Path
import subprocess
from urllib.parse import urlencode


def git(directory, *args):
    result = subprocess.run(
        ["git", "-C", directory, "rev-parse", *args],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    return result.stdout.strip() if result.returncode == 0 else None


def common_dir(directory):
    path = git(directory, "--path-format=absolute", "--git-common-dir")
    return Path(path).resolve() if path else None


def get(port, path, **params):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request("GET", f"{path}?{urlencode(params)}")
        response = connection.getresponse()
        if response.status != 200:
            raise ValueError(f"Warden returned HTTP {response.status} for {path}.")
        return json.load(response)
    finally:
        connection.close()


def read_audit(port):
    current_repo = common_dir(".")
    if current_repo is None:
        return {"status": "unavailable", "reason": "Run from a Git checkout."}

    matches = []
    for project in get(port, "/api/projects")["projects"]:
        enrollment = project.get("auditOnly")
        roots = [enrollment["root"]] if enrollment else project["roots"]
        if any(common_dir(root) == current_repo for root in roots):
            matches.append(project)
    if not matches:
        return {"status": "unavailable", "reason": "Warden has no registration for this Git checkout."}
    if len(matches) > 1:
        return {"status": "unavailable", "reason": "Multiple Warden registrations match this checkout.",
                "projects": [project["project"] for project in matches]}

    project = matches[0]
    name = project["project"]
    reports = project.get("mainReports", [])
    latest = project["lastMainAudit"]
    head = latest or (reports[0] if reports else None)
    if head is None:
        return {"status": "unavailable", "project": name, "reason": "Warden has no published audit receipt yet."}
    if common_dir(head["root"]) != current_repo:
        return {"status": "unavailable", "project": name, "reason": "The latest receipt belongs to a different Git checkout."}

    ref = head.get("ref")
    commit = latest.get("commit") if latest else None
    local_tip = git(".", "--verify", f"{ref}^{{commit}}") if ref and ref.startswith("refs/") else None
    runs = []
    for summary in project["mainAuditRuns"] + reports:
        run_id = summary["run"]
        detail = get(port, "/api/runs", project=name, run=run_id, limit=1)
        receipts = detail["runs"]
        if len(receipts) != 1 or receipts[0]["run"] != run_id or "findings" not in detail:
            raise ValueError("The audit receipt changed during lookup. Retry the lookup.")
        fields = ("run", "tier", "base", "scope", "outcome", "result", "at", "kinds", "next")
        run = {field: summary.get(field) for field in fields}
        run.update(findings=detail["findings"])
        if "report" in summary:
            run.update(report=summary["report"], commit=summary["commit"], files=summary["files"],
                       findings=detail["findings"][:10],
                       freshness=freshness(local_tip, summary["commit"]))
        runs.append(run)

    return {"status": "reported", "project": name, "ref": ref, "commit": commit,
            "local_tip": local_tip, "freshness": freshness(local_tip, commit), "runs": runs}


def freshness(local_tip, commit):
    if not local_tip or not commit:
        return "unknown"
    return "current" if local_tip == commit else "stale"


def watch_audit(port):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    try:
        connection.request("GET", "/api/events")
        response = connection.getresponse()
        if response.status != 200:
            raise ValueError(f"Warden returned HTTP {response.status} for /api/events.")

        previous = read_audit(port)
        print(json.dumps(previous), flush=True)
        project = previous.get("project")
        if project is None:
            return
        event = b""
        for line in response:
            if line.startswith(b"event: "):
                event = line.removeprefix(b"event: ").strip()
            elif line.startswith(b"data: ") and event == b"evidence":
                if json.loads(line.removeprefix(b"data: ")).get("project") == project:
                    current = read_audit(port)
                    if current != previous:
                        print(json.dumps(current), flush=True)
                        previous = current
        raise ValueError("The Warden event stream closed.")
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=7419, metavar="PORT")
    parser.add_argument("--watch", action="store_true", help="stream audit updates as JSON lines")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535.")
    try:
        if args.watch:
            watch_audit(args.port)
            return
        result = read_audit(args.port)
    except KeyboardInterrupt:
        return
    except (OSError, http.client.HTTPException, subprocess.TimeoutExpired, KeyError, TypeError, ValueError) as error:
        result = {"status": "unavailable", "reason": f"Could not read the Warden audit. {error}"}
    print(json.dumps(result, indent=None if args.watch else 2))


if __name__ == "__main__":
    main()
