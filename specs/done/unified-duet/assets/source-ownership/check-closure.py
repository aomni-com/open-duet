#!/usr/bin/env python3
"""Read-only proof for the frozen harness closure and existing workspace ranges.
Usage: python3 duet-source-closure-review.py REPO [BASELINE_GIT_REF]
Run after a frozen install; requires the repository's Bun and semver package.
"""
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
baseline = sys.argv[2] if len(sys.argv) > 2 else "HEAD"

def parse(text):
    return json.loads(re.sub(r",(\s*[}\]])", r"\1", text))

def git_text(*args):
    return subprocess.check_output(["git", *args], cwd=root, text=True)

live_bytes = (root / "bun.lock").read_bytes()
live = parse(live_bytes.decode())
source = parse((root / "specs/done/unified-duet/assets/source/bun.lock").read_text())
previous = parse(git_text("show", f"{baseline}:bun.lock"))

def units(key):
    parts = key.split("/")
    result = []
    index = 0
    while index < len(parts):
        width = 2 if parts[index].startswith("@") else 1
        result.append("/".join(parts[index:index + width]))
        index += width
    return result

def resolve(packages, parent, name):
    ancestors = units(parent) if parent else []
    while True:
        key = "/".join(ancestors + [name])
        if key in packages:
            return key
        if not ancestors:
            return None
        ancestors.pop()

closure = {}
owned_names = {workspace.get("name") for workspace in live["workspaces"].values()}
owned_dependencies = {}
for workspace in ["agent", "duet"]:
    manifest = json.loads((root / "packages" / workspace / "package.json").read_text())
    dependencies = {**manifest["dependencies"], **manifest["devDependencies"]}
    # Repo-owned additions compose the imported source; they have no external
    # package identity in its frozen lockfile. Keep the external closure exact.
    owned_dependencies[workspace] = sorted(name for name in dependencies if name in owned_names)
    dependencies = {name: version for name, version in dependencies.items() if name not in owned_names}
    for peers in [False, True]:
        pending = [("", manifest["name"], name, [name]) for name in dependencies]
        seen = set()
        differences = []
        while pending:
            source_parent, live_parent, name, route = pending.pop()
            source_key = resolve(source["packages"], source_parent, name)
            live_key = resolve(live["packages"], live_parent, name)
            if not source_key or not live_key:
                differences.append({"route": route, "source": source_key, "live": live_key})
                continue
            if (source_key, live_key) in seen:
                continue
            seen.add((source_key, live_key))
            expected = source["packages"][source_key]
            actual = live["packages"][live_key]
            if expected[0] != actual[0] or expected[2] != actual[2] or (len(expected) > 3 and expected[3] != actual[3]):
                differences.append({"route": route, "sourceKey": source_key, "liveKey": live_key,
                                    "source": expected[0], "live": actual[0]})
            kinds = ["dependencies", "optionalDependencies"] + (["peerDependencies"] if peers else [])
            for kind in kinds:
                for child in expected[2].get(kind, {}):
                    if resolve(source["packages"], source_key, child):
                        pending.append((source_key, live_key, child, route + [child]))
        closure[workspace + ("WithPeers" if peers else "")] = {
            "comparedNodes": len(seen), "differences": differences,
        }

checks = []
changed = []
for path, workspace in previous["workspaces"].items():
    if path not in live["workspaces"]:
        continue
    namespace = workspace.get("name", "") if path else ""
    for kind in ["dependencies", "devDependencies", "optionalDependencies"]:
        for name, constraint in workspace.get(kind, {}).items():
            if name == "@duetso/agent" or constraint in ["workspace:*", "*"]:
                continue
            if name not in live["workspaces"][path].get(kind, {}):
                continue
            if constraint == "catalog:":
                constraint = previous["catalog"][name]
            if constraint.startswith("catalog:"):
                continue
            old_key = resolve(previous["packages"], namespace, name)
            live_key = resolve(live["packages"], namespace, name)
            if not old_key or not live_key:
                continue
            old_identity = previous["packages"][old_key][0]
            live_identity = live["packages"][live_key][0]
            if "@workspace:" in live_identity:
                continue
            checks.append({"workspace": path, "dependency": name, "range": constraint,
                           "version": live_identity.rsplit("@", 1)[1]})
            if old_identity != live_identity:
                changed.append({"workspace": path, "dependency": name,
                                "old": old_identity, "live": live_identity})

semver_probe = '''const semver = require("semver");
const checks = JSON.parse(await new Response(Bun.stdin.stream()).text());
console.log(JSON.stringify(checks.filter(item => !semver.satisfies(item.version, item.range))));'''
invalid = json.loads(subprocess.check_output(["bun", "--eval", semver_probe], cwd=root,
                                            input=json.dumps(checks), text=True))
patch_path = "patches/@user@example.invalid"
reference = json.loads((root / "specs/done/unified-duet/assets/source-reference.json").read_text())
patch_hash = hashlib.sha256((root / patch_path).read_bytes()).hexdigest()
transport_clean = b"192.0.2.1:9" not in live_bytes and b"localhost:9" not in live_bytes
report = {
    "baselineRevision": git_text("rev-parse", baseline).strip(),
    "sourceRevision": reference["sourceRevision"],
    "liveLockSha256": hashlib.sha256(live_bytes).hexdigest(),
    "closure": closure,
    "ownedWorkspaceDependencies": owned_dependencies,
    "existingWorkspaceDirectRanges": {"checked": len(checks), "invalid": invalid},
    "changedExistingDirectDependencies": changed,
    "probeRegistryAbsent": transport_clean,
    "piPatchSha256": patch_hash,
    "piPatchMatchesFrozenSource": patch_hash == reference["sourceSha256"][patch_path],
}
print(json.dumps(report, indent=2))
assert not closure["agent"]["differences"]
assert not closure["duet"]["differences"]
assert not closure["agentWithPeers"]["differences"]
# This peer is package metadata; bun-ffi-structs never imports the compiler.
# The agent and CLI actually invoke their own scoped frozen TypeScript 5.9.3.
for difference in closure["duetWithPeers"]["differences"]:
    assert difference["route"] == ["@opentui/core", "bun-ffi-structs", "typescript"]
    assert difference["source"] == "typescript@5.9.3"
    assert difference["live"] == "typescript@7.0.1-rc"
assert not invalid
assert transport_clean
assert report["piPatchMatchesFrozenSource"]
