"""
Shared helpers for the Claude Code PostToolUse hook `tool_response` payload.

PostToolUse hooks receive a JSON payload on stdin whose `tool_response` field
can take several shapes depending on the surface that produced it:
  - bare string         → e.g. `"PASS\n..."`
  - dict with `content` / `output` / `text` (string or list of parts)
  - list of `{ "type": "text", "text": "..." }` parts (joined by newline)

`extract_text(resp)` normalizes any of those into a single string suitable for
substring search ("Self-Review PASSED in text") or regex parsing (severity
findings, line refs).

This logic used to live in two places — `parse-self-review-output.py` (Python)
and `post-self-review.sh` (inline `python3 -c`). The bash hook now imports this
module via `sys.path.insert`. Single source of truth for tool_response shape
handling — when a new Claude Code surface ships a new shape, only one file
needs updating.

Extracted in PR M (code-review finding #13).
"""

from __future__ import annotations

from typing import Any


def extract_text(resp: Any) -> str:
    """
    Normalize a PostToolUse `tool_response` value into a plain text string.

    Handles:
      - str                          → returned as-is
      - dict with `content`/`output`/`text` (str or list of parts)
      - list of parts (each `{text: "..."}` or stringifiable)
      - anything else                → `str(resp)`

    Always returns a string. Never raises — callers can substring-search safely.
    """
    if isinstance(resp, str):
        return resp

    if isinstance(resp, dict):
        # Common shapes: {"content": "..."}, {"output": "..."}, {"text": "..."}
        # `content` wins because Claude Code's Task tool uses it most often.
        candidate = resp.get("content") or resp.get("output") or resp.get("text") or ""
        if isinstance(candidate, list):
            return _join_parts(candidate)
        if isinstance(candidate, str):
            return candidate
        return str(candidate)

    if isinstance(resp, list):
        return _join_parts(resp)

    return str(resp) if resp is not None else ""


def _join_parts(parts: list[Any]) -> str:
    """
    Join a list of content parts into a single string.

    Each part is either a dict with a `text` key (the canonical Claude content
    block shape) or anything else (coerced via `str()`).
    """
    out: list[str] = []
    for part in parts:
        if isinstance(part, dict):
            out.append(str(part.get("text", "")))
        else:
            out.append(str(part))
    return "\n".join(out)
