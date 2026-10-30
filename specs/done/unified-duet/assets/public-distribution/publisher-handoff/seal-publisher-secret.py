import base64
import json
import os
from pathlib import Path

from nacl import encoding, public


secret = os.environ.get("NPM_TOKEN", "")
if not secret:
    raise SystemExit("Publishing credential is unavailable")
receiver = public.PublicKey(os.environ["DESTINATION_PUBLIC_KEY"], encoding.Base64Encoder)
ciphertext = public.SealedBox(receiver).encrypt(secret.encode())
envelope = {
    "destination": "aomni-com/duet",
    "name": "NPM_TOKEN",
    "payload": {
        "key_id": os.environ["DESTINATION_KEY_ID"],
        "encrypted_value": base64.b64encode(ciphertext).decode(),
    },
}
Path("publisher-secret.json").write_text(json.dumps(envelope) + "\n")
print("Sealed publisher credential for aomni-com/duet")
