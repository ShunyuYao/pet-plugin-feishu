import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("plugin_builder", ROOT / "scripts/build-plugin.py")
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="feishu-package-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "source"
        self.root.mkdir()
        self.names = json.loads((ROOT / "package-files.json").read_text())
        for name in self.names + ["package.json", "package-files.json"]:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
        self.output = Path(self.temp.name) / "output"

    def build(self):
        return BUILDER.build(self.root, self.output)

    def write_names(self, names):
        (self.root / "package-files.json").write_text(json.dumps(names))

    def test_installable_package_matches_allowlist_and_checksum(self):
        checksum = self.build()
        payload = (self.output / "plugin.zip").read_bytes()
        self.assertEqual(checksum, hashlib.sha256(payload).hexdigest())
        self.assertEqual((self.output / "plugin.zip.sha256").read_text(), checksum + "  plugin.zip\n")
        with zipfile.ZipFile(self.output / "plugin.zip") as archive:
            self.assertIsNone(archive.testzip())
            self.assertEqual(archive.namelist(), sorted(self.names))
            manifest = json.loads(archive.read("manifest.json"))
            self.assertEqual(manifest["id"], "feishu")
            for info in archive.infolist():
                self.assertEqual(archive.read(info.filename), (self.root / info.filename).read_bytes())
                self.assertEqual(info.date_time, (1980, 1, 1, 0, 0, 0))
                self.assertEqual(info.external_attr >> 16, 0o100644)

    def test_reproducible_and_ignores_unlisted_private_files(self):
        first = self.build()
        for name in self.names:
            os.utime(self.root / name, (1720000000, 1720000000))
            os.chmod(self.root / name, 0o600)
        for name in [".env", ".env.local", "node_modules/private.js", "tests/private.txt", "lib/assets/not-allowlisted.txt"]:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("synthetic private fixture; do not package")
        self.assertEqual(self.build(), first)

    def test_rejects_missing_file_before_writing_archive(self):
        (self.root / "index.js").unlink()
        with self.assertRaisesRegex(ValueError, "Missing package file"):
            self.build()
        self.assertFalse(self.output.exists())

    def test_rejects_symlinked_file_and_directory(self):
        target = self.root / "index.js"
        target.unlink()
        target.symlink_to(ROOT / "index.js")
        with self.assertRaisesRegex(ValueError, "Symlinks"):
            self.build()
        target.unlink()
        shutil.copyfile(ROOT / "index.js", target)
        shutil.rmtree(self.root / "lib")
        (self.root / "lib").symlink_to(ROOT / "lib", target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Symlinks"):
            self.build()

    def test_rejects_traversal_private_and_build_paths(self):
        for name in ["../private", "/private", "lib/../private", "lib//private", "lib/./private", "lib\\private", "C:/private", ".env", "lib/.env", "dist/plugin.zip", "tests/private.js"]:
            with self.subTest(name=name):
                self.write_names(self.names + [name])
                with self.assertRaisesRegex(ValueError, "Unsafe"):
                    self.build()

    def test_rejects_duplicate_or_missing_required_allowlist_entries(self):
        for names in [self.names + ["manifest.json"], [n for n in self.names if n != "lib/auth.js"]]:
            self.write_names(names)
            with self.assertRaisesRegex(ValueError, "allowlist"):
                self.build()

    def test_rejects_manifest_package_version_mismatch(self):
        path = self.root / "package.json"
        package = json.loads(path.read_text())
        package["version"] = "99.0.0"
        path.write_text(json.dumps(package))
        with self.assertRaisesRegex(ValueError, "identity/version"):
            self.build()


if __name__ == "__main__":
    unittest.main()
