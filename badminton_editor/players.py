"""Name the people SAM found: who is P1, P2, P3, P4.

SAM answers "person" with everyone in the hall: the four players, people on the
next court, someone walking past. The players are the people who stay in frame
for most of the clip and are large in it. Looking down the court from behind a
baseline, the near pair stands lower in the frame:

    P1 = near left, P2 = near right, P3 = far left, P4 = far right

For singles the near player is P1 and the far player is P3. Everyone else is left
unnamed, and the editor can blur them out. The editor lets you reassign any id by
hand, so a wrong guess here costs one click.
"""
from __future__ import annotations


def _median(vals: list[float]) -> float:
    s = sorted(vals)
    return s[len(s) // 2] if s else 0.0


def assign(objects: dict[int, dict], total_frames: int | None = None,
           players: int = 4, min_presence: float = 0.35) -> dict[int, str]:
    """`objects` is `codec.summarize(...)["objects"]`. Returns {sam id: "P1".."P4"}."""
    if not objects:
        return {}
    total = total_frames or max(max(o["frames"]) for o in objects.values()) + 1
    scored = []
    for oid, o in objects.items():
        presence = len(set(o["frames"])) / max(1, total)
        if presence < min_presence:
            continue
        area = _median([(b[2] - b[0]) * (b[3] - b[1]) for b in o["boxes"]])
        scored.append((presence * area, oid))
    top = [oid for _, oid in sorted(scored, reverse=True)[:players]]
    if not top:
        return {}
    feet = {oid: _median([b[3] for b in objects[oid]["boxes"]]) for oid in top}
    cx = {oid: _median([(b[0] + b[2]) / 2 for b in objects[oid]["boxes"]]) for oid in top}
    by_depth = sorted(top, key=lambda oid: -feet[oid])          # nearest (lowest in frame) first
    if len(by_depth) <= 2:
        names = ["P1", "P3"]
        return {oid: names[i] for i, oid in enumerate(by_depth)}
    near = sorted(by_depth[:2], key=lambda oid: cx[oid])
    far = sorted(by_depth[2:], key=lambda oid: cx[oid])
    roles = {near[0]: "P1", near[1]: "P2"}
    for oid, name in zip(far, ["P3", "P4"]):
        roles[oid] = name
    return roles
