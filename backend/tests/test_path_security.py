import tempfile
import unittest
from pathlib import Path

from backend.path_security import contained_gguf_path, validate_repo_id


class PathSecurityTests(unittest.TestCase):
    def test_accepts_plain_gguf_filename(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertEqual(contained_gguf_path(root, "model.Q4_K_M.gguf"), root.resolve() / "model.Q4_K_M.gguf")

    def test_rejects_path_traversal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for filename in ("../escape.gguf", "..\\escape.gguf", "/tmp/escape.gguf", "model.bin", ""):
                with self.subTest(filename=filename), self.assertRaises(ValueError):
                    contained_gguf_path(root, filename)

    def test_validates_hugging_face_repo_identifiers(self):
        self.assertEqual(validate_repo_id("publisher/model-name"), "publisher/model-name")
        for repo_id in ("publisher", "../owner/model", "owner/model/extra", "https://example.com/model"):
            with self.subTest(repo_id=repo_id), self.assertRaises(ValueError):
                validate_repo_id(repo_id)


if __name__ == "__main__":
    unittest.main()
