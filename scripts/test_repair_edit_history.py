import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

from repair_edit_history import choose_patch, decode_literal, extract_patches


PATCH = "*** Begin Patch\n*** Update File: first.py\n@@\n-old\n+new\n*** End Patch"


def event(source):
    return {
        "type": "response_item",
        "timestamp": "2026-10-16T01:00:00Z",
        "payload": {
            "type": "custom_tool_call",
            "name": "exec",
            "call_id": "call-1",
            "input": source,
        },
    }


class RepairTests(unittest.TestCase):
    def test_apply_backs_up_changes_only_detail_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db_path = root / "app.db"
            logs = root / "logs"
            logs.mkdir()
            connection = sqlite3.connect(db_path)
            connection.executescript("CREATE TABLE sessions(id TEXT,backend TEXT,codex_thread_id TEXT); CREATE TABLE messages(id TEXT,session_id TEXT,role TEXT,content TEXT,created_at TEXT);")
            connection.execute("INSERT INTO sessions VALUES('session','codex','thread-1')")
            original = json.dumps({"kind": "tool", "toolName": "Edit", "label": "Edit files", "detail": "[object Object]", "output": "ok"})
            connection.execute("INSERT INTO messages VALUES('message','session','activity',?,'2026-10-16T01:00:00.100Z')", (original,))
            connection.commit()
            call = event("tools.apply_patch(" + json.dumps(PATCH) + ");")
            end = {"type": "response_item", "timestamp": "2026-10-16T01:00:00.200Z", "payload": {"type": "custom_tool_call_output", "call_id": "call-1"}}
            (logs / "thread-1.jsonl").write_text(json.dumps(call) + "\n" + json.dumps(end) + "\n{unfinished")
            command = [sys.executable, str(Path(__file__).with_name("repair_edit_history.py")), "--db", str(db_path), "--logs", str(logs), "--backup-dir", str(root / "backups"), "--apply"]
            result = json.loads(subprocess.check_output(command))
            self.assertTrue(result["applied"])
            self.assertEqual(result["fullPatches"], 1)
            backup = sqlite3.connect(Path(result["backup"]) / "app.db")
            self.assertEqual(backup.execute("SELECT content FROM messages").fetchone()[0], original)
            backup.close()
            saved = json.loads(connection.execute("SELECT content FROM messages").fetchone()[0])
            expected = json.loads(original)
            expected["detail"] = PATCH
            self.assertEqual(saved, expected)
            self.assertEqual(json.loads(subprocess.check_output(command))["broken"], 0)
            connection.close()

    def test_direct_and_variable_literals_preserve_exact_patch(self):
        for source in [
            "text(await tools.apply_patch(" + json.dumps(PATCH) + "));",
            "const patch = " + json.dumps(PATCH) + "; text(await tools.apply_patch(patch));",
        ]:
            patches = extract_patches(event(source))
            self.assertEqual(len(patches), 1)
            self.assertTrue(patches[0]["full"])
            self.assertEqual(patches[0]["detail"], PATCH)

    def test_literal_decoding_retains_unicode_and_escaped_source(self):
        value = '中文\\n "quoted"\nnext'
        self.assertEqual(decode_literal(json.dumps(value)), value)
        self.assertEqual(decode_literal(r'"text\(x\)"'), "text(x)")

    def test_dynamic_template_recovers_only_static_metadata(self):
        source = "const patch = `*** Begin Patch\\n*** Update File: notebook.ipynb\\n@@\\n-${old}\\n+${new}\\n*** End Patch`; text(await tools.apply_patch(patch));"
        [patch] = extract_patches(event(source))
        self.assertFalse(patch["full"])
        self.assertEqual(json.loads(patch["detail"])["changes"], [{"path": "notebook.ipynb", "kind": "update"}])
        self.assertNotIn("${", patch["detail"])

    def test_does_not_execute_code_or_guess_dynamic_paths(self):
        self.assertEqual(extract_patches(event('const patch = readSecret(); tools.apply_patch(patch);')), [])
        self.assertEqual(extract_patches(event('const patch = `*** Begin Patch\\n*** Update File: ${path}\\n@@\\n-a\\n+b\\n*** End Patch`;tools.apply_patch(patch);')), [])

    def test_matches_execution_interval_and_rejects_ambiguity(self):
        row = {"content": json.dumps({"detail": "[object Object]"}), "created_at": "2026-10-16T01:00:13Z"}
        [patch] = extract_patches(event("tools.apply_patch(" + json.dumps(PATCH) + ");"))
        patch["completed_at"] = patch["timestamp"] + 14
        self.assertIs(choose_patch(row, [patch]), patch)
        self.assertIsNone(choose_patch(row, [patch, dict(patch)]))
        self.assertIsNone(choose_patch(row, [{**patch, "count": 2}]))
        self.assertIsNone(choose_patch(row, [{**patch, "completed_at": patch["timestamp"] + 1}]))


if __name__ == "__main__":
    unittest.main()
