"""Meta SAM 3.1 over the Meta Model API: upload a clip, prompt one concept, stream the masks back.

Configuration comes from the environment only (never commit a key):

    META_MODEL_API_KEY      required
    META_API_BASE           default https://api.meta.ai/v1
    SAM_MODEL               default sam-3.1
    SAM_TIMEOUT_SEC         default 900
    SAM_USD_PER_1K_FRAMES   default 0.20 (used for the cost estimate only)

SAM 3.1 takes ONE concrete noun phrase per request ("person", "badminton racket"),
no lists and no clicks, so each concept is its own pass over the clip. Every frame
sent is billed per concept, which is why `estimate_usd` runs before any upload.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

import requests

TRANSIENT = (429, 500, 502, 503)


class SamError(RuntimeError):
    pass


def api_base() -> str:
    return os.environ.get("META_API_BASE", "https://api.meta.ai/v1").rstrip("/")


def model() -> str:
    return os.environ.get("SAM_MODEL", "sam-3.1")


def _key() -> str:
    key = os.environ.get("META_MODEL_API_KEY", "").strip()
    if not key:
        raise SamError("META_MODEL_API_KEY is not set (see .env.example)")
    return key


def _auth() -> dict:
    return {"Authorization": f"Bearer {_key()}"}


def redact(text: str) -> str:
    """Never let the key reach a log line or an exception message."""
    key = os.environ.get("META_MODEL_API_KEY", "").strip()
    return text.replace(key, "<redacted>") if key else text


def _http_error(what: str, r: requests.Response) -> SamError:
    err = SamError(redact(f"{what} HTTP {r.status_code}: {r.text[:300]}"))
    err.status = r.status_code
    return err


def estimate_usd(frames: int, concepts: int = 1) -> float:
    per_1k = float(os.environ.get("SAM_USD_PER_1K_FRAMES", "0.20"))
    return round(max(0, int(frames)) * max(1, concepts) / 1000.0 * per_1k, 4)


def upload_video(path: str | Path, timeout: int = 300, retries: int = 3) -> str:
    """Files API upload (purpose=user_data). Returns the file id. The upstream copy is
    set to expire after an hour in case the caller never reaches delete_file."""
    delay = 3.0
    last: Exception = SamError("upload failed")
    for attempt in range(retries):
        try:
            with open(path, "rb") as fh:
                r = requests.post(f"{api_base()}/files", headers=_auth(),
                                  data={"purpose": "user_data",
                                        "expires_after[anchor]": "created_at",
                                        "expires_after[seconds]": "3600"},
                                  files={"file": (Path(path).name, fh, "video/mp4")},
                                  timeout=timeout)
            if r.status_code < 300:
                fid = (r.json() or {}).get("id")
                if not fid:
                    raise SamError("upload returned no file id")
                return str(fid)
            last = _http_error("SAM upload", r)
            if r.status_code not in TRANSIENT:
                raise last
        except (requests.ConnectionError, requests.Timeout) as e:
            last = SamError(f"SAM upload connection failed: {type(e).__name__}")
        if attempt < retries - 1:
            time.sleep(delay)
            delay *= 2
    raise last


def delete_file(file_id: str) -> None:
    """Best effort: the clip is someone's footage, don't leave it upstream."""
    try:
        requests.delete(f"{api_base()}/files/{file_id}", headers=_auth(), timeout=30)
    except requests.RequestException:
        pass


def stream_segmentation(file_id: str, prompt: str, *, on_line=None,
                        timeout: float | None = None) -> tuple[list[str], dict]:
    """One concept over one uploaded clip. Returns (wire lines, usage).

    The response is server-sent events; each `response.output_text.delta` carries text
    whose newlines delimit frames (chunk boundaries are arbitrary, so the text is
    buffered and split here). Zero matches is a valid, empty result."""
    body = {
        "model": model(),
        "stream": True,
        "metadata": {"mask_encoding": "one_bit"},
        "input": [{"type": "message", "role": "user", "content": [
            {"type": "input_text", "text": prompt},
            {"type": "input_video", "file_id": file_id},
        ]}],
    }
    headers = {**_auth(), "Content-Type": "application/json", "Accept": "text/event-stream"}
    timeout = timeout or float(os.environ.get("SAM_TIMEOUT_SEC", "900"))
    delay = 4.0
    for attempt in range(3):
        try:
            resp = requests.post(f"{api_base()}/responses", headers=headers,
                                 json=body, stream=True, timeout=(30, timeout))
        except (requests.ConnectionError, requests.Timeout) as e:
            if attempt == 2:
                raise SamError(f"SAM request connection failed: {type(e).__name__}") from None
            time.sleep(delay)
            delay *= 2
            continue
        if resp.status_code in TRANSIENT and attempt < 2:
            resp.close()
            time.sleep(delay)
            delay *= 2
            continue
        break
    with resp:
        if resp.status_code >= 300:
            raise _http_error("SAM request", resp)
        lines: list[str] = []
        usage: dict = {}
        buf = ""
        done = False
        for raw in resp.iter_lines(decode_unicode=True):
            if not raw or not raw.startswith("data:"):
                continue
            data = raw[5:].strip()
            if data == "[DONE]":
                break
            try:
                ev = json.loads(data)
            except ValueError:
                continue
            kind = ev.get("type")
            if kind == "response.output_text.delta":
                buf += ev.get("delta") or ""
                while "\n" in buf:
                    line, buf = buf.split("\n", 1)
                    if line.strip():
                        lines.append(line.strip())
                        if on_line:
                            on_line(len(lines))
            elif kind == "response.completed":
                usage = ((ev.get("response") or {}).get("usage")) or {}
                done = True
            elif kind in ("response.failed", "response.incomplete", "error"):
                detail = ev.get("error") or (ev.get("response") or {}).get("error") or ev
                raise SamError(redact(f"SAM stream {kind}: {json.dumps(detail)[:300]}"))
        if buf.strip():
            lines.append(buf.strip())
        if not done:
            raise SamError("SAM stream ended before response.completed")
    return lines, usage
