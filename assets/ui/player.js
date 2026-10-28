// screencast-mcp review player script (#128). Kept out of player.html so ESLint
// sees it (#243); reviewRecording.ts inlines it into the page when served, as
// the host's CSP allows no separate fetch.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const PROTOCOL = "2026-01-26";

  // --- JSON-RPC over postMessage with the host ---------------------------
  let nextId = 1;
  const pending = new Map();
  const send = (msg) => window.parent.postMessage({ jsonrpc: "2.0", ...msg }, "*");
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  const notify = (method, params) => send({ method, params });

  window.addEventListener("message", (e) => {
    if (e.source !== window.parent) return;
    const m = e.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && !m.method) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message || "request failed"));
      else p.resolve(m.result);
      return;
    }
    if (m.id !== undefined) {
      // A request from the host.
      if (m.method === "ui/resource-teardown" || m.method === "ping") send({ id: m.id, result: {} });
      else send({ id: m.id, error: { code: -32601, message: `Unsupported: ${m.method}` } });
      return;
    }
    if (m.method === "ui/notifications/tool-input") onToolInput(m.params?.arguments || {});
    else if (m.method === "ui/notifications/tool-result") onToolResult(m.params || {});
    else if (m.method === "ui/notifications/host-context-changed") applyHostContext(m.params || {});
    else if (m.method === "ui/notifications/tool-cancelled") setEmpty("The tool call was cancelled.");
  });

  const applyHostContext = (ctx) => {
    if (ctx && (ctx.theme === "light" || ctx.theme === "dark")) document.documentElement.dataset.theme = ctx.theme;
  };
  const callTool = async (name, args) => {
    const r = await request("tools/call", { name, arguments: args });
    if (r && r.isError) throw new Error((r.content || []).map((c) => c.text).filter(Boolean).join(" ") || `${name} failed`);
    return r;
  };
  const resultJson = (r) => {
    const t = (r?.content || []).find((c) => c.type === "text");
    try { return t ? JSON.parse(t.text) : null; } catch { return null; }
  };

  // --- state ---------------------------------------------------------------
  // Frames sit at their real times (#232): an even grid plus scene changes,
  // so frame i shows [times[i], end(i)) and the timeline maps by time.
  const S = { input: null, duration: 0, W: 0, H: 0, frames: [], times: [], scene: new Set(), i: 0, inI: 0, outI: 0, boxes: [], drawing: false, playing: null, result: null };
  const fmt = (t) => { const m = Math.floor(t / 60), s = t - m * 60; return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`; };
  const end = (i) => (i + 1 < S.times.length ? S.times[i + 1] : S.duration);
  const pct = (t) => (S.duration > 0 ? Math.max(0, Math.min(100, (t / S.duration) * 100)) : 0);
  /** The frame showing time t: the last one starting at or before it. */
  const frameAt = (t) => {
    let i = 0;
    while (i + 1 < S.times.length && S.times[i + 1] <= t) i++;
    return i;
  };
  const setEmpty = (text) => { $("empty").textContent = text; $("empty").hidden = false; };
  const status = (text, kind) => { const s = $("status"); s.textContent = text; s.className = kind || ""; };

  function onToolInput(args) {
    if (args.input) $("file").textContent = args.input;
  }
  function onToolResult(result) {
    if (result.isError) return setEmpty((result.content || []).map((c) => c.text).join(" ") || "The tool failed.");
    const j = resultJson(result);
    const input = j && (j.outputPath || j.input);
    if (!input) return setEmpty("No video in this result.");
    load(input);
  }

  async function load(input) {
    stop();
    S.input = input;
    S.boxes = [];
    $("file").textContent = input.split(/[\\/]/).pop();
    $("file").title = input;
    setEmpty("Loading frames...");
    status("");
    let meta;
    try {
      const r = await callTool("player_frames", { input });
      meta = resultJson(r);
      S.frames = (r.content || []).filter((c) => c.type === "image").map((c) => `data:${c.mimeType};base64,${c.data}`);
      if (!meta || S.frames.length === 0) throw new Error("No frames came back.");
      Object.assign(S, {
        duration: meta.durationSec, W: meta.width, H: meta.height, times: meta.frameTimes,
        scene: new Set(meta.sceneFrames || []), i: 0, inI: 0, outI: S.frames.length - 1,
      });
    } catch (err) {
      return setEmpty(`Could not load the recording: ${err.message}`);
    }
    $("empty").hidden = true;
    $("frame").hidden = false;
    // A strip of up to 40 thumbnails, evenly spaced in time.
    const strip = $("strip");
    strip.replaceChildren();
    const n = Math.min(40, S.frames.length);
    for (let k = 0; k < n; k++) {
      const img = document.createElement("img");
      img.alt = "";
      img.src = S.frames[frameAt(((k + 0.5) * S.duration) / n)];
      strip.appendChild(img);
    }
    // Scene-change frames get a tick, so a person sees where the extras are.
    $("ticks").replaceChildren(...[...S.scene].map((i) => {
      const t = document.createElement("i");
      t.style.left = `${pct(S.times[i])}%`;
      return t;
    }));
    const every = meta.intervalSec ?? S.duration / S.frames.length;
    $("sampling").textContent = `1 frame / ${every.toFixed(1)}s` + (S.scene.size ? `, +${S.scene.size} at scene changes` : "");
    ["play", "draw"].forEach((id) => ($(id).disabled = false));
    $("boxFields").disabled = false;
    for (const id of ["seek", "hIn", "hOut"]) $(id).removeAttribute("aria-disabled");
    show(0);
    render();
  }

  function show(i) {
    S.i = Math.max(0, Math.min(S.frames.length - 1, i));
    const t = S.times[S.i] || 0;
    $("frame").src = S.frames[S.i];
    $("frame").alt = `Frame at ${fmt(t)}`;
    $("tc").textContent = `${fmt(t)} / ${fmt(S.duration)}`;
    $("head").style.left = `${pct(t)}%`;
    setSlider($("seek"), t, `${fmt(t)} of ${fmt(S.duration)}`);
  }

  function setSlider(el, t, text) {
    el.setAttribute("aria-valuemax", String(Math.round(S.duration * 10) / 10));
    el.setAttribute("aria-valuenow", String(Math.round(t * 10) / 10));
    el.setAttribute("aria-valuetext", text);
  }

  function render() {
    const tin = S.times[S.inI] || 0, tout = end(S.outI);
    const a = pct(tin), b = pct(tout);
    $("hIn").style.left = `${a}%`;
    $("hOut").style.left = `${b}%`;
    $("shadeIn").style.cssText = `left:0;width:${a}%`;
    $("shadeOut").style.cssText = `left:${b}%;right:0`;
    $("inT").textContent = `${tin.toFixed(1)}s`;
    $("outT").textContent = `${tout.toFixed(1)}s`;
    $("lenT").textContent = `${(tout - tin).toFixed(1)}s kept`;
    setSlider($("hIn"), tin, `Trim start ${fmt(tin)}`);
    setSlider($("hOut"), tout, `Trim end ${fmt(tout)}`);
    renderBoxes();
    $("apply").disabled = !S.input || (!trimmed() && S.boxes.length === 0);
  }
  const trimmed = () => S.inI > 0 || S.outI < S.frames.length - 1;

  // --- timeline: seek and trim handles ----------------------------------
  const tl = $("timeline");
  const indexAt = (clientX) => {
    const r = tl.getBoundingClientRect();
    return frameAt(((clientX - r.left) / r.width) * S.duration);
  };
  let dragging = null;
  tl.addEventListener("pointerdown", (e) => {
    if (!S.frames.length) return;
    dragging = e.target === $("hIn") ? "in" : e.target === $("hOut") ? "out" : "seek";
    tl.setPointerCapture(e.pointerId);
    move(e);
  });
  tl.addEventListener("pointermove", (e) => {
    if (dragging) move(e);
  });
  // An interrupted drag (touch scroll, alt-tab) ends like a release (#243).
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) tl.addEventListener(type, () => (dragging = null));
  function move(e) {
    const i = indexAt(e.clientX);
    if (dragging === "in") S.inI = Math.min(i, S.outI);
    else if (dragging === "out") S.outI = Math.max(i, S.inI);
    show(dragging === "in" ? S.inI : dragging === "out" ? S.outI : i);
    render();
  }

  /** Where a slider key moves frame index i: arrows one frame, Page keys a
   * tenth of the recording, Home/End the ends. null for other keys. */
  function keyTarget(key, i) {
    const n = S.frames.length;
    if (key === "ArrowLeft" || key === "ArrowDown") return i - 1;
    if (key === "ArrowRight" || key === "ArrowUp") return i + 1;
    if (key === "PageDown") return Math.min(i - 1, frameAt(S.times[i] - S.duration / 10));
    if (key === "PageUp") return Math.max(i + 1, frameAt(S.times[i] + S.duration / 10));
    if (key === "Home") return 0;
    if (key === "End") return n - 1;
    return null;
  }
  $("seek").addEventListener("keydown", (e) => {
    const to = S.frames.length ? keyTarget(e.key, S.i) : null;
    if (to === null) return;
    e.preventDefault();
    show(to);
  });
  for (const [id, key] of [["hIn", "inI"], ["hOut", "outI"]]) {
    $(id).addEventListener("keydown", (e) => {
      const to = S.frames.length ? keyTarget(e.key, S[key]) : null;
      if (to === null) return;
      e.preventDefault();
      if (key === "inI") S.inI = Math.max(0, Math.min(to, S.outI));
      else S.outI = Math.min(S.frames.length - 1, Math.max(to, S.inI));
      show(S[key]);
      render();
    });
  }

  // --- playback: a flipbook over the kept range, at the frames' real times ---
  $("play").addEventListener("click", () => {
    if (S.playing) return stop();
    $("play").textContent = "Pause";
    let i = S.i < S.inI || S.i >= S.outI ? S.inI : S.i;
    const tick = () => {
      show(i);
      const ms = Math.max(40, (end(i) - S.times[i]) * 1000);
      i = i >= S.outI ? S.inI : i + 1;
      S.playing = setTimeout(tick, ms);
    };
    tick();
  });
  function stop() {
    clearTimeout(S.playing);
    S.playing = null;
    $("play").textContent = "Play";
  }

  // --- redaction boxes, in video pixels -----------------------------------
  const stage = $("stage"), img = $("frame");
  $("draw").addEventListener("click", () => {
    S.drawing = !S.drawing;
    $("draw").setAttribute("aria-pressed", String(S.drawing));
    stage.classList.toggle("drawing", S.drawing);
  });
  const toVideo = (clientX, clientY) => {
    const r = img.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(S.W, ((clientX - r.left) / r.width) * S.W)),
      y: Math.max(0, Math.min(S.H, ((clientY - r.top) / r.height) * S.H)),
    };
  };
  let start = null, draft = null;
  stage.addEventListener("pointerdown", (e) => {
    if (!S.drawing || !S.frames.length) return;
    start = toVideo(e.clientX, e.clientY);
    stage.setPointerCapture(e.pointerId);
    draft = document.createElement("div");
    draft.className = "box draft";
    stage.appendChild(draft);
  });
  stage.addEventListener("pointermove", (e) => {
    if (!start) return;
    placeBox(draft, rectOf(start, toVideo(e.clientX, e.clientY)));
  });
  stage.addEventListener("pointerup", (e) => {
    if (!start) return;
    const r = rectOf(start, toVideo(e.clientX, e.clientY));
    dropDraft();
    if (r.width >= 4 && r.height >= 4) S.boxes.push(r);
    render();
  });
  // A cancelled drag adds nothing and leaves no dashed box behind (#243).
  for (const type of ["pointercancel", "lostpointercapture"]) stage.addEventListener(type, dropDraft);
  function dropDraft() {
    start = null;
    draft?.remove();
    draft = null;
  }
  const rectOf = (a, b) => {
    const x = Math.floor(Math.min(a.x, b.x)), y = Math.floor(Math.min(a.y, b.y));
    return { x, y, width: Math.ceil(Math.max(a.x, b.x)) - x, height: Math.ceil(Math.max(a.y, b.y)) - y };
  };

  // The keyboard path: type a box in video pixels (#243).
  $("boxForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const [x, y, w, h] = ["bx", "by", "bw", "bh"].map((id) => Math.round(Number($(id).value)));
    if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || x >= S.W || y >= S.H) {
      return status(`A box needs x 0-${S.W - 1} and y 0-${S.H - 1}.`, "err");
    }
    const r = { x, y, width: Math.min(w, S.W - x), height: Math.min(h, S.H - y) };
    if (r.width < 4 || r.height < 4) return status("A box needs to be at least 4 px wide and tall inside the video.", "err");
    S.boxes.push(r);
    render();
    status(`Added box ${S.boxes.length}: ${r.width}\u00d7${r.height} at ${r.x},${r.y}.`);
  });

  function placeBox(el, r) {
    const ir = img.getBoundingClientRect(), sr = stage.getBoundingClientRect();
    const k = ir.width / S.W;
    el.style.left = `${ir.left - sr.left + r.x * k}px`;
    el.style.top = `${ir.top - sr.top + r.y * k}px`;
    el.style.width = `${r.width * k}px`;
    el.style.height = `${r.height * k}px`;
  }
  function renderBoxes() {
    stage.querySelectorAll(".box:not(.draft)").forEach((b) => b.remove());
    const list = $("boxList");
    list.replaceChildren();
    S.boxes.forEach((r, n) => {
      const el = document.createElement("div");
      el.className = "box";
      const tag = document.createElement("span");
      tag.textContent = String(n + 1);
      el.appendChild(tag);
      stage.appendChild(el);
      placeBox(el, r);
      const li = document.createElement("li");
      li.textContent = `#${n + 1} ${r.width}\u00d7${r.height} at ${r.x},${r.y}`;
      const rm = document.createElement("button");
      rm.type = "button";
      rm.textContent = "\u2715";
      rm.setAttribute("aria-label", `Remove box ${n + 1}`);
      rm.addEventListener("click", () => {
        S.boxes.splice(n, 1);
        render();
        status(`Removed box ${n + 1}.`);
        // Keep keyboard focus in the list (or on the form when it empties).
        const next = list.querySelectorAll("button")[Math.min(n, S.boxes.length - 1)];
        (next || $("bx")).focus();
      });
      li.appendChild(rm);
      list.appendChild(li);
    });
  }
  img.addEventListener("load", renderBoxes);
  new ResizeObserver(renderBoxes).observe(stage);

  // --- export: one pipeline call -----------------------------------------
  $("apply").addEventListener("click", async () => {
    stop();
    const steps = [];
    // Redact first, so a box covers every frame of the kept range.
    if (S.boxes.length) steps.push({ op: "redact", regions: S.boxes.map((b) => ({ ...b })) });
    const tin = Math.round((S.times[S.inI] || 0) * 1000) / 1000, tout = Math.round(end(S.outI) * 1000) / 1000;
    if (trimmed()) steps.push({ op: "trim", start: tin, end: Math.min(tout, S.duration) });
    $("apply").disabled = true;
    status("Exporting...");
    try {
      const out = resultJson(await callTool("pipeline", { input: S.input, steps }));
      S.result = out.outputPath;
      status(`Saved ${S.result}`, "ok");
      $("openResult").hidden = false;
      const what = [steps.some((s) => s.op === "trim") ? `trimmed to ${tin}-${tout}s` : "", S.boxes.length ? `${S.boxes.length} region(s) redacted` : ""].filter(Boolean).join(", ");
      // Tell the agent what the person did; the host includes it on the next turn.
      request("ui/update-model-context", {
        content: [{ type: "text", text: `In the review player the user exported ${S.input}, ${what}, to ${S.result}.` }],
        structuredContent: { input: S.input, output: S.result, steps },
      }).catch(() => {});
    } catch (err) {
      status(`Export failed: ${err.message}`, "err");
    } finally {
      render();
    }
  });
  $("openResult").addEventListener("click", () => {
    $("openResult").hidden = true;
    load(S.result);
  });

  // --- start ---------------------------------------------------------------
  new ResizeObserver(() => notify("ui/notifications/size-changed", { height: Math.ceil(document.documentElement.scrollHeight) })).observe(document.body);
  request("ui/initialize", { appInfo: { name: "screencast-review-player", version: "1.0.0" }, appCapabilities: {}, protocolVersion: PROTOCOL })
    .then((r) => {
      applyHostContext(r && r.hostContext);
      notify("ui/notifications/initialized", {});
    })
    .catch((err) => setEmpty(`The host did not start the player: ${err.message}`));
})();
