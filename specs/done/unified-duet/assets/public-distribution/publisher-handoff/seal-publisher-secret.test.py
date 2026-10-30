import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from nacl.public import PrivateKey, SealedBox


class PublisherHandoff(unittest.TestCase):
    def test_the_cli_exports_only_ciphertext_decryptable_by_the_destination(self):
        receiver = PrivateKey.generate()
        secret = "REDACTED"
        env = {**os.environ, "NPM_TOKEN": secret,
               "DESTINATION_PUBLIC_KEY": base64.b64encode(bytes(receiver.public_key)).decode(),
               "DESTINATION_KEY_ID": "fixture-key"}
        with tempfile.TemporaryDirectory() as scratch:
            child = subprocess.run(["python3", "-I", str(Path(__file__).with_name("seal-publisher-secret.py"))],
                                   cwd=scratch, env=env, text=True, capture_output=True)
            self.assertEqual(child.returncode, 0, child.stderr)
            artifact = Path(scratch, "publisher-secret.json").read_text()
            envelope = json.loads(artifact)
            self.assertEqual(envelope["destination"], "aomni-com/duet")
            self.assertEqual(envelope["name"], "NPM_TOKEN")
            self.assertEqual(envelope["payload"]["key_id"], "fixture-key")
            opened = SealedBox(receiver).decrypt(base64.b64decode(envelope["payload"]["encrypted_value"]))
            self.assertEqual(opened.decode(), secret)
            self.assertNotIn("fixture-npm-token", artifact + child.stdout + child.stderr)

    def test_missing_publisher_auth_cannot_export_an_empty_credential(self):
        receiver = PrivateKey.generate()
        env = {**os.environ, "DESTINATION_PUBLIC_KEY": base64.b64encode(bytes(receiver.public_key)).decode(),
               "DESTINATION_KEY_ID": "fixture-key"}
        env.pop("NPM_TOKEN", None)
        with tempfile.TemporaryDirectory() as scratch:
            child = subprocess.run(["python3", "-I", str(Path(__file__).with_name("seal-publisher-secret.py"))],
                                   cwd=scratch, env=env, text=True, capture_output=True)
            self.assertNotEqual(child.returncode, 0)
            self.assertEqual(child.stdout, "")
            self.assertFalse(Path(scratch, "publisher-secret.json").exists())


if __name__ == "__main__":
    unittest.main()
