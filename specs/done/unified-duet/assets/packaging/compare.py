"""Compare frozen-source and relocated production-entrypoint observations."""
import json
import re
import sys

if sys.argv[1] == "--tui":
    for path in sys.argv[2:]:
        transcript = open(path).read()
        for label in ["DUET AGENT", "todos", "relays", "context"]:
            assert label in transcript, f"{path}: TUI did not render {label}"
        assert not re.search(r"dlopen|Cannot find module|(?:error|Error):|ModuleNotFound|failed to (?:load|initialize)", transcript), f"{path}: TUI initialization error"
    print(json.dumps({"nativeTuiInitialized": sys.argv[2:]}))
    sys.exit(0)

source, candidate = (json.load(open(path)) for path in sys.argv[1:])


def normalize(value):
    if isinstance(value, str):
        return re.sub(r"/tmp/duet-packaging-[A-Za-z0-9]+", "/tmp/duet-packaging-FIXTURE", value)
    if isinstance(value, list):
        return [normalize(item) for item in value]
    if isinstance(value, dict):
        return {key: normalize(item) for key, item in value.items()
                if key not in {"elapsedMs", "sampledPeakRssKiB"}}
    return value


contracts = ["version", "help", "skills", "provider", "rpc"]
for contract in contracts:
    assert normalize(source["results"][contract]) == normalize(candidate["results"][contract]), contract
# Memory notes carry intentional random identifiers and wall-clock ranking metadata.
# The probe independently checks stored/reopened content and vector-only retrieval.
for receipt in [source, candidate]:
    memory = receipt["results"]["memory"]
    added = json.loads(memory["added"]["stdout"])
    reopened = json.loads(memory["reopened"]["stdout"])
    recalled = json.loads(memory["semanticRecall"]["stdout"])
    assert added["content"] == reopened[0]["content"] == recalled[0]["content"]
    assert added["content"] == "The harbor lighthouse is violet."
assert normalize(source["requests"]) == normalize(candidate["requests"])
print(json.dumps({"equalContracts": contracts + ["complete model/embedding request bodies", "memory content"],
                  "normalizations": ["scratch directory", "elapsed time", "sampled RSS"],
                  "memoryMetadata": "Generated IDs/timestamps/ranking are not compared; content and actual vector retrieval are asserted."}, indent=2))
