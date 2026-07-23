"""Pure path-validation helpers shared by the local API and its tests."""

from pathlib import Path
import re


SAFE_REPO_ID = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")


def validate_repo_id(repo_id: str) -> str:
    if not SAFE_REPO_ID.fullmatch(repo_id):
        raise ValueError("Invalid Hugging Face repository identifier")
    return repo_id


def contained_gguf_path(models_dir: Path, filename: str) -> Path:
    """Resolve a plain GGUF filename and guarantee it stays in models_dir."""
    if (
        not filename
        or "/" in filename
        or "\\" in filename
        or Path(filename).name != filename
        or not filename.lower().endswith(".gguf")
    ):
        raise ValueError("Invalid GGUF filename")

    models_dir = models_dir.resolve()
    candidate = (models_dir / filename).resolve()
    if candidate.parent != models_dir:
        raise ValueError("Invalid model path")
    return candidate
