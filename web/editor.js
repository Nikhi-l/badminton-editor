/* Badminton Editor: SAM 3.1 masks + the match HUD over a badminton clip, in the browser.

   Per presented video frame (requestVideoFrameCallback, so picture and masks always
   come from the SAME frame) this file:
     1. decodes that frame's SAM 3.1 masks (sam-codec.js) into two layers at mask
        resolution: the named players P1-P4 (each in its colour) and everyone else,
     2. draws the frame, blurs everyone else, dims all but the players, adds a glow
        around each player,
     3. draws the HUD (hud.js) and the player focus inset.
   Export records the canvas while the clip plays once (MediaRecorder). */
(() => {
  const $ = (id) => document.getElementById(id);
  const video = $("video"), canvas = $("stage"), ctx = canvas.getContext("2d");
  const S = {
    people: null,                 // Map(frame -> records) of the people track
    extra: [],                    // [{ name, frames }] other tracks (racket, net...)
    fps: 30,
    match: null,
    roles: new Map(),             // sam id -> "P1".."P4"
    objects: [],                  // [{ id, frames, area, feet, cx }] for the players panel
    selected: null,
    fx: { spotlight: true, outline: true, hideOthers: true, objects: true, hud: true, inset: true },
    theme: "broadcast",
    focus: "P1",
    mw: 0, mh: 0,                 // mask (SAM) frame size
    lw: 0, lh: 0, q: 1,           // layer size: masks are composed at <= 960 px wide (q = layer px per mask px)
    bufs: null,                   // reused ImageData per layer
    rasters: new Map(),           // LRU "track:frame:id" -> Uint8Array
    exporting: false,
  };
  const layer = () => { const c = document.createElement("canvas"); return { c, x: c.getContext("2d", { willReadFrequently: true }) }; };
  const L = { players: layer(), others: layer(), extra: layer(), glow: layer(), work: layer(), dim: layer() };
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const RGB = Object.fromEntries(Object.entries(hud.COLORS).map(([k, v]) => [k, hex(v)]));

  /* ---------- loading ---------- */
  const status = (msg) => { $("status").textContent = msg || ""; };
  async function openFiles(list) {
    const files = [...list];
    const vid = files.find((f) => f.type.startsWith("video/") || /\.(mp4|mov|m4v|webm)$/i.test(f.name));
    const sams = files.filter((f) => /\.sam$/i.test(f.name));
    const jsons = files.filter((f) => /\.json$/i.test(f.name));
    for (const f of jsons) {
      let j;
      try { j = JSON.parse(await f.text()); } catch { status(`${f.name} is not valid JSON`); continue; }
      if (j.rallies || j.start_score || j.title) S.match = j;
      else if (j.concepts || j.players || j.fps) {
        if (j.fps) S.fps = +j.fps;
        S.metaRoles = Object.fromEntries(Object.entries(j.players || {}).map(([id, p]) => [+id, p]));
      }
    }
    if (sams.length) {
      const people = sams.find((f) => /person|player|people/i.test(f.name)) || sams[0];
      S.people = samCodec.parseTrack(await people.text());
      S.extra = [];
      for (const f of sams) if (f !== people) S.extra.push({ name: f.name.replace(/\.sam$/i, ""), frames: samCodec.parseTrack(await f.text()) });
      S.rasters.clear();
      analyse();
    } else if (S.people && jsons.length) {
      analyse();   // a meta.json dropped after the track: re-apply its names
    }
    if (vid) {
      if (video.src) URL.revokeObjectURL(video.src);
      video.src = URL.createObjectURL(vid);
      await new Promise((ok, bad) => { video.onloadeddata = ok; video.onerror = () => bad(new Error("this browser cannot play the video")); }).catch((e) => status(e.message));
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      $("empty").hidden = true;
      ["play", "seek", "export"].forEach((id) => ($(id).disabled = false));
    }
    status([vid && `video ${vid.name}`, S.people && `${S.objects.length} people tracked`, S.extra.length && `${S.extra.length} extra track(s)`,
      S.match && "match data"].filter(Boolean).join(" · "));
    render(video.currentTime || 0);
  }

  /* who is who: persistence x size picks the players, depth and left/right name them */
  function analyse() {
    const seen = new Map();
    let total = 0;
    for (const [k, recs] of S.people) {
      total = Math.max(total, k + 1);
      for (const r of recs) {
        S.mw = r.w; S.mh = r.h;
        const o = seen.get(r.id) || { id: r.id, frames: 0, areas: [], feet: [], cx: [] };
        o.frames++;
        o.areas.push(((r.x2 - r.x1 + 1) * (r.y2 - r.y1 + 1)) / (r.w * r.h));
        o.feet.push((r.y2 + 1) / r.h);
        o.cx.push((r.x1 + r.x2 + 1) / 2 / r.w);
        seen.set(r.id, o);
      }
    }
    const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1] || 0;
    S.objects = [...seen.values()].map((o) => ({ id: o.id, frames: o.frames, presence: o.frames / Math.max(1, total),
      area: med(o.areas), feet: med(o.feet), cx: med(o.cx) })).sort((a, b) => b.frames - a.frames);
    S.roles = new Map();
    if (S.metaRoles && Object.keys(S.metaRoles).length) {
      for (const [id, p] of Object.entries(S.metaRoles)) S.roles.set(+id, p);
    } else {
      const top = S.objects.filter((o) => o.presence >= 0.35).sort((a, b) => b.presence * b.area - a.presence * a.area).slice(0, 4);
      const depth = top.slice().sort((a, b) => b.feet - a.feet);
      if (depth.length <= 2) depth.forEach((o, i) => S.roles.set(o.id, i ? "P3" : "P1"));
      else {
        depth.slice(0, 2).sort((a, b) => a.cx - b.cx).forEach((o, i) => S.roles.set(o.id, i ? "P2" : "P1"));
        depth.slice(2).sort((a, b) => a.cx - b.cx).forEach((o, i) => S.roles.set(o.id, i ? "P4" : "P3"));
      }
    }
    S.q = S.mw > 960 ? 960 / S.mw : 1;
    S.lw = Math.round(S.mw * S.q); S.lh = Math.round(S.mh * S.q);
    for (const l of Object.values(L)) { l.c.width = S.lw; l.c.height = S.lh; }
    S.bufs = { players: L.players.x.createImageData(S.lw, S.lh), others: L.others.x.createImageData(S.lw, S.lh), extra: L.extra.x.createImageData(S.lw, S.lh) };
    renderPlayers();
  }

  function renderPlayers() {
    const box = $("players");
    if (!S.objects.length) { box.textContent = "No people in this track."; return; }
    box.classList.remove("muted");
    box.innerHTML = S.objects.slice(0, 24).map((o) => {
      const role = S.roles.get(o.id) || "";
      return `<div class="p${S.selected === o.id ? " sel" : ""}" data-id="${o.id}">
        <span><i class="sw" style="background:${role ? hud.COLORS[role] : "#555"}"></i>id ${o.id}
        <span class="muted">· in ${Math.round(o.presence * 100)}% of frames</span></span>
        <select data-role="${o.id}">${["", "P1", "P2", "P3", "P4"].map((p) => `<option value="${p}"${p === role ? " selected" : ""}>${p || "other"}</option>`).join("")}</select>
      </div>`;
    }).join("");
    box.querySelectorAll("select[data-role]").forEach((sel) => (sel.onchange = () => {
      const id = +sel.dataset.role, p = sel.value;
      for (const [k, v] of S.roles) if (p && v === p) S.roles.delete(k);   // one person per name
      if (p) S.roles.set(id, p); else S.roles.delete(id);
      S.selected = id;
      renderPlayers();
      render(video.currentTime);
    }));
  }

  /* ---------- masks ---------- */
  function raster(tag, k, r) {
    const key = `${tag}:${k}:${r.id}`;
    let m = S.rasters.get(key);
    if (!m) {
      try { m = samCodec.decodeMask(r.payload, r.mw, r.mh); } catch { m = new Uint8Array(r.mw * r.mh); }
      S.rasters.set(key, m);
      if (S.rasters.size > 600) S.rasters.delete(S.rasters.keys().next().value);
    }
    return m;
  }
  // paste one record into an RGBA layer buffer (layer px = mask px * S.q). Big objects come
  // back as a raster capped at 1024 px on the long side, smaller than their box, so the
  // raster is always sampled through the box, never pasted 1:1.
  function paste(buf, W, H, r, m, rgb, alpha = 255) {
    const q = S.q, bw = r.x2 - r.x1 + 1, bh = r.y2 - r.y1 + 1;
    const sx = r.mw / bw, sy = r.mh / bh;
    const y0 = Math.max(0, Math.floor(r.y1 * q)), y1 = Math.min(H, Math.ceil((r.y2 + 1) * q));
    const x0 = Math.max(0, Math.floor(r.x1 * q)), x1 = Math.min(W, Math.ceil((r.x2 + 1) * q));
    for (let y = y0; y < y1; y++) {
      const my = Math.min(r.mh - 1, Math.max(0, Math.floor(((y + 0.5) / q - r.y1) * sy))) * r.mw;
      let o = (y * W + x0) * 4;
      for (let x = x0; x < x1; x++, o += 4) {
        if (m[my + Math.min(r.mw - 1, Math.max(0, Math.floor(((x + 0.5) / q - r.x1) * sx)))]) {
          buf[o] = rgb[0]; buf[o + 1] = rgb[1]; buf[o + 2] = rgb[2]; buf[o + 3] = alpha;
        }
      }
    }
  }
  function buildLayers(k) {
    const W = S.lw, H = S.lh;
    const pl = S.bufs.players, ot = S.bufs.others, ex = S.bufs.extra;
    pl.data.fill(0); ot.data.fill(0); ex.data.fill(0);
    const boxes = {};
    for (const r of S.people.get(k) || []) {
      const role = S.roles.get(r.id);
      paste(role ? pl.data : ot.data, W, H, r, raster("p", k, r), role ? RGB[role] : [255, 255, 255]);
      if (role) boxes[role] = r;
    }
    if (S.fx.objects) S.extra.forEach((t, i) => { for (const r of t.frames.get(k) || []) paste(ex.data, W, H, r, raster(`e${i}`, k, r), [255, 255, 255], 255); });
    L.players.x.putImageData(pl, 0, 0);
    L.others.x.putImageData(ot, 0, 0);
    L.extra.x.putImageData(ex, 0, 0);
    return boxes;
  }

  /* ---------- one frame ---------- */
  function render(t) {
    const W = canvas.width, H = canvas.height;
    if (!video.src) return;
    ctx.drawImage(video, 0, 0, W, H);
    const k = Math.round(t * S.fps);
    let boxes = {};
    if (S.people && S.mw) {
      boxes = buildLayers(k);
      const blurPx = Math.max(2, Math.round(W / 320));
      if (S.fx.hideOthers) {
        const w = L.work;
        w.x.globalCompositeOperation = "source-over";
        w.x.clearRect(0, 0, S.lw, S.lh);
        w.x.filter = `blur(${Math.round(S.lw / 90)}px)`;
        w.x.drawImage(video, 0, 0, S.lw, S.lh);
        w.x.filter = "none";
        w.x.globalCompositeOperation = "destination-in";
        w.x.filter = `blur(${Math.max(1, Math.round(S.lw / 400))}px)`;
        w.x.drawImage(L.others.c, 0, 0);
        w.x.filter = "none";
        w.x.globalCompositeOperation = "source-over";
        ctx.drawImage(w.c, 0, 0, W, H);
      }
      if (S.fx.spotlight && S.roles.size) {
        const d = L.dim;
        d.x.globalCompositeOperation = "source-over";
        d.x.clearRect(0, 0, S.lw, S.lh);
        d.x.fillStyle = "rgba(0,0,0,0.5)";
        d.x.fillRect(0, 0, S.lw, S.lh);
        d.x.globalCompositeOperation = "destination-out";
        d.x.filter = `blur(${Math.max(1, Math.round(S.lw / 300))}px)`;
        d.x.drawImage(L.players.c, 0, 0);
        if (S.fx.objects) d.x.drawImage(L.extra.c, 0, 0);
        d.x.filter = "none";
        d.x.globalCompositeOperation = "source-over";
        ctx.drawImage(d.c, 0, 0, W, H);
      }
      if (S.fx.outline) {
        glow(L.players.c, Math.round(S.lw / 200));
        ctx.drawImage(L.glow.c, 0, 0, W, H);
        ctx.drawImage(L.glow.c, 0, 0, W, H);
        ctx.save(); ctx.globalAlpha = 0.16; ctx.drawImage(L.players.c, 0, 0, W, H); ctx.restore();
        if (S.fx.objects && S.extra.length) { glow(L.extra.c, Math.round(S.lw / 320)); ctx.drawImage(L.glow.c, 0, 0, W, H); }
      }
      if (S.selected != null) outlineBox(k, blurPx);
    }
    const st = hud.stateAt(S.match, t);
    if (S.fx.inset && boxes[S.focus]) inset(boxes[S.focus], st);
    if (S.fx.hud) hud.draw(ctx, W, H, st, S.theme);
    $("clock").textContent = hud.clock(t);
    if (!S.dragging && video.duration) $("seek").value = String(Math.round((t / video.duration) * 1000));
  }
  // a soft halo outside the mask: blur it, then cut the mask itself out
  function glow(src, px) {
    const g = L.glow;
    g.x.globalCompositeOperation = "source-over";
    g.x.clearRect(0, 0, S.lw, S.lh);
    g.x.filter = `blur(${Math.max(1, px)}px)`;
    g.x.drawImage(src, 0, 0);
    g.x.filter = "none";
    g.x.globalCompositeOperation = "destination-out";
    g.x.drawImage(src, 0, 0);
    g.x.globalCompositeOperation = "source-over";
  }
  function outlineBox(k, px) {
    const r = (S.people.get(k) || []).find((x) => x.id === S.selected);
    if (!r) return;
    const sx = canvas.width / S.mw, sy = canvas.height / S.mh;
    ctx.save();
    ctx.setLineDash([8 * sx, 6 * sx]);
    ctx.lineWidth = px;
    ctx.strokeStyle = "#ffffff";
    ctx.strokeRect(r.x1 * sx, r.y1 * sy, (r.x2 - r.x1 + 1) * sx, (r.y2 - r.y1 + 1) * sy);
    ctx.restore();
  }
  function inset(r, st) {
    const W = canvas.width, H = canvas.height, rect = hud.insetRect(W, H);
    const vx = video.videoWidth / S.mw, vy = video.videoHeight / S.mh;
    // crop around the player, padded, at the inset's aspect ratio
    const cx = (r.x1 + r.x2 + 1) / 2 * vx, cy = (r.y1 + r.y2 + 1) / 2 * vy;
    let ch = (r.y2 - r.y1 + 1) * vy * 1.5, cw = ch * (rect.w / rect.h);
    cw = Math.max(cw, (r.x2 - r.x1 + 1) * vx * 1.6); ch = cw * (rect.h / rect.w);
    const x = Math.min(Math.max(0, cx - cw / 2), video.videoWidth - cw), y = Math.min(Math.max(0, cy - ch / 2), video.videoHeight - ch);
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    ctx.fillStyle = "#000";
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.drawImage(video, x, y, cw, ch, rect.x, rect.y, rect.w, rect.h);
    if (S.mw) {   // the same player's glow, zoomed with the picture
      glow(L.players.c, Math.max(1, Math.round(S.lw / 300)));
      ctx.drawImage(L.glow.c, (x / vx) * S.q, (y / vy) * S.q, (cw / vx) * S.q, (ch / vy) * S.q, rect.x, rect.y, rect.w, rect.h);
    }
    ctx.restore();
    const p = st.stats[S.focus];
    const cap = p ? [`SHOTS ${p.shots}`, `SMASHES ${p.smashes}`, p.top ? `TOP ${Math.round(p.top)} KM/H` : ""].filter(Boolean).join("  ·  ") : "";
    hud.insetFrame(ctx, W, H, S.theme, S.focus, rect, cap);
  }

  /* ---------- playback ---------- */
  function loop() {
    const step = (now, md) => {
      render(md ? md.mediaTime : video.currentTime);
      if (!video.paused && !video.ended) schedule();
    };
    const schedule = () => (video.requestVideoFrameCallback ? video.requestVideoFrameCallback(step) : requestAnimationFrame(() => step()));
    schedule();
  }
  video.addEventListener("play", () => { $("play").textContent = "Pause"; loop(); });
  video.addEventListener("pause", () => { $("play").textContent = "Play"; render(video.currentTime); });
  video.addEventListener("seeked", () => render(video.currentTime));
  $("play").onclick = () => (video.paused ? video.play() : video.pause());
  $("seek").addEventListener("input", (e) => { S.dragging = true; video.currentTime = (+e.target.value / 1000) * (video.duration || 0); });
  $("seek").addEventListener("change", () => (S.dragging = false));

  /* ---------- controls ---------- */
  document.querySelectorAll("[data-fx]").forEach((cb) => (cb.onchange = () => { S.fx[cb.dataset.fx] = cb.checked; render(video.currentTime); }));
  $("theme").onchange = (e) => { S.theme = e.target.value; render(video.currentTime); };
  $("focus").onchange = (e) => { S.focus = e.target.value; render(video.currentTime); };
  $("files").onchange = (e) => openFiles(e.target.files);
  const drop = $("drop");
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("drag"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("drag"); openFiles(e.dataTransfer.files); });

  // click a person: select their id in the Players panel
  canvas.addEventListener("click", (e) => {
    if (!S.people || !S.mw) return;
    const b = canvas.getBoundingClientRect();
    const scale = Math.min(b.width / canvas.width, b.height / canvas.height);
    const ox = (b.width - canvas.width * scale) / 2, oy = (b.height - canvas.height * scale) / 2;
    const mx = ((e.clientX - b.left - ox) / scale) * (S.mw / canvas.width), my = ((e.clientY - b.top - oy) / scale) * (S.mh / canvas.height);
    const k = Math.round(video.currentTime * S.fps);
    const hit = (S.people.get(k) || []).filter((r) => mx >= r.x1 && mx <= r.x2 && my >= r.y1 && my <= r.y2)
      .find((r) => raster("p", k, r)[Math.floor(((my - r.y1) / (r.y2 - r.y1 + 1)) * r.mh) * r.mw + Math.floor(((mx - r.x1) / (r.x2 - r.x1 + 1)) * r.mw)]);
    S.selected = hit ? hit.id : null;
    renderPlayers();
    render(video.currentTime);
    if (hit) status(`Selected id ${hit.id}: name them in the Players panel`);
  });

  /* ---------- export ---------- */
  $("export").onclick = async () => {
    if (S.exporting || !video.src) return;
    const types = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm"];
    const mimeType = types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
    if (!mimeType) { status("This browser cannot record a canvas. Try Chrome."); return; }
    S.exporting = true;
    $("export").disabled = true;
    const stream = canvas.captureStream(S.fps);
    try { const vs = video.captureStream ? video.captureStream() : null; if (vs) vs.getAudioTracks().forEach((t) => stream.addTrack(t)); } catch { /* no audio */ }
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12e6 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise((ok) => (rec.onstop = ok));
    video.pause();
    video.currentTime = 0;
    await new Promise((ok) => video.addEventListener("seeked", ok, { once: true }));
    const wasMuted = video.muted;
    video.muted = false;
    rec.start(250);
    status("Recording: the clip plays once...");
    await video.play();
    await new Promise((ok) => video.addEventListener("ended", ok, { once: true }));
    rec.stop();
    await done;
    video.muted = wasMuted;
    const blob = new Blob(chunks, { type: mimeType.split(";")[0] });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `badminton-hud.${mimeType.includes("mp4") ? "mp4" : "webm"}`;
    a.click();
    S.exporting = false;
    $("export").disabled = false;
    status(`Exported ${(blob.size / 1e6).toFixed(1)} MB`);
  };

  window.badmintonEditor = { openFiles, render, state: S };   // handy from the console and for tests
})();
