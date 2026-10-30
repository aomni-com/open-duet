"""Apply only the explicitly requested major-version label, then use the frozen oracle."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile

source, candidate = (json.load(open(path)) for path in sys.argv[1:])
assert source["results"]["version"]["stdout"] == "0.3.36\n"
assert candidate["results"]["version"]["stdout"] == "1.0.0\n"
assert source["results"]["rpc"]["stderr"] == "@duetso/agent 0.3.36 rpc\n"
assert candidate["results"]["rpc"]["stderr"] == "@duetso/agent 1.0.0 rpc\n"
candidate["results"]["version"]["stdout"] = source["results"]["version"]["stdout"]
candidate["results"]["rpc"]["stderr"] = source["results"]["rpc"]["stderr"]
with tempfile.TemporaryDirectory(prefix="duet-parity-") as scratch:
    paths = [Path(scratch) / name for name in ["source.json", "candidate.json"]]
    for path, receipt in zip(paths, [source, candidate]):
        path.write_text(json.dumps(receipt))
    subprocess.run([sys.executable, str(Path(__file__).parent.parent / "packaging" / "compare.py"),
                    *map(str, paths)], check=True)
