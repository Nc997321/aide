#!/usr/bin/env python3
"""Sign an Aide app catalog with OpenSSL Ed25519."""

import argparse
import base64
import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path, PurePosixPath


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("catalog", type=Path, help="catalog.json next to the packages directory")
    parser.add_argument("key", type=Path, help="private Ed25519 key in PEM format")
    parser.add_argument("output", type=Path, help="destination for catalog.signed.json")
    args = parser.parse_args()

    payload = args.catalog.read_bytes()
    catalog = json.loads(payload)
    if catalog["schemaVersion"] != 1:
        parser.error("unsupported schemaVersion")
    root = args.catalog.resolve().parent
    for app in catalog["apps"]:
        package = app["package"]
        path = PurePosixPath(package["url"])
        if not path.parts or path.parts[0] != "packages" or ".." in path.parts:
            parser.error(f"invalid package path for {app['id']}")
        archive = (root / path).resolve()
        if not archive.is_relative_to(root / "packages"):
            parser.error(f"package outside packages directory for {app['id']}")
        with archive.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if digest != package["sha256"].lower():
            parser.error(f"SHA-256 mismatch for {app['id']}")

    with tempfile.TemporaryDirectory() as temp:
        source = Path(temp) / "catalog.json"
        source.write_bytes(payload)
        signature = subprocess.check_output(
            ["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", args.key, "-in", source]
        )
    if len(signature) != 64:
        parser.error("expected a 64-byte Ed25519 signature")
    envelope = {
        "payload": base64.b64encode(payload).decode("ascii"),
        "signature": base64.b64encode(signature).decode("ascii"),
    }
    with tempfile.NamedTemporaryFile(mode="w", dir=args.output.parent, delete=False) as staged:
        stage = Path(staged.name)
        try:
            json.dump(envelope, staged)
            staged.close()
            stage.chmod(0o644)
            os.replace(stage, args.output)
        finally:
            stage.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
