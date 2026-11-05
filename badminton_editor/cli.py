"""Command line: track a rally with SAM 3.1, then open the result in the web editor.

    python -m badminton_editor track match.mp4 --start 12 --end 27 --out rally01
    python -m badminton_editor inspect rally01

`track` cuts the window you ask for (default: the whole video) to an H.264 clip at
--height and --fps, uploads it to the Meta Model API, runs one SAM 3.1 pass per
concept, and writes into --out:

    clip.mp4          the exact clip SAM saw (frame N of the masks = frame N of this clip)
    <concept>.sam     SAM's wire lines, one per frame, stored verbatim
    meta.json         fps, size, concepts, and the P1..P4 guess for the people track

Open web/index.html and drop those files (plus a match.json for the score) on it.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from . import codec, players, sam31


def _load_dotenv(path: Path = Path(".env")) -> None:
    """Tiny .env reader so the key can live in an ignored file, never in code."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def _probe_duration(path: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "default=nw=1:nk=1", str(path)],
                         capture_output=True, text=True, check=True).stdout.strip()
    return float(out)


def _cut(src: Path, dst: Path, start: float, end: float, height: int, fps: int) -> None:
    cmd = ["ffmpeg", "-v", "error", "-y", "-ss", f"{start:.3f}", "-i", str(src), "-t", f"{end - start:.3f}",
           "-vf", f"scale=-2:{height},fps={fps}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
           "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(dst)]
    subprocess.run(cmd, check=True)


def _key(concept: str) -> str:
    return "".join(ch if ch.isalnum() else "_" for ch in concept.strip().lower())


def cmd_track(a: argparse.Namespace) -> int:
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        print("ffmpeg and ffprobe are required", file=sys.stderr)
        return 2
    src = Path(a.video)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    dur = _probe_duration(src)
    start = max(0.0, a.start or 0.0)
    end = min(dur, a.end) if a.end else dur
    if end <= start:
        print("--end must be after --start", file=sys.stderr)
        return 2
    frames = int(round((end - start) * a.fps))
    usd = sam31.estimate_usd(frames, len(a.concept))
    print(f"{end - start:.1f} s at {a.fps} fps = {frames} frames x {len(a.concept)} concept(s) "
          f"= about ${usd:.2f} on the Meta Model API")
    if usd > a.max_usd:
        print(f"over --max-usd {a.max_usd}; pick a shorter window or raise the limit", file=sys.stderr)
        return 3
    clip = out / "clip.mp4"
    _cut(src, clip, start, end, a.height, a.fps)
    meta = {"clip": clip.name, "source": src.name, "start": start, "end": end, "fps": a.fps,
            "model": sam31.model(), "concepts": {}, "players": {}}
    fid = sam31.upload_video(clip)
    try:
        for i, concept in enumerate(a.concept):
            t = time.time()
            lines, usage = sam31.stream_segmentation(fid, concept)
            path = out / f"{_key(concept)}.sam"
            path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            summ = codec.summarize(lines)
            meta["size"] = meta.get("size") or summ["size"]
            meta["concepts"][_key(concept)] = {"prompt": concept, "file": path.name, "frames_with_masks": len(lines),
                                              "objects": len(summ["objects"]), "usage": usage,
                                              "seconds": round(time.time() - t, 1)}
            if i == 0:  # the first concept is the people track
                roles = players.assign(summ["objects"], total_frames=frames)
                meta["players"] = {str(oid): name for oid, name in sorted(roles.items(), key=lambda kv: kv[1])}
            print(f"{concept!r}: {len(summ['objects'])} objects in {len(lines)} frames ({time.time() - t:.1f} s)")
    finally:
        sam31.delete_file(fid)
    (out / "meta.json").write_text(json.dumps(meta, indent=2))
    print(f"players (SAM id -> name): {meta['players'] or 'none found'}")
    print(f"wrote {out}/ : open web/index.html and drop clip.mp4, the .sam file(s), meta.json and a match.json")
    return 0


def cmd_inspect(a: argparse.Namespace) -> int:
    folder = Path(a.folder)
    meta = json.loads((folder / "meta.json").read_text()) if (folder / "meta.json").exists() else {}
    names = meta.get("players") or {}
    for sam_file in sorted(folder.glob("*.sam")):
        lines = sam_file.read_text(encoding="utf-8").splitlines()
        summ = codec.summarize(lines)
        print(f"{sam_file.name}: frame size {summ['size']}, {len(summ['objects'])} objects")
        for oid, o in sorted(summ["objects"].items(), key=lambda kv: -len(kv[1]["frames"])):
            b = o["boxes"][len(o["boxes"]) // 2]
            print(f"  id {oid:>3}  {names.get(str(oid), '--'):>3}  frames {len(o['frames']):>4}  "
                  f"first {min(o['frames']):>4}  last {max(o['frames']):>4}  "
                  f"mid box ({b[0]:.2f}, {b[1]:.2f}, {b[2]:.2f}, {b[3]:.2f})")
    return 0


def main(argv: list[str] | None = None) -> int:
    _load_dotenv()
    p = argparse.ArgumentParser(prog="badminton_editor", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("track", help="segment and track people (and more) in a rally with SAM 3.1")
    t.add_argument("video")
    t.add_argument("--start", type=float, default=0.0, help="window start in seconds")
    t.add_argument("--end", type=float, default=None, help="window end in seconds")
    t.add_argument("--concept", action="append", default=None,
                   help='noun phrase to segment; repeatable. Default: "person" then "badminton racket"')
    t.add_argument("--height", type=int, default=720)
    t.add_argument("--fps", type=int, default=30)
    t.add_argument("--max-usd", type=float, default=1.0, help="refuse to run above this estimate")
    t.add_argument("--out", default="rally")
    t.set_defaults(fn=cmd_track)
    i = sub.add_parser("inspect", help="list the objects in a tracked folder")
    i.add_argument("folder")
    i.set_defaults(fn=cmd_inspect)
    a = p.parse_args(argv)
    if getattr(a, "concept", "unset") is None:
        a.concept = ["person", "badminton racket"]
    return a.fn(a)


if __name__ == "__main__":
    raise SystemExit(main())
