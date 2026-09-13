#!/usr/bin/env python3
"""Build the installable artifact from an explicit, reviewable file allowlist."""

import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import stat
import zipfile

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = {"manifest.json", "index.js", "lib/ctx.js", "lib/auth.js", "lib/calendar.js", "lib/contacts.js", "lib/im.js", "lib/report.js"}


def build(root=ROOT, output=None):
    root = Path(root).resolve()
    names = json.loads((root / "package-files.json").read_text(encoding="utf-8"))
    if (not isinstance(names, list) or not all(isinstance(n, str) for n in names)
            or len(names) != len(set(names)) or not REQUIRED.issubset(names)):
        raise ValueError("The allowlist must include required files once each")

    entries = []
    for name in sorted(names):
        relative = PurePosixPath(name)
        if (not name or relative.is_absolute() or str(relative) != name
                or any(part.startswith(".") for part in relative.parts)
                or any(c in name for c in "\\:\x00\n\r")
                or relative.parts[0] in {"dist", "tests", "scripts", "node_modules"}):
            raise ValueError("Unsafe or non-runtime package path: " + name)
        source = root
        for part in relative.parts:
            source = source / part
            if source.is_symlink():
                raise ValueError("Symlinks are not allowed: " + name)
        if not source.is_file():
            raise ValueError("Missing package file: " + name)
        entries.append((name, source.read_bytes()))

    manifest = json.loads(dict(entries)["manifest.json"])
    package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    if (manifest.get("id") != "feishu"
            or manifest.get("version") != package.get("version")
            or not re.fullmatch(r"\d+\.\d+\.\d+", manifest.get("version", ""))):
        raise ValueError("Plugin identity/version does not match package.json")

    # STORE avoids zlib-version-dependent compression; source timestamps and
    # filesystem permissions never enter the archive. This is portable to CI.
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, data in entries:
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(info, data)
    payload = buffer.getvalue()
    checksum = hashlib.sha256(payload).hexdigest()
    output = Path(output) if output is not None else root / "dist"
    output.mkdir(parents=True, exist_ok=True)
    (output / "plugin.zip").write_bytes(payload)
    (output / "plugin.zip.sha256").write_text(checksum + "  plugin.zip\n", encoding="ascii")
    return checksum


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    print(build(output=args.output) + "  plugin.zip")
