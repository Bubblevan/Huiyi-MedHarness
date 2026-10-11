from __future__ import annotations

import hashlib
from pathlib import Path


def _source_fingerprint() -> str:
    app_root = Path(__file__).resolve().parent
    repo_root = Path(__file__).resolve().parents[4]
    source_roots = (
        ("huiyi_health_engine", app_root),
        ("AMA", repo_root / "third_party" / "AMA" / "python" / "AdaptiveMemory"),
    )
    sources: list[tuple[str, Path]] = []
    for prefix, root in source_roots:
        if not root.is_dir():
            raise RuntimeError(f"evaluation runtime source is missing: {prefix}")
        for path in root.rglob("*.py"):
            if path.is_file() and not path.is_symlink():
                sources.append((f"{prefix}/{path.relative_to(root).as_posix()}", path))

    digest = hashlib.sha256()
    for relative_path, path in sorted(sources, key=lambda item: item[0]):
        digest.update(relative_path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


# Captured during import so an old running process cannot claim the hash of
# source files that changed after its Python modules were loaded.
HEALTH_ENGINE_SOURCE_SHA256 = _source_fingerprint()
