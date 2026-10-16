"""Repair legacy Codex Edit activities from local logs without executing log code.

Dry run by default. --apply requires --backup-dir and saves a database snapshot
and the original affected rows before changing only activity.detail.
"""

import argparse
import json
import os
from pathlib import Path
import re
import sqlite3
from datetime import datetime, timezone


BROKEN = re.compile(r"\[object Object\](?:,\[object Object\])*")
STRING = r'"(?:\\.|[^"\\])*"'
HEADERS = re.compile(r"^\*\*\* (Update|Add|Delete) File: (.+)$", re.M)


def timestamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def decode_literal(literal):
    """Decode a double-quoted JavaScript string, including identity escapes."""
    try:
        return json.loads(literal)
    except json.JSONDecodeError:
        # JavaScript accepts identity escapes such as \( and \_ that JSON rejects.
        # Normalize those only; JSON still validates all other string syntax.
        normalized = re.sub(
            r'\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}|([^"\\/bfnrtu]))',
            lambda match: match[1] if match[1] else match[0],
            literal,
        )
        return json.loads(normalized)


def extract_patches(event):
    """Read literal patches or static file headers in dynamic templates."""
    if event.get("type") != "response_item":
        return []
    payload = event.get("payload", {})
    if payload.get("type") not in ("custom_tool_call", "function_call"):
        return []
    source = payload.get("input", payload.get("arguments", ""))
    if not isinstance(source, str):
        return []
    literals = []
    templates = []
    if payload.get("name") == "apply_patch":
        if source.startswith("*** Begin Patch"):
            literals.append(source)
        else:
            try:
                data = json.loads(source)
                literals.append(data if isinstance(data, str) else data.get("patch", data.get("input", "")))
            except (ValueError, AttributeError):
                pass
    elif payload.get("name") == "exec":
        for match in re.finditer(r"tools\.apply_patch\(\s*(" + STRING + r")\s*\)", source):
            try:
                literals.append(decode_literal(match[1]))
            except ValueError:
                pass
        for match in re.finditer(r"(?:const|let|var)\s+(\w+)\s*=\s*(" + STRING + r")\s*;", source):
            if re.search(r"tools\.apply_patch\(\s*" + re.escape(match[1]) + r"\s*\)", source):
                try:
                    literals.append(decode_literal(match[2]))
                except ValueError:
                    pass
        for match in re.finditer(r"(?:const|let|var)\s+(\w+)\s*=\s*`((?:\\.|[^`\\])*)`\s*;", source):
            if re.search(r"tools\.apply_patch\(\s*" + re.escape(match[1]) + r"\s*\)", source):
                # Only static header text is recoverable. Never evaluate ${...}.
                template = match[2].replace("\\n", "\n")
                templates.append(template)
    result = []
    for patch, full in [(p, True) for p in literals] + [(p, False) for p in templates]:
        if not isinstance(patch, str) or not patch.startswith("*** Begin Patch\n") or not patch.rstrip().endswith("*** End Patch"):
            continue
        headers = HEADERS.findall(patch)
        if not headers or any("${" in path for _, path in headers):
            continue
        changes = list({path: {"path": path, "kind": {"Update": "update", "Add": "add", "Delete": "delete"}[kind]} for kind, path in headers}.values())
        detail = patch if full else json.dumps({
            "changes": changes,
            "recovery": "原始日志仅保留动态补丁模板，无法恢复逐行差异。",
        }, ensure_ascii=False)
        result.append({"timestamp": timestamp(event["timestamp"]), "count": len(changes), "detail": detail, "full": full, "call_id": payload.get("call_id")})
    return result


def choose_patch(row, candidates):
    count = json.loads(row["content"])["detail"].count("[object Object]")
    when = timestamp(row["created_at"])
    # Match the actual tool execution interval, including slow disk writes.
    # Reject later calls, incomplete logs and overlapping ambiguous executions.
    matches = [p for p in candidates if p["count"] == count and p["timestamp"] <= when <= p.get("completed_at", p["timestamp"]) + 1]
    return matches[0] if len(matches) == 1 else None


