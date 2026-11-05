/* SAM 3.1 mask wire format, decoded in the browser.

Meta's Model API streams one text line per video frame:

    <7f>0<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|><|mask;x=0;y=0;data=H,W,!PAYLOAD|>,3<|box...

object id -> inclusive pixel box -> a mask raster the size of that box. The
payload is an adaptive binary range coder (12-bit neighbour context) packed in a
base85 alphabet. About 25 KB per second of video, so masks travel as text and are
decoded here, per frame, just before they are drawn.

Keep in step with badminton_editor/codec.py (decode_mask / parse_line).
Protocol + reference decoder: github.com/meta-models/meta-sam (protocol/sam3.md). This port is a
derivative of that reference and is distributed under the SAM License, see SAM_LICENSE.txt. */
const samCodec = (() => {
  const VAL = new Int16Array(128).fill(-1);
  {
    let i = 0;
    for (let c = 0x21; c < 0x7c; c++) {
      if ('"\\,;<>|'.includes(String.fromCharCode(c))) continue;
      VAL[c] = i++;
    }
  }
  const TOP = 1 << 24, BOTTOM = 1 << 16;

  function unpack(text, start) {
    const digit = (i) => {
      const c = text.charCodeAt(i);
      const v = c < 128 ? VAL[c] : -1;
      if (v < 0) throw new Error("mask payload contains an invalid character");
      return v;
    };
    let n = 0;
    for (let i = 0; i < 5; i++) n = n * 85 + digit(start + i);
    const rem = n % 4;
    if (text.length - start !== 5 + Math.floor(n / 4) * 5 + (rem ? rem + 1 : 0)) {
      throw new Error("mask payload length does not match its prefix");
    }
    const out = new Uint8Array(n);
    let src = start + 5, dst = 0;
    const full = n - rem;
    while (dst < full) {
      let v = 0;
      for (let i = 0; i < 5; i++) v = v * 85 + digit(src + i);
      src += 5;
      out[dst] = Math.floor(v / 16777216) & 255; out[dst + 1] = (v >>> 16) & 255;
      out[dst + 2] = (v >>> 8) & 255; out[dst + 3] = v & 255;
      dst += 4;
    }
    if (rem) {
      let v = 0;
      for (let i = 0; i < 5; i++) v = v * 85 + (i < rem + 1 ? digit(src + i) : 84);
      for (let i = 0; i < rem; i++) out[dst + i] = Math.floor(v / Math.pow(2, 24 - 8 * i)) & 255;
    }
    return out;
  }

  // one_bit payload -> row-major 0/1 Uint8Array (width * height).
  function decodeMask(payload, width, height) {
    if (!payload || payload[0] !== "!") throw new Error("only one_bit ('!') mask payloads are supported");
    const data = unpack(payload, 1);
    const n = data.length;
    if (n < 4) throw new Error("mask payload is missing its finalization");
    let code = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
    let pos = 4, low = 0, range = 0xffffffff;
    const counts = new Uint16Array(8192).fill(1);
    const pw = width + 4;
    const pad = new Uint8Array(pw * (height + 2));
    const out = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      const row = (y + 2) * pw + 2;
      for (let x = 0; x < width; x++) {
        const p = row + x, pr = p - pw, er = pr - pw;
        const o = (pad[p - 1] | (pad[p - 2] << 1) | (pad[pr - 2] << 2) | (pad[pr - 1] << 3)
          | (pad[pr] << 4) | (pad[pr + 1] << 5) | (pad[pr + 2] << 6) | (pad[er - 2] << 7)
          | (pad[er - 1] << 8) | (pad[er] << 9) | (pad[er + 1] << 10) | (pad[er + 2] << 11)) << 1;
        const zero = counts[o], one = counts[o + 1], total = zero + one;
        const scaled = Math.floor(range / total);
        if (!scaled) throw new Error("mask payload has invalid coding state");
        let v = Math.floor(((code - low) >>> 0) / scaled);
        if (v >= total) v = total - 1;
        let bit;
        if (v < zero) { bit = 0; range = scaled * zero; }
        else { bit = 1; low = (low + scaled * zero) >>> 0; range = scaled * one; }
        for (;;) {
          if (((low ^ ((low + range) >>> 0)) >>> 0) >= TOP) {
            if (range >= BOTTOM) break;
            range = ((-low) >>> 0) & (BOTTOM - 1);
          }
          code = ((code << 8) | (pos < n ? data[pos] : 0)) >>> 0;
          pos++;
          low = (low << 8) >>> 0;
          range = (range << 8) >>> 0;
        }
        if (bit) { pad[p] = 1; out[y * width + x] = 1; }
        counts[o + bit] = (counts[o + bit] + 14) & 0xffff;
        if (counts[o] + counts[o + 1] >= 4096) {
          counts[o] = (counts[o] >> 1) || 1;
          counts[o + 1] = (counts[o + 1] >> 1) || 1;
        }
      }
    }
    return out;
  }

  const FRAME = /^<(\d+)f>/;
  const RECORD = /(\d+)<\|box;x1=(-?\d+);y1=(-?\d+);x2=(-?\d+);y2=(-?\d+);w=(\d+);h=(\d+)\|><\|mask;x=0;y=0;data=(\d+),(\d+),([^|]+)\|>/g;

  // One line -> { frame, records: [{ id, x1, y1, x2, y2, w, h, mw, mh, payload }] } or null.
  function parseLine(line) {
    const m = FRAME.exec(line || "");
    if (!m) return null;
    const records = [];
    RECORD.lastIndex = m[0].length;
    let r;
    while ((r = RECORD.exec(line))) {
      records.push({ id: +r[1], x1: +r[2], y1: +r[3], x2: +r[4], y2: +r[5], w: +r[6], h: +r[7],
        mh: +r[8], mw: +r[9], payload: r[10] });
    }
    return { frame: +m[1], records };
  }

  // Whole .sam text -> Map(frame -> records). Frames with nothing visible have no line.
  function parseTrack(text) {
    const frames = new Map();
    for (const line of String(text || "").split("\n")) {
      const p = line ? parseLine(line) : null;
      if (p && p.records.length) frames.set(p.frame, p.records);
    }
    return frames;
  }

  return { decodeMask, parseLine, parseTrack };
})();
if (typeof module !== "undefined") module.exports = samCodec;
