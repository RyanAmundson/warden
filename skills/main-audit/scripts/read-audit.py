"""Read published Warden findings for the files in your change."""

import argparse
import http.client
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import urlencode


def git(directory, *args):
    result = subprocess.run(
        ["git", "--no-optional-locks", "-C", directory, *args],
        capture_output=True,
        timeout=5,
        check=False,
    )
    return result.stdout if result.returncode == 0 else None


def revision(directory, *args):
    value = git(directory, "rev-parse", *args)
    return os.fsdecode(value.rstrip(b"\n")) if value else None


def common_dir(directory):
    path = revision(directory, "--path-format=absolute", "--git-common-dir")
    return Path(path).resolve() if path else None


def changed_paths(root, ref):
    base = git(root, "merge-base", ref, "HEAD")
    if not base:
        raise ValueError(f"Git has no merge base with {ref}. Pass --path for the task's files.")
    changed = git(root, "diff", "--name-only", "--no-renames", "--diff-filter=d", "-z", base.strip().decode(), "--")
    untracked = git(root, "ls-files", "--others", "--exclude-standard", "-z")
    if changed is None or untracked is None:
        raise ValueError("Git could not identify the changed files. Pass --path for the task's files.")
    return {os.fsdecode(path) for path in (changed + untracked).split(b"\0") if path}


def task_paths(root, paths):
    selected = set()
    root = Path(root).resolve()
    for path in paths:
        candidate = Path(os.path.abspath(root / path))
        if not candidate.is_relative_to(root) or not candidate.resolve().is_relative_to(root) or candidate.is_dir():
            raise ValueError(f"--path expects a file inside the Git checkout: {path}")
        selected.add(candidate.relative_to(root).as_posix())
    return selected


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


def read_audit(port, paths):
    root = revision(".", "--show-toplevel")
    current_repo = common_dir(".")
    if root is None or current_repo is None:
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

    ref = head.get("ref") or (project.get("auditOnly") or {}).get("ref") or "refs/remotes/origin/main"
    selected = task_paths(root, paths) if paths else changed_paths(root, ref)
    scope = {"mode": "task-files" if paths else "changed-files", "files": len(selected)}
    if not selected:
        return {"status": "no_scope", "project": name, "ref": ref, "scope": scope,
                "reason": "Git found no changed files. Pass --path to inspect a specific task file."}

    local_tip = revision(".", "--verify", "--end-of-options", f"{ref}^{{commit}}")
    findings = []
    details_incomplete = False
    for summary in project["mainAuditRuns"] + reports:
        run_id = summary["run"]
        detail = get(port, "/api/runs", project=name, run=run_id, limit=1)
        receipts = detail["runs"]
        if len(receipts) != 1 or receipts[0]["run"] != run_id or "findings" not in detail:
            raise ValueError("The audit receipt changed during lookup. Retry the lookup.")

        recorded = detail["findings"]
        details_incomplete |= summary.get("outcome") != "ran" or sum((summary.get("kinds") or {}).values()) > len(recorded)
        commit = summary.get("commit")
        source = {"commit": commit, "freshness": freshness(local_tip, commit)}
        if summary.get("report"):
            source["checker"] = summary["report"]["adapter"]
        else:
            source["tier"] = summary.get("tier")
        findings.extend({**finding, "source": source} for finding in recorded if finding.get("file") in selected)

    findings.sort(key=lambda finding: finding["source"]["freshness"] != "current")
    return {"status": "reported", "project": name, "ref": ref, "scope": scope,
            "findings": findings[:10], "more_matching_findings": max(0, len(findings) - 10),
            "source_details_incomplete": details_incomplete}


def freshness(local_tip, commit):
    if not local_tip or not commit:
        return "unknown"
    return "current" if local_tip == commit else "stale"


def watch_audit(port, paths):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    try:
        connection.request("GET", "/api/events")
        response = connection.getresponse()
        if response.status != 200:
            raise ValueError(f"Warden returned HTTP {response.status} for /api/events.")

        previous = read_audit(port, paths)
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
                    current = read_audit(port, paths)
                    if current != previous:
                        print(json.dumps(current), flush=True)
                        previous = current
        raise ValueError("The Warden event stream closed.")
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=7419, metavar="PORT")
    parser.add_argument("--path", action="append", default=[], help="scope to a repository-relative task file (repeatable)")
    parser.add_argument("--watch", action="store_true", help="stream audit updates as JSON lines")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535.")
    try:
        if args.watch:
            watch_audit(args.port, args.path)
            return
        result = read_audit(args.port, args.path)
    except KeyboardInterrupt:
        return
    except (OSError, http.client.HTTPException, subprocess.TimeoutExpired, KeyError, TypeError, ValueError) as error:
        result = {"status": "unavailable", "reason": f"Could not read the Warden audit. {error}"}
    print(json.dumps(result, indent=None if args.watch else 2))


if __name__ == "__main__":
    main()
