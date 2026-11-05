"""Generate HUD design concepts with Meta Muse Image (muse-image-1.0) on the Meta Model API.

    python tools/muse_hud_concepts.py docs/hud-concepts

Reads META_MODEL_API_KEY from the environment (or .env). About $0.01 an image when
this was written. The pictures are concepts: the players, venue and numbers in them
are generated, not match data. The editor's own HUD (web/hud.js) draws real values
from match.json.
"""
import base64
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

COMMON = ("16:9 widescreen video frame of an indoor badminton doubles match filmed from behind one baseline, "
          "four players on court, with a HUD overlay drawn on top. The HUD has: a title banner reading "
          "'BADDYAI MATCH HUD', four player scoreboards labelled only P1, P2, P3 and P4 (team P1+P2 versus "
          "team P3+P4) each with the game score and small stats (smashes, rally wins, shuttle speed), a rally "
          "counter and rally timer, and a picture-in-picture player focus inset that zooms on P1 with a glowing "
          "segmentation outline. No real names, no faces in the scoreboards, no brand logos or sponsor boards, "
          "text only in English. ")
STYLES = {
    "01-broadcast-glass": "Style: premium TV sports broadcast, dark smoked-glass panels, crisp white numbers, lime green #C6FF3D accents, thin angular frames.",
    "02-neon-arcade": "Style: 8-bit arcade fighting game, pixel art panels, health-bar style score bars for each player, COMBO counter for the rally, chunky pixel font, bright magenta and cyan.",
    "03-telemetry-teal": "Style: minimal sports-science telemetry, thin teal lines on translucent black, small line graph of shuttle speed, top-down mini court map with shot trails, monospace numbers.",
    "04-neon-glow": "Style: cyberpunk neon night, glowing lime and violet outlines, players outlined with neon segmentation masks, holographic score cards, dark background vignette.",
    "05-esports-bold": "Style: esports tournament overlay, bold slanted team colour bars (orange team vs blue team), large score digits, player cards with stat bars, kill-feed style list of the last shots.",
    "06-retro-scoreboard": "Style: retro 1980s stadium scoreboard, amber dot-matrix LED digits on black panels, chunky bezels, warm glow, simple and readable.",
}


def key() -> str:
    if not os.environ.get("META_MODEL_API_KEY") and Path(".env").exists():
        for line in Path(".env").read_text().splitlines():
            if line.startswith("META_MODEL_API_KEY="):
                os.environ["META_MODEL_API_KEY"] = line.split("=", 1)[1].strip().strip('"').strip("'")
    k = os.environ.get("META_MODEL_API_KEY", "").strip()
    if not k:
        sys.exit("META_MODEL_API_KEY is not set")
    return k


def one(out: Path, name: str, style: str, headers: dict) -> str:
    base = os.environ.get("META_API_BASE", "https://api.meta.ai/v1").rstrip("/")
    body = {"model": "muse-image-1.0", "prompt": COMMON + style, "n": 1, "size": "1920x1080"}
    t = time.time()
    r = requests.post(f"{base}/images/generations", headers=headers, json=body, timeout=300)
    if r.status_code >= 300:
        return f"{name}: HTTP {r.status_code} {r.text[:200]}"
    j = r.json()
    d = j["data"][0]
    raw = base64.b64decode(d["b64_json"]) if d.get("b64_json") else requests.get(d["url"], timeout=120).content
    ext = j.get("output_format") or "webp"
    (out / f"{name}.{ext}").write_bytes(raw)
    (out / f"{name}.json").write_text(json.dumps({"model": body["model"], "prompt": body["prompt"],
                                                  "usage": j.get("usage")}, indent=2))
    return f"{name}: ok in {time.time() - t:.1f} s"


def main() -> None:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "hud-concepts")
    out.mkdir(parents=True, exist_ok=True)
    headers = {"Authorization": f"Bearer {key()}", "Content-Type": "application/json"}
    with ThreadPoolExecutor(6) as ex:
        for line in ex.map(lambda kv: one(out, kv[0], kv[1], headers), STYLES.items()):
            print(line)


if __name__ == "__main__":
    main()