def scan(connection, log_root):
    rows = []
    for row in connection.execute("SELECT m.id,m.session_id,m.content,m.created_at,s.codex_thread_id FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.role='activity' AND s.backend='codex' ORDER BY m.rowid"):
        try:
            activity = json.loads(row["content"])
        except ValueError:
            continue
        if activity.get("kind") == "tool" and activity.get("toolName") == "Edit" and BROKEN.fullmatch(activity.get("detail", "")):
            rows.append(dict(row))
    users = [dict(row) for row in connection.execute("SELECT m.session_id,m.content,m.created_at FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.role='user' AND s.backend='codex'")]
    for user in users:
        user["timestamp"] = timestamp(user["created_at"])
    candidates = {}
    for path in sorted(Path(log_root).rglob("*.jsonl")):
        sessions = {r["session_id"] for r in rows if r["codex_thread_id"] and r["codex_thread_id"] in path.name}
        patches = []
        completions = {}
        with path.open() as source:
            for line in source:
                try:
                    event = json.loads(line)
                except ValueError:
                    continue  # A running log may end with an incomplete line.
                payload = event.get("payload", {})
                if event.get("type") == "response_item" and payload.get("type") in ("custom_tool_call_output", "function_call_output") and payload.get("call_id"):
                    completions[payload["call_id"]] = timestamp(event["timestamp"])
                if event.get("type") == "response_item" and payload.get("role") == "user":
                    text = "\n".join(part.get("text", "") for part in payload.get("content", []) if isinstance(part, dict))
                    when = timestamp(event["timestamp"])
                    matches = {u["session_id"] for u in users if abs(u["timestamp"] - when) < 60 and u["content"].strip() and (text == u["content"] or text.endswith(u["content"]) or text.endswith(u["content"] + "\n"))}
                    if len(matches) == 1:
                        sessions.update(matches)
                patches.extend(extract_patches(event))
        # Never attach log data to a session if ownership is ambiguous.
        if len(sessions) == 1:
            sid = next(iter(sessions))
            for patch in patches:
                if patch["call_id"] not in completions:
                    continue
                patch["completed_at"] = completions[patch["call_id"]]
                patch["source"] = str(path)
                candidates.setdefault(sid, []).append(patch)
    plans, unresolved = [], []
    for row in rows:
        patch = choose_patch(row, candidates.get(row["session_id"], []))
        if patch:
            activity = json.loads(row["content"])
            activity["detail"] = patch["detail"]
            plans.append({"original": row, "content": json.dumps(activity, ensure_ascii=False), "source": patch["source"], "call_id": patch["call_id"], "full": patch["full"]})
        else:
            unresolved.append({"id": row["id"], "session_id": row["session_id"], "created_at": row["created_at"]})
    return rows, plans, unresolved


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default="data/app.db")
    parser.add_argument("--logs", default=str(Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "sessions"))
    parser.add_argument("--backup-dir")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if args.apply and not args.backup_dir:
        parser.error("--apply requires --backup-dir")
    connection = sqlite3.connect(f"file:{Path(args.db).resolve()}?mode={'rw' if args.apply else 'ro'}", uri=True, timeout=10)
    connection.row_factory = sqlite3.Row
    rows, plans, unresolved = scan(connection, args.logs)
    summary = {"broken": len(rows), "sessions": len({r["session_id"] for r in rows}), "fullPatches": sum(p["full"] for p in plans), "metadataOnly": sum(not p["full"] for p in plans), "unresolved": unresolved, "applied": False}
    if args.apply and plans:
        directory = Path(args.backup_dir) / ("edit-history-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ"))
        directory.mkdir(parents=True, mode=0o700)
        snapshot = directory / "app.db"
        snapshot.touch(mode=0o600)
        with sqlite3.connect(snapshot) as backup:
            connection.backup(backup)
        audit = directory / "repairs.json"
        audit.touch(mode=0o600)
        audit.write_text(json.dumps({"summary": summary, "plans": plans}, ensure_ascii=False, indent=2))
        connection.execute("BEGIN IMMEDIATE")
        try:
            # One source tool call must never repair several distinct activities.
            sources = {(p["source"], p["call_id"]) for p in plans}
            if len(sources) != len(plans):
                raise RuntimeError("Duplicate source matches; refusing ambiguous repair")
            for plan in plans:
                row = plan["original"]
                updated = connection.execute("UPDATE messages SET content=? WHERE id=? AND session_id=? AND content=?", (plan["content"], row["id"], row["session_id"], row["content"]))
                if updated.rowcount != 1:
                    raise RuntimeError("Activity changed during repair; transaction rolled back")
                saved = connection.execute("SELECT content,created_at FROM messages WHERE id=? AND session_id=?", (row["id"], row["session_id"])).fetchone()
                assert saved["content"] == plan["content"] and saved["created_at"] == row["created_at"]
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        summary["applied"] = True
        summary["backup"] = str(directory)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    connection.close()


if __name__ == "__main__":
    main()
