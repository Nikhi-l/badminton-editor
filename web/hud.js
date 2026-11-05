/* Match HUD: title banner, rally clock, P1-P4 scoreboards, team score, last shot,
   and the frame of the player focus inset. Pure Canvas 2D, laid out on a 1920x1080
   grid and scaled to whatever the video is.

   Everything shown comes from match.json (see examples/match.json). A value that is
   not in the file is left off, never made up: no km/h unless a shot carries one. */
const hud = (() => {
  const COLORS = { P1: "#C6FF3D", P2: "#3DFFB8", P3: "#5AC8FA", P4: "#B18CFF" };
  const THEMES = {
    broadcast: { panel: "rgba(8,12,10,0.74)", stroke: "rgba(198,255,61,0.55)", accent: "#C6FF3D",
      text: "#FFFFFF", sub: "#B9C7BF", font: "Inter, system-ui, -apple-system, sans-serif", glow: 0, radius: 14 },
    neon: { panel: "rgba(18,6,34,0.62)", stroke: "#E040FB", accent: "#E040FB",
      text: "#FFFFFF", sub: "#9BE7FF", font: "Inter, system-ui, -apple-system, sans-serif", glow: 18, radius: 18 },
    led: { panel: "rgba(0,0,0,0.86)", stroke: "#5A3E00", accent: "#FFB300",
      text: "#FFC94D", sub: "#C08A1E", font: "'Courier New', ui-monospace, Menlo, monospace", glow: 8, radius: 4 },
  };
  const PLAYERS = ["P1", "P2", "P3", "P4"];

  /* ---------- data: the state of the match at time t ---------- */
  function stateAt(m, t) {
    m = m || {};
    const info = m.players || {};
    const teamOf = (p) => (info[p] || {}).team || (p === "P1" || p === "P2" ? "A" : "B");
    const score = { A: +((m.start_score || {}).A || 0), B: +((m.start_score || {}).B || 0) };
    const stats = {};
    PLAYERS.forEach((p) => (stats[p] = { shots: 0, smashes: 0, winners: 0, top: 0 }));
    let rally = null, lastRally = null, rallyNo = (m.first_rally || 1) - 1, last = null;
    let server = m.first_server || null;
    const rallies = (m.rallies || []).slice().sort((a, b) => a.start - b.start);
    for (const r of rallies) {
      if (r.start > t) break;
      rallyNo++;
      const live = t <= r.end;
      if (live) rally = r; else lastRally = r;
      if (r.server) server = r.server;
      for (const s of r.shots || []) {
        if (s.t > t) break;
        const st = stats[s.by];
        if (!st) continue;
        st.shots++;
        if (s.stroke === "smash") st.smashes++;
        if (s.kmh) st.top = Math.max(st.top, s.kmh);
        last = s;
      }
      if (!live && r.winner) {
        score[r.winner]++;
        const fin = (r.shots || []).filter((s) => s.by && teamOf(s.by) === r.winner).pop();
        if (fin && stats[fin.by]) stats[fin.by].winners++;
        server = r.winner;  // in badminton the side that wins the rally serves next
      }
    }
    return { score, stats, rally, lastRally, rallyNo, last, server, teamOf, t,
      title: m.title || "BADDYAI MATCH HUD", subtitle: m.subtitle || "", game: m.game || null,
      target: m.points_to_win || 21, names: Object.fromEntries(PLAYERS.map((p) => [p, (info[p] || {}).name || ""])) };
  }

  /* ---------- drawing helpers ---------- */
  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function panel(ctx, th, s, x, y, w, h, stroke) {
    ctx.save();
    rr(ctx, x, y, w, h, th.radius * s);
    ctx.fillStyle = th.panel;
    ctx.fill();
    ctx.lineWidth = 2 * s;
    ctx.strokeStyle = stroke || th.stroke;
    if (th.glow) { ctx.shadowColor = stroke || th.stroke; ctx.shadowBlur = th.glow * s; }
    ctx.stroke();
    ctx.restore();
  }
  function text(ctx, th, s, str, x, y, size, { color, weight = 700, align = "left", glow = false, spacing = 0 } = {}) {
    ctx.save();
    ctx.font = `${weight} ${Math.round(size * s)}px ${th.font}`;
    ctx.textAlign = align;
    ctx.textBaseline = "alphabetic";
    if ("letterSpacing" in ctx) ctx.letterSpacing = `${spacing * s}px`;
    ctx.fillStyle = color || th.text;
    if (glow && th.glow) { ctx.shadowColor = color || th.accent; ctx.shadowBlur = th.glow * s; }
    ctx.fillText(str, x, y);
    ctx.restore();
  }
  const clock = (sec) => {
    sec = Math.max(0, sec);
    const m = Math.floor(sec / 60), r = sec - m * 60;
    return `${String(m).padStart(2, "0")}:${r.toFixed(1).padStart(4, "0")}`;
  };
  const STROKE_NAMES = { smash: "SMASH", clear: "CLEAR", drop: "DROP", drive: "DRIVE", lift: "LIFT",
    net_shot: "NET SHOT", net: "NET SHOT", block: "BLOCK", push: "PUSH", serve: "SERVE", kill: "KILL" };

  /* ---------- the HUD ---------- */
  function draw(ctx, W, H, st, themeName = "broadcast", opts = {}) {
    const th = THEMES[themeName] || THEMES.broadcast;
    const s = H / 1080;
    const M = 36 * s;

    // title banner
    const bw = 760 * s, bh = st.subtitle ? 96 * s : 70 * s, bx = (W - bw) / 2, by = 26 * s;
    panel(ctx, th, s, bx, by, bw, bh);
    text(ctx, th, s, st.title, W / 2, by + 48 * s, 38, { color: th.accent, align: "center", weight: 800, glow: true, spacing: 2 });
    if (st.subtitle) text(ctx, th, s, st.subtitle, W / 2, by + 82 * s, 21, { color: th.sub, align: "center", weight: 600, spacing: 1.5 });

    // rally clock (top left)
    const r = st.rally || st.lastRally;
    if (r) {
      const live = !!st.rally;
      const dur = live ? st.t - r.start : r.end - r.start;
      const shots = (r.shots || []).filter((x) => x.t <= st.t).length;
      panel(ctx, th, s, M, by, 330 * s, 96 * s);
      text(ctx, th, s, live ? `RALLY ${st.rallyNo}` : `RALLY ${st.rallyNo} DONE`, M + 22 * s, by + 34 * s, 20, { color: th.sub, weight: 700, spacing: 1.5 });
      text(ctx, th, s, clock(dur), M + 22 * s, by + 80 * s, 40, { color: th.text, weight: 800, glow: true });
      text(ctx, th, s, `${shots} SHOTS`, M + 308 * s, by + 80 * s, 20, { color: th.accent, align: "right", weight: 700 });
    }

    // scoreboards (bottom)
    const cw = 300 * s, ch = 150 * s, gap = 14 * s, cy = H - M - ch;
    const xs = { P1: M, P2: M + cw + gap, P3: W - M - 2 * cw - gap, P4: W - M - cw };
    for (const p of PLAYERS) card(ctx, th, s, xs[p], cy, cw, ch, p, st);

    // team score (bottom centre)
    const cx0 = M + 2 * cw + 2 * gap, cx1 = W - M - 2 * cw - 2 * gap, sw = cx1 - cx0;
    if (sw > 200 * s) {
      panel(ctx, th, s, cx0, cy, sw, ch);
      const mid = cx0 + sw / 2;
      text(ctx, th, s, String(st.score.A), mid - 26 * s, cy + 104 * s, 92, { color: COLORS.P1, align: "right", weight: 800, glow: true });
      text(ctx, th, s, ":", mid, cy + 96 * s, 64, { color: th.sub, align: "center", weight: 700 });
      text(ctx, th, s, String(st.score.B), mid + 26 * s, cy + 104 * s, 92, { color: COLORS.P3, align: "left", weight: 800, glow: true });
      text(ctx, th, s, "P1 + P2", cx0 + 18 * s, cy + 32 * s, 17, { color: th.sub, weight: 700, spacing: 1 });
      text(ctx, th, s, "P3 + P4", cx1 - 18 * s, cy + 32 * s, 17, { color: th.sub, align: "right", weight: 700, spacing: 1 });
      const foot = [st.game ? `GAME ${st.game}` : "", `TO ${st.target}`].filter(Boolean).join("  ·  ");
      text(ctx, th, s, foot, mid, cy + 136 * s, 16, { color: th.sub, align: "center", weight: 600, spacing: 1.5 });
      if (st.server) {
        const team = st.server === "A" || st.server === "B" ? st.server : st.teamOf(st.server);
        const sx = team === "A" ? cx0 + 18 * s : cx1 - 18 * s;
        text(ctx, th, s, "SERVE", sx, cy + 136 * s, 15, { color: th.accent, align: team === "A" ? "left" : "right", weight: 800, spacing: 1 });
      }
    }

    // last shot ticker
    if (st.last && st.t - st.last.t < 1.6 && st.last.by) {
      const name = STROKE_NAMES[st.last.stroke] || String(st.last.stroke || "SHOT").toUpperCase();
      const label = [st.last.by, name, st.last.kmh ? `${Math.round(st.last.kmh)} KM/H` : ""].filter(Boolean).join("  ·  ");
      const tw = Math.max(300 * s, label.length * 15 * s + 60 * s), tx = (W - tw) / 2, ty = cy - 70 * s;
      const a = Math.min(1, (1.6 - (st.t - st.last.t)) / 0.4);
      ctx.save();
      ctx.globalAlpha = a;
      panel(ctx, th, s, tx, ty, tw, 52 * s, COLORS[st.last.by]);
      text(ctx, th, s, label, W / 2, ty + 35 * s, 24, { color: COLORS[st.last.by] || th.accent, align: "center", weight: 800, glow: true, spacing: 1 });
      ctx.restore();
    }
  }

  function card(ctx, th, s, x, y, w, h, p, st) {
    const c = COLORS[p], stt = st.stats[p];
    panel(ctx, th, s, x, y, w, h, c);
    ctx.save();
    rr(ctx, x + 14 * s, y + 14 * s, 62 * s, 34 * s, 8 * s);
    ctx.fillStyle = c;
    ctx.fill();
    ctx.restore();
    text(ctx, th, s, p, x + 45 * s, y + 40 * s, 22, { color: "#0b0f0d", align: "center", weight: 800 });
    if (st.names[p]) text(ctx, th, s, st.names[p].toUpperCase(), x + 90 * s, y + 40 * s, 22, { color: th.text, weight: 700 });
    const row = (label, val, i) => {
      const yy = y + (78 + i * 30) * s;
      text(ctx, th, s, label, x + 18 * s, yy, 17, { color: th.sub, weight: 600, spacing: 1 });
      text(ctx, th, s, val, x + w - 18 * s, yy, 21, { color: th.text, align: "right", weight: 800 });
    };
    row("SHOTS", String(stt.shots), 0);
    row("SMASHES", String(stt.smashes), 1);
    row(stt.top ? "TOP SPEED" : "WINNERS", stt.top ? `${Math.round(stt.top)} km/h` : String(stt.winners), 2);
  }

  /* The inset frame; the editor paints the zoomed player into `rect` first. */
  function insetFrame(ctx, W, H, themeName, p, rect, caption) {
    const th = THEMES[themeName] || THEMES.broadcast;
    const s = H / 1080;
    const c = COLORS[p] || th.accent;
    ctx.save();
    rr(ctx, rect.x, rect.y, rect.w, rect.h, th.radius * s);
    ctx.lineWidth = 3 * s;
    ctx.strokeStyle = c;
    if (th.glow) { ctx.shadowColor = c; ctx.shadowBlur = th.glow * s; }
    ctx.stroke();
    ctx.restore();
    const lh = 38 * s;
    ctx.save();
    rr(ctx, rect.x, rect.y, rect.w, lh, th.radius * s);
    ctx.fillStyle = th.panel;
    ctx.fill();
    ctx.restore();
    text(ctx, th, s, `PLAYER FOCUS  ·  ${p}`, rect.x + 16 * s, rect.y + 26 * s, 18, { color: c, weight: 800, spacing: 1.5 });
    if (caption) {
      ctx.save();
      rr(ctx, rect.x, rect.y + rect.h - lh, rect.w, lh, th.radius * s);
      ctx.fillStyle = th.panel;
      ctx.fill();
      ctx.restore();
      text(ctx, th, s, caption, rect.x + rect.w / 2, rect.y + rect.h - 12 * s, 18, { color: th.text, align: "center", weight: 700, spacing: 1 });
    }
  }
  function insetRect(W, H) {
    const s = H / 1080;
    const w = 420 * s, h = 300 * s;
    return { x: W - 36 * s - w, y: 26 * s, w, h };
  }

  return { COLORS, THEMES, PLAYERS, stateAt, draw, insetFrame, insetRect, clock };
})();
if (typeof module !== "undefined") module.exports = hud;
