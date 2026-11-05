"""SAM 3.1 mask wire format: parse the per-frame text lines and decode the masks.

What Meta's Model API streams back for one concept, one line per video frame:

    <7f>0<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|><|mask;x=0;y=0;data=H,W,!PAYLOAD|>,3<|box...

object id -> inclusive pixel box -> a mask raster the size of that box, range-coded
and base85-packed. Frames where nothing is visible emit no line, so frame numbers
may skip; object ids are stable across one response and need not be dense.

Protocol + reference decoder: github.com/meta-models/meta-sam (protocol/sam3.md).
`decode_mask` and `_unpack` are a port of that reference and are distributed under
the SAM License (see SAM_LICENSE.txt). Keep in step with web/sam-codec.js.
"""
from __future__ import annotations

import re
from array import array


class CodecError(ValueError):
    pass


_FRAME = re.compile(r"^<(\d+)f>")
_RECORD = re.compile(
    r"(\d+)<\|box;x1=(-?\d+);y1=(-?\d+);x2=(-?\d+);y2=(-?\d+);w=(\d+);h=(\d+)\|>"
    r"<\|mask;x=0;y=0;data=(\d+),(\d+),([^|]+)\|>")


def parse_line(line: str) -> tuple[int | None, list[dict]]:
    """`<Nf>` + records -> (frame, [{id, box (x1, y1, x2, y2 inclusive px), w, h, mh, mw, payload}])."""
    m = _FRAME.match(line or "")
    if not m:
        return None, []
    recs = []
    for r in _RECORD.finditer(line, m.end()):
        oid, x1, y1, x2, y2, w, h, mh, mw, payload = r.groups()
        recs.append({"id": int(oid), "box": (int(x1), int(y1), int(x2), int(y2)),
                     "w": int(w), "h": int(h), "mh": int(mh), "mw": int(mw),
                     "payload": payload})
    return int(m.group(1)), recs


def read_track(path) -> dict[int, list[dict]]:
    """A whole .sam file -> {frame: [records]} (frames with nothing visible are absent)."""
    frames: dict[int, list[dict]] = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            frame, recs = parse_line(line.strip())
            if frame is not None and recs:
                frames[frame] = recs
    return frames


# base85 over '!'..'{' minus the seven wire delimiters  " \ , ; < > |
_ALPHABET = "".join(chr(c) for c in range(0x21, 0x7C) if chr(c) not in '"\\,;<>|')
_VAL = {ch: i for i, ch in enumerate(_ALPHABET)}
_TOP, _BOTTOM, _M32 = 1 << 24, 1 << 16, 0xFFFFFFFF


def _unpack(text: str) -> bytes:
    """5-char length prefix, then 4 bytes per 5 chars (a short tail carries n+1 chars for n bytes)."""
    try:
        n = 0
        for ch in text[:5]:
            n = n * 85 + _VAL[ch]
        rem = n % 4
        if len(text) != 5 + (n // 4) * 5 + (rem + 1 if rem else 0):
            raise CodecError("mask payload length does not match its prefix")
        out = bytearray(n)
        src, dst = 5, 0
        while dst < n - rem:
            v = 0
            for i in range(5):
                v = v * 85 + _VAL[text[src + i]]
            src += 5
            out[dst:dst + 4] = ((v >> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255)
            dst += 4
        if rem:
            v = 0
            for i in range(5):
                v = v * 85 + (_VAL[text[src + i]] if i < rem + 1 else 84)
            for i in range(rem):
                out[dst + i] = (v >> (24 - 8 * i)) & 255
        return bytes(out)
    except (KeyError, IndexError):
        raise CodecError("mask payload contains an invalid character") from None


def decode_mask(payload: str, width: int, height: int) -> bytearray:
    """one_bit payload -> row-major 0/1 raster (width * height bytes).

    An adaptive binary range coder: each pixel is coded under a 12-bit context of
    already-decoded neighbours (2 to the left, 5 on each of the two rows above)."""
    if not payload or payload[0] != "!":
        raise CodecError("only one_bit ('!') mask payloads are supported")
    data = _unpack(payload[1:])
    n = len(data)
    if n < 4:
        raise CodecError("mask payload is missing its finalization")
    code = int.from_bytes(data[:4], "big")
    pos, low, rng = 4, 0, _M32
    counts = array("H", [1]) * 8192
    pw = width + 4
    pad = bytearray(pw * (height + 2))
    out = bytearray(width * height)
    for y in range(height):
        row = (y + 2) * pw + 2
        for x in range(width):
            p = row + x
            pr = p - pw
            er = pr - pw
            o = (pad[p - 1] | (pad[p - 2] << 1) | (pad[pr - 2] << 2) | (pad[pr - 1] << 3)
                 | (pad[pr] << 4) | (pad[pr + 1] << 5) | (pad[pr + 2] << 6) | (pad[er - 2] << 7)
                 | (pad[er - 1] << 8) | (pad[er] << 9) | (pad[er + 1] << 10) | (pad[er + 2] << 11)) << 1
            zero = counts[o]
            one = counts[o + 1]
            total = zero + one
            scaled = rng // total
            if not scaled:
                raise CodecError("mask payload has invalid coding state")
            v = ((code - low) & _M32) // scaled
            if v >= total:
                v = total - 1
            if v < zero:
                bit = 0
                rng = scaled * zero
            else:
                bit = 1
                low = (low + scaled * zero) & _M32
                rng = scaled * one
            while True:
                if ((low ^ ((low + rng) & _M32)) & _M32) >= _TOP:
                    if rng >= _BOTTOM:
                        break
                    rng = ((-low) & _M32) & (_BOTTOM - 1)
                code = ((code << 8) | (data[pos] if pos < n else 0)) & _M32
                pos += 1
                low = (low << 8) & _M32
                rng = (rng << 8) & _M32
            if bit:
                pad[p] = 1
                out[y * width + x] = 1
            counts[o + bit] = (counts[o + bit] + 14) & 0xFFFF
            if counts[o] + counts[o + 1] >= 4096:
                counts[o] = (counts[o] >> 1) or 1
                counts[o + 1] = (counts[o + 1] >> 1) or 1
    return out


def summarize(lines) -> dict:
    """Per-object observations: {"size": (w, h), "objects": {id: {"frames": [...],
    "boxes": [(x1, y1, x2, y2) normalised 0..1]}}}."""
    objs: dict[int, dict] = {}
    size = None
    for line in lines:
        frame, recs = parse_line(line.strip() if isinstance(line, str) else line)
        if frame is None:
            continue
        for r in recs:
            w, h = r["w"], r["h"]
            size = size or (w, h)
            x1, y1, x2, y2 = r["box"]
            o = objs.setdefault(r["id"], {"frames": [], "boxes": []})
            o["frames"].append(frame)
            o["boxes"].append((x1 / w, y1 / h, (x2 + 1) / w, (y2 + 1) / h))
    return {"size": size, "objects": objs}
