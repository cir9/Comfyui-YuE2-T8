"""Small, side-effect free GPU memory helpers used by the local service.

The web service deliberately does not keep a model resident.  These helpers
therefore report the machine state through ``nvidia-smi`` when available and
only clear allocator state owned by this process.  They never reset a GPU or
terminate an unrelated process.
"""

from __future__ import annotations

import csv
import io
import subprocess
from typing import Any


def parse_nvidia_smi_csv(text: str) -> list[dict[str, Any]]:
    """Parse the stable CSV output of nvidia-smi into GiB values."""
    rows: list[dict[str, Any]] = []
    for row in csv.reader(io.StringIO(text)):
        if len(row) < 4:
            continue
        try:
            index = int(row[0].strip())
            total = float(row[1].strip()) * 2**20
            used = float(row[2].strip()) * 2**20
            free = float(row[3].strip()) * 2**20
        except (TypeError, ValueError):
            continue
        if total <= 0 or min(used, free) < 0:
            continue
        rows.append({
            "index": index,
            "total_bytes": int(total),
            "used_bytes": int(used),
            "free_bytes": int(free),
            "total_gib": total / 2**30,
            "used_gib": used / 2**30,
            "free_gib": free / 2**30,
        })
    return rows


def query_gpu_memory(timeout: float = 2.0) -> dict[str, Any]:
    """Return current NVIDIA memory, or an explicit unavailable state."""
    command = [
        "nvidia-smi", "--query-gpu=index,memory.total,memory.used,memory.free",
        "--format=csv,noheader,nounits",
    ]
    try:
        completed = subprocess.run(
            command, check=False, capture_output=True, text=True,
            timeout=timeout, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        gpus = parse_nvidia_smi_csv(completed.stdout or "")
        if completed.returncode != 0 and not gpus:
            raise RuntimeError((completed.stderr or "nvidia-smi failed").strip())
    except Exception as exc:  # a CPU-only machine is a supported UI state
        return {"available": False, "gpus": [], "error": str(exc)[:240]}
    return {
        "available": bool(gpus),
        "gpus": gpus,
        "error": None if gpus else "nvidia-smi returned no NVIDIA device",
    }


def clear_current_process_cuda() -> dict[str, Any]:
    """Release CUDA allocator blocks owned by the service process, if any."""
    result = {"cuda_available": False, "released": False, "error": None}
    try:
        import torch
        result["cuda_available"] = bool(torch.cuda.is_available())
        if result["cuda_available"]:
            torch.cuda.synchronize()
            torch.cuda.empty_cache()
            ipc_collect = getattr(torch.cuda, "ipc_collect", None)
            if ipc_collect:
                ipc_collect()
            result["released"] = True
    except Exception as exc:
        result["error"] = str(exc)[:240]
    return result


def memory_snapshot() -> dict[str, Any]:
    """Return a UI-friendly snapshot with aggregate values."""
    data = query_gpu_memory()
    gpus = data.get("gpus", [])
    if gpus:
        data["aggregate"] = {
            "total_gib": sum(item["total_gib"] for item in gpus),
            "used_gib": sum(item["used_gib"] for item in gpus),
            "free_gib": sum(item["free_gib"] for item in gpus),
        }
    else:
        data["aggregate"] = None
    return data
