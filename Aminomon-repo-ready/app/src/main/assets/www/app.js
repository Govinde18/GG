/* Aminomon web shell: canvas terminal, touch controls, audio, saves. */
"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $("term"), ctx = canvas.getContext("2d", { alpha: false });
  const stage = $("stage"), loader = $("loader"), statusEl = $("status");
  let DEF_BG = "#121212", DEF_FG = "#d0d0d0";
  const ADV = 0.60205, LH = 1.2, ASC = 0.928, DESC = 0.236;   // DejaVu Sans Mono metrics
  const N = 512;                                              // ring slots (see worker.js)

  // ------------------------------------------------------------ helpers
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
    keys() { try { return Object.keys(localStorage); } catch (e) { return []; } },
  };
  function fail(msg) {
    loader.classList.remove("hide");
    $("spin").style.display = "none";
    statusEl.textContent = msg;
    statusEl.classList.add("err");
  }

  // ------------------------------------------------------------ palette + themes
  const pal = [];
  const BASE = [];
  (function () {
    const base = [[0,0,0],[205,0,0],[0,205,0],[205,205,0],[0,0,238],[205,0,205],[0,205,205],[229,229,229],
      [127,127,127],[255,0,0],[0,255,0],[255,255,0],[92,92,255],[255,0,255],[0,255,255],[255,255,255]];
    for (const c of base) BASE.push(c);
    const lv = [0, 95, 135, 175, 215, 255];
    for (let i = 0; i < 216; i++) BASE.push([lv[(i / 36) | 0], lv[((i / 6) | 0) % 6], lv[i % 6]]);
    for (let i = 0; i < 24; i++) { const v = 8 + 10 * i; BASE.push([v, v, v]); }
  })();
  function hsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    let h = 0, s = 0;
    if (d) {
      s = d / (1 - Math.abs(2 * l - 1));
      h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    }
    return [h * 60, s, l];
  }
  function rgbOf([h, s, l]) {
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return `rgb(${Math.round((r + m) * 255)},${Math.round((g + m) * 255)},${Math.round((b + m) * 255)})`;
  }
  const THEMES = {
    dark: { bg: "#121212", fg: "#d0d0d0", map: (c) => `rgb(${c[0]},${c[1]},${c[2]})` },
    light: { bg: "#f3efe4", fg: "#262626", map: (c) => { const [h, s, l] = hsl(c); return rgbOf([h, Math.min(1, s * 1.15), Math.min(0.86, Math.max(0.1, 1 - l))]); } },
    contrast: { bg: "#000000", fg: "#ffffff", map: (c) => { const [h, s, l] = hsl(c); return rgbOf([h, Math.min(1, s * 1.2), Math.min(1, l < 0.2 ? l : 0.35 + l * 0.65)]); } },
  };
  let theme = store.get("amn:theme") || "dark";
  if (!THEMES[theme]) theme = "dark";
  function applyTheme() {
    const t = THEMES[theme];
    DEF_BG = t.bg; DEF_FG = t.fg;
    for (let i = 0; i < 256; i++) pal[i] = t.map(BASE[i]);
    document.documentElement.style.setProperty("--bg", t.bg);
    document.documentElement.style.setProperty("--fg", t.fg);
    document.documentElement.dataset.theme = theme;
    const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = t.bg;
    for (let y = 0; y < rows; y++) dirty.add(y);
    if (ctx) { ctx.fillStyle = DEF_BG; ctx.fillRect(0, 0, canvas.width, canvas.height); schedule(); }
  }

  // ------------------------------------------------------------ geometry
  let rows = 24, cols = 80, cw = 8, chh = 16, dpr = 1, fontPx = 13, baseY = 12;
  let userFont = parseFloat(store.get("amn:font") || "0") || 0;      // CSS px; 0 = auto
  const coarse = matchMedia("(pointer: coarse)").matches;
  let ctlMode = store.get("amn:ctl") || (coarse ? "float" : "off");      // side | float | off
  let leftHand = store.get("amn:lh") === "1";
  let haptic = store.get("amn:haptic") !== "0";
  let cells = [];     // cells[y] = { ch: string[], fg: [], bg: [], fl: [] } per column
  let dirty = new Set(), raf = 0;

  function gutters() {
    if (ctlMode !== "side") return [0, 0];
    const w = innerWidth;
    const g = Math.max(84, Math.min(150, Math.round(w * 0.13)));
    return [g, g];
  }

  const MIN_FONT = 5;
  function area() {
    const [gl, gr] = gutters();
    return { gl, gr, W: Math.max(100, innerWidth - gl - gr), H: Math.max(100, innerHeight) };
  }
  function dimsFor(f, W, H) {
    const c = Math.max(3, Math.round(f * ADV * dpr)), fp = c / ADV, h = Math.round(fp * LH);
    return { cw: c, fontPx: fp, chh: h, cols: Math.floor((W * dpr) / c), rows: Math.floor((H * dpr) / h) };
  }
  // The game needs at least 80x24 characters, so that is where zooming in stops.
  function maxFont() {
    dpr = window.devicePixelRatio || 1;
    const { W, H } = area();
    for (let t = 40; t > MIN_FONT; t -= 0.25) { const x = dimsFor(t, W, H); if (x.cols >= 80 && x.rows >= 24) return t; }
    return MIN_FONT;
  }
  function clampFont(f) { return Math.max(MIN_FONT, Math.min(maxFont(), f)); }

  function computeGeometry() {
    dpr = window.devicePixelRatio || 1;
    const { gl, gr, W, H } = area();
    const dims = (f) => dimsFor(f, W, H);
    let f = userFont ? clampFont(userFont) : Math.min(maxFont(), 18), d;
    d = dims(f);
    cw = d.cw; fontPx = d.fontPx; chh = d.chh;
    baseY = Math.round((chh - fontPx * (ASC + DESC)) / 2 + fontPx * ASC);
    cols = Math.max(20, d.cols);
    rows = Math.max(8, d.rows);
    let snap = null;                                        // keep showing the old picture until the game redraws
    if (canvas.width > 10 && canvas.height > 10) {
      snap = document.createElement("canvas"); snap.width = canvas.width; snap.height = canvas.height;
      snap.getContext("2d").drawImage(canvas, 0, 0);
    }
    canvas.width = cols * cw; canvas.height = rows * chh;
    // the grid is at most one cell short of the screen: stretch it so no border is left
    const nw = canvas.width / dpr, nh = canvas.height / dpr;
    canvas.style.width = (W / nw < 1.04 ? W : nw) + "px";
    canvas.style.height = (H / nh < 1.04 ? H : nh) + "px";
    stage.style.setProperty("--gl", gl + "px");
    stage.style.setProperty("--gr", gr + "px");
    document.body.style.setProperty("--lift", Math.round(2 * chh / dpr + 8) + "px");   // keep clear of the game's 2-line bottom bar
    document.body.classList.toggle("ctl-float", ctlMode === "float");
    document.body.classList.toggle("ctl-off", ctlMode === "off");
    document.body.classList.toggle("lh", leftHand);
    cells = [];
    for (let y = 0; y < rows; y++) cells.push(newRow());
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = DEF_BG; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (snap) ctx.drawImage(snap, 0, 0, canvas.width, canvas.height);
  }
  function newRow() {
    return { ch: new Array(cols).fill(" "), fg: new Array(cols).fill(-1), bg: new Array(cols).fill(-1), fl: new Array(cols).fill(0) };
  }

  // ------------------------------------------------------------ drawing
  const LIGHT = { "─": "LR", "│": "UD", "┌": "RD", "┐": "LD", "└": "RU", "┘": "LU", "┬": "LRD", "┴": "LRU", "├": "UDR", "┤": "UDL", "┼": "LRUD" };
  function drawGlyph(ch, px, py, color, bold, ul) {
    const t = Math.max(1, Math.round(dpr));
    ctx.fillStyle = color;
    const cp = ch.codePointAt(0);
    if (cp === 0x2588) { ctx.fillRect(px, py, cw, chh); return; }                 // █
    if (cp === 0x2580) { ctx.fillRect(px, py, cw, chh >> 1); return; }            // ▀
    if (cp === 0x2584) { ctx.fillRect(px, py + (chh >> 1), cw, chh - (chh >> 1)); return; } // ▄
    if (cp === 0x2591 || cp === 0x2592 || cp === 0x2593) {                        // ░ ▒ ▓
      const a = ctx.globalAlpha; ctx.globalAlpha = a * (cp === 0x2591 ? 0.25 : cp === 0x2592 ? 0.5 : 0.75);
      ctx.fillRect(px, py, cw, chh); ctx.globalAlpha = a; return;
    }
    const seg = LIGHT[ch];
    const cx = px + (cw >> 1) - (t >> 1), cy = py + (chh >> 1) - (t >> 1);
    if (seg) {
      if (seg.includes("L")) ctx.fillRect(px, cy, cx - px + t, t);
      if (seg.includes("R")) ctx.fillRect(cx, cy, px + cw - cx, t);
      if (seg.includes("U")) ctx.fillRect(cx, py, t, cy - py + t);
      if (seg.includes("D")) ctx.fillRect(cx, cy, t, py + chh - cy);
      return;
    }
    if (cp === 0x2550) {                                                           // ═
      const g = Math.max(2, Math.round(chh / 6));
      ctx.fillRect(px, cy - g, cw, t); ctx.fillRect(px, cy + g, cw, t); return;
    }
    if (cp === 0x2551) {                                                           // ║
      const g = Math.max(2, Math.round(cw / 4));
      ctx.fillRect(cx - g, py, t, chh); ctx.fillRect(cx + g, py, t, chh); return;
    }
    if (ch !== " ") {
      ctx.font = (bold ? "bold " : "") + fontPx + "px GVMono, 'DejaVu Sans Mono', monospace";
      ctx.fillText(ch, px, py + baseY);
    }
    if (ul) ctx.fillRect(px, py + chh - t - 1, cw, t);
  }

  function paintRow(y) {
    const r = cells[y]; if (!r) return;
    const py = y * chh;
    ctx.globalAlpha = 1;
    ctx.fillStyle = DEF_BG; ctx.fillRect(0, py, canvas.width, chh);
    // backgrounds first (merge equal neighbours), then glyphs
    let x = 0;
    while (x < cols) {
      const fl = r.fl[x], bgi = r.bg[x], fgi = r.fg[x];
      const rev = fl & 8;
      const bgc = rev ? (fgi < 0 ? DEF_FG : pal[fgi]) : (bgi < 0 ? null : pal[bgi]);
      let e = x + 1;
      while (e < cols && r.bg[e] === bgi && r.fg[e] === fgi && (r.fl[e] & 8) === rev) e++;
      if (bgc) { ctx.fillStyle = bgc; ctx.fillRect(x * cw, py, (e - x) * cw, chh); }
      x = e;
    }
    for (let i = 0; i < cols; i++) {
      const ch = r.ch[i]; const fl = r.fl[i];
      if (ch === " " && !(fl & 4)) continue;
      const rev = fl & 8;
      const fgi = r.fg[i], bgi = r.bg[i];
      const color = rev ? (bgi < 0 ? DEF_BG : pal[bgi]) : (fgi < 0 ? DEF_FG : pal[fgi]);
      ctx.globalAlpha = fl & 2 ? 0.6 : 1;
      drawGlyph(ch, i * cw, py, color, fl & 1, fl & 4);
    }
    ctx.globalAlpha = 1;
  }
  let lastBig = 0;
  const stats = { paint: 0, paints: 0, parse: 0, draws: 0, lat: 0, lats: 0, tIn: 0 };
  function flush() {
    raf = 0;
    const t0 = performance.now();
    for (const y of dirty) paintRow(y);
    dirty.clear();
    stats.paint += performance.now() - t0; stats.paints++;
  }
  function schedule() { if (!raf) raf = requestAnimationFrame(flush); }

  function onDraw(json) {
    const t0 = performance.now();
    if (stats.tIn) { stats.lat += t0 - stats.tIn; stats.lats++; stats.tIn = 0; }
    const m = JSON.parse(json);
    wheelBusy = 0;
    if (m.rows !== rows || m.cols !== cols) return;          // stale frame from before a resize
    if (m.full) for (let y = 0; y < rows; y++) dirty.add(y);
    for (const [y, text, runs] of m.r) {
      const row = cells[y]; if (!row) continue;
      const chars = Array.from(text);
      for (let i = 0; i < cols; i++) row.ch[i] = chars[i] || " ";
      for (const [x, n, fg, bg, fl] of runs) {
        for (let i = x; i < x + n && i < cols; i++) { row.fg[i] = fg; row.bg[i] = bg; row.fl[i] = fl; }
      }
      dirty.add(y);
    }
    if (!loader.classList.contains("hide")) {
      loader.classList.add("hide");
      stage.classList.add("on");
      firstRun();
    }
    // a whole new screen (not a small update): fade it in softly
    const big = m.r.length >= rows * 0.75;
    const nowT = performance.now();
    if (big && nowT - lastBig > 260 && canvas.animate && !pinch) canvas.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 170, easing: "ease-out" });
    if (big) lastBig = nowT;
    if (m.r.some((r) => r[0] === 0)) window.AmnAudio.mood(onMap() ? "calm" : "focus");
    schedule();
    stats.parse += performance.now() - t0; stats.draws++;
  }

  // ------------------------------------------------------------ worker + input ring
  let worker = null, sab = null, A = null, gen = 0, native = false;
  const K = { DOWN: 258, UP: 259, LEFT: 260, RIGHT: 261, BACKSPACE: 263, DC: 330, NPAGE: 338, PPAGE: 339, HOME: 262, END: 360 };

  function push(type, a, b, c) {
    if (native) { try { window.AndroidBridge.push(type, a | 0, b | 0, c | 0); } catch (e) { /* ignore */ } return; }
    if (!A) return;
    const head = Atomics.load(A, 0), tail = Atomics.load(A, 1);
    if (head - tail >= N) return;
    const o = 8 + (head % N) * 4;
    A[o] = type; A[o + 1] = a | 0; A[o + 2] = b | 0; A[o + 3] = c | 0;
    Atomics.store(A, 0, head + 1);
    Atomics.notify(A, 0);
  }
  const key = (cp) => { stats.tIn = performance.now(); push(1, cp, 0, 0); };
  const special = (code) => push(4, code, 0, 0);
  const click = (x, y) => push(2, x, y, 1);
  const wheel = (x, y, up) => push(2, x, y, up ? 4 : 5);

  function sendSize() {
    if (!A && !native) return;
    if (A) { Atomics.store(A, 2, rows); Atomics.store(A, 3, cols); }
    push(3, cols, rows, 0);
  }

  let currentGame = store.get("amn:last") || "amino";
  const PRO = !(window.AMN_CONFIG && window.AMN_CONFIG.pro === false);
  function tzString() {
    const o = new Date().getTimezoneOffset();               // minutes, UTC - local
    return "UTC" + (o < 0 ? "-" : "+") + Math.floor(Math.abs(o) / 60) + ":" + String(Math.abs(o) % 60).padStart(2, "0");
  }
  function startWorker(game) {
    if (game) { currentGame = game; store.set("amn:last", game); }
    hideHub();
    const my = ++gen;
    if (worker) worker.terminate();
    loader.classList.remove("hide"); stage.classList.remove("on");
    $("spin").style.display = ""; statusEl.classList.remove("err");
    statusEl.textContent = "Starting…"; $("bar").style.width = "4%";
    if (native) {
      sab = null; A = null;
      try { window.AndroidBridge.reset(my); } catch (e) { /* ignore */ }
    } else {
      sab = new SharedArrayBuffer(4 * (8 + N * 4));
      A = new Int32Array(sab);
      Atomics.store(A, 2, rows); Atomics.store(A, 3, cols);
    }
    const files = {};
    for (const k of store.keys()) if (k.startsWith("amn:f:")) files[k.slice(6)] = store.get(k);
    const lang = ((navigator.languages && navigator.languages[0]) || navigator.language || "en").replace("-", "_");
    worker = new Worker("worker.js", { type: "module" });
    worker.onmessage = (e) => {
      if (my !== gen) return;
      const m = e.data;
      switch (m.t) {
        case "status": statusEl.textContent = m.s; $("bar").style.width = (m.p || 5) + "%"; break;
        case "draw": onDraw(m.d); break;
        case "prof": stats.py = m.d; break;
        case "sound": playSound(JSON.parse(m.d)); break;
        case "save": store.set("amn:f:" + m.name, m.text); break;
        case "restart": startWorker(); break;
        case "exit": showHub(); break;
        case "ask": askModal(m.label, m.hint); break;
        case "show": showModal(m.title, m.text); break;
        case "card": makeCard(JSON.parse(m.d)); break;
        case "fatal": fail("Something went wrong:\n" + m.text); break;
        default: break;
      }
    };
    worker.onerror = (e) => { if (my === gen) fail("The game could not start: " + (e.message || e)); };
    worker.postMessage({ t: "init", sab, rows, cols, gen: my, files, game: currentGame, pro: PRO, tzmin: -new Date().getTimezoneOffset(), lang: lang + ".UTF-8" });
  }
  const TIPS = ["Tap any button on screen, or tap the map to walk there.", "Pinch with two fingers to zoom. Drag on the map to walk.",
    "Drag a list to scroll it, flick for a glide.", "Open ☰ for music, themes and your backup.", "Every amino acid has a story: read the side chains!"];
  let tipI = 0; setInterval(() => { if (!loader.classList.contains("hide")) { tipI = (tipI + 1) % TIPS.length; $("tip").textContent = TIPS[tipI]; } }, 2600);
  $("tip").textContent = TIPS[0];
  function firstRun() {
    if (store.get("amn:coach") === "1") return;
    setTimeout(() => { if (store.get("amn:coach") !== "1") $("coach").classList.remove("hide"); }, 700);
  }
  $("coach-ok").addEventListener("click", () => { store.set("amn:coach", "1"); $("coach").classList.add("hide"); unlockAudio(); });
  function showExit() {
    $("exit").classList.remove("hide");
  }

  // ------------------------------------------------------------ audio (see audio.js)
  const unlockAudio = () => window.AmnAudio && window.AmnAudio.unlock();
  const playSound = (m) => window.AmnAudio && window.AmnAudio.sfx(m.n);

  // ------------------------------------------------------------ keyboard
  const KEYMAP = {
    ArrowUp: () => special(K.UP), ArrowDown: () => special(K.DOWN), ArrowLeft: () => special(K.LEFT),
    ArrowRight: () => special(K.RIGHT), Backspace: () => special(K.BACKSPACE), Delete: () => special(K.DC),
    PageUp: () => special(K.PPAGE), PageDown: () => special(K.NPAGE), Home: () => special(K.HOME),
    End: () => special(K.END), Enter: () => key(10), Escape: () => key(27), Tab: () => key(9),
  };
  addEventListener("keydown", (e) => {
    unlockAudio();
    if (e.ctrlKey && ["+", "=", "-", "0"].includes(e.key)) {
      e.preventDefault();
      if (e.key === "0") act.auto(); else setZoom((userFont || Math.min(maxFont(), 18)) * (e.key === "-" ? 0.92 : 1.09), true);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    const f = KEYMAP[e.key];
    if (f) { f(); e.preventDefault(); return; }
    if (e.key && [...e.key].length === 1) { key(e.key.codePointAt(0)); e.preventDefault(); }
  });

  // ------------------------------------------------------------ launcher (home screen)
  function readJSON(name) { try { return JSON.parse(store.get("amn:f:" + name) || "null"); } catch (e) { return null; } }
  function hubStatus() {
    const am = store.get("amn:f:.aminomon.json"), gv = store.get("amn:f:.govinde_signal.json");
    $("st-amino").textContent = am ? "Continue your adventure" : "Start a new adventure";
    $("st-gv").textContent = gv ? "Continue your signal" : "Begin as a prokaryote";
    const st = readJSON(".amino_study.json"), s = st && st.summary;
    const today = new Date(); const iso = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
    let line = "Daily quiz · reviews · exams";
    if (s) {
      const parts = [];
      if (s.streak && (s.last === iso || isYesterday(s.last))) parts.push("🔥 " + s.streak + "-day streak");
      if (s.due) parts.push(s.due + " review" + (s.due === 1 ? "" : "s") + " due");
      if (s.last !== iso) parts.push("daily quiz ready");
      if (parts.length) line = parts.join(" · ");
    }
    $("st-study").textContent = line;
    $("hub-cert").classList.toggle("hide", !store.get("amn:f:GovindeCertificate.html"));
  }
  function isYesterday(iso) {
    if (!iso) return false;
    const d = new Date(); d.setDate(d.getDate() - 1);
    return iso === d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function showHub() {
    gen++; if (worker) { worker.terminate(); worker = null; }
    A = null; sab = null;
    stage.classList.remove("on"); loader.classList.add("hide");
    $("exit").classList.add("hide"); $("menu").classList.add("hide"); $("save").classList.add("hide");
    $("hub-title").textContent = ((window.AMN_CONFIG && window.AMN_CONFIG.appName) || "Aminomon").toUpperCase();
    hubStatus(); $("hub").classList.remove("hide");
    window.AmnAudio.mood("calm");
  }
  function hideHub() { $("hub").classList.add("hide"); }
  for (const c of document.querySelectorAll("[data-game]")) {
    c.addEventListener("click", () => { unlockAudio(); buzz(10); window.AmnAudio.sfx("gate"); startWorker(c.dataset.game); });
  }
  $("hub-cert").addEventListener("click", () => {
    const html = store.get("amn:f:GovindeCertificate.html"); if (!html) return;
    const blob = new Blob([html], { type: "text/html" });
    const aEl = document.createElement("a"); aEl.href = URL.createObjectURL(blob); aEl.download = "GovindeCertificate.html";
    document.body.appendChild(aEl); aEl.click(); aEl.remove();
  });
  $("hub-menu").addEventListener("click", () => toggleMenu(true));

  // ------------------------------------------------------------ paste / show modals + share card
  function typeText(str) {                           // feeds text to the game as key presses, in small batches
    const chars = Array.from(str.replace(/\s+/g, " ").trim());
    let i = 0;
    const burst = native ? 30 : 100;
    const pump = () => {
      const room = A && !native ? N - (Atomics.load(A, 0) - Atomics.load(A, 1)) - 4 : burst;
      const n = Math.min(burst, room, chars.length - i);
      for (let k = 0; k < n; k++) push(1, chars[i++].codePointAt(0), 0, 0);
      if (i < chars.length) setTimeout(pump, native ? 25 : 12); else push(1, 10, 0, 0);
    };
    pump();
  }
  function askModal(label, hint) {
    $("ask-title").textContent = label || "Paste here";
    $("ask-help").textContent = hint || "";
    $("ask-text").value = "";
    $("ask").classList.remove("hide");
  }
  $("ask-paste").addEventListener("click", async () => {
    try { $("ask-text").value = await navigator.clipboard.readText(); } catch (e) { toast("Long-press the box and choose Paste"); $("ask-text").focus(); }
  });
  $("ask-send").addEventListener("click", () => { const t = $("ask-text").value; $("ask").classList.add("hide"); if (t.trim()) typeText(t); else key(27); });
  $("ask-cancel").addEventListener("click", () => { $("ask").classList.add("hide"); key(27); });
  function showModal(title, text) {
    $("show-title").textContent = title || "";
    $("show-text").value = text || "";
    $("show").classList.remove("hide");
  }
  $("show-copy").addEventListener("click", async () => {
    const t = $("show-text"); t.focus(); t.select();
    try { await navigator.clipboard.writeText(t.value); toast("Copied"); } catch (e) { try { document.execCommand("copy"); toast("Copied"); } catch (e2) { toast("Select the text and copy it"); } }
  });
  $("show-share").addEventListener("click", () => {
    const text = $("show-text").value;
    if (window.AndroidBridge && window.AndroidBridge.shareText) window.AndroidBridge.shareText(text);
    else if (navigator.share) navigator.share({ title: $("show-title").textContent, text }).catch(() => {});
    else { const a2 = document.createElement("a"); a2.href = URL.createObjectURL(new Blob([text], { type: "text/plain" })); a2.download = "aminomon.txt"; document.body.appendChild(a2); a2.click(); a2.remove(); }
  });
  $("show-close").addEventListener("click", () => { $("show").classList.add("hide"); key(10); });
  for (const id of ["ask-text", "show-text"]) $(id).addEventListener("pointerdown", (e) => e.stopPropagation());

  function shareBlob(blob, name) {
    if (window.AndroidBridge && window.AndroidBridge.saveImage) {
      const fr = new FileReader();
      fr.onload = () => window.AndroidBridge.saveImage(String(fr.result).split(",")[1]);
      fr.readAsDataURL(blob); return;
    }
    const file = new File([blob], name, { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: "Aminomon" }).catch(() => {}); return; }
    const a2 = document.createElement("a");
    a2.href = URL.createObjectURL(blob); a2.download = name;
    document.body.appendChild(a2); a2.click(); a2.remove(); toast("Image saved");
  }
  // A result card students can post: {title, big, sub, bars:[[label, pct]], streak, note}
  function makeCard(d) {
    const W = 1080, Hh = 1350, c = document.createElement("canvas"); c.width = W; c.height = Hh;
    const g = c.getContext("2d");
    const grad = g.createLinearGradient(0, 0, W, Hh); grad.addColorStop(0, "#0f1b17"); grad.addColorStop(1, "#1d1830");
    g.fillStyle = grad; g.fillRect(0, 0, W, Hh);
    g.fillStyle = "rgba(215,215,175,.07)";
    for (let i = 0; i < 18; i++) { g.beginPath(); g.arc((i * 211) % W, (i * 389) % Hh, 60 + (i * 37) % 110, 0, 7); g.fill(); }
    const mono = "'GVMono','DejaVu Sans Mono',monospace";
    g.textAlign = "center";
    g.fillStyle = "#d7d7af"; g.font = "700 64px " + mono; g.fillText(((window.AMN_CONFIG && window.AMN_CONFIG.appName) || "AMINOMON").toUpperCase(), W / 2, 150);
    g.fillStyle = "#8aaf8a"; g.font = "36px " + mono; g.fillText(d.title || "", W / 2, 220);
    g.fillStyle = "#ffffff"; g.font = "700 250px " + mono; g.fillText(d.big || "", W / 2, 520);
    g.fillStyle = "#cfcfcf"; g.font = "42px " + mono; g.fillText(d.sub || "", W / 2, 600);
    g.textAlign = "left";
    let y = 700;
    for (const [label, pct] of (d.bars || []).slice(0, 7)) {
      g.fillStyle = "#bdbdbd"; g.font = "32px " + mono; g.fillText(label, 110, y);
      g.fillStyle = "#2a2a3a"; g.fillRect(110, y + 14, 860, 26);
      g.fillStyle = pct >= 80 ? "#8aaf8a" : pct >= 50 ? "#d7d7af" : "#c08080";
      g.fillRect(110, y + 14, Math.max(6, 860 * pct / 100), 26);
      g.textAlign = "right"; g.fillStyle = "#ffffff"; g.fillText(Math.round(pct) + "%", 970, y); g.textAlign = "left";
      y += 92;
    }
    g.textAlign = "center";
    if (d.streak) { g.fillStyle = "#ffb86b"; g.font = "700 48px " + mono; g.fillText("🔥 " + d.streak + "-day streak", W / 2, 1230); }
    g.fillStyle = "#777"; g.font = "30px " + mono; g.fillText(d.note || new Date().toLocaleDateString(), W / 2, 1295);
    c.toBlob((b) => b && shareBlob(b, "aminomon-result.png"), "image/png");
  }

  // ------------------------------------------------------------ feedback helpers
  function buzz(ms) {
    if (!haptic) return;
    try { if (window.AndroidBridge && window.AndroidBridge.haptic) window.AndroidBridge.haptic(); else if (navigator.vibrate) navigator.vibrate(ms || 8); } catch (e) { /* ignore */ }
  }
  function ripple(px, py) {
    const r = document.createElement("div");
    r.className = "rip"; r.style.left = px + "px"; r.style.top = py + "px";
    document.body.appendChild(r);
    setTimeout(() => r.remove(), 450);
  }
  let toastT = 0;
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 1600);
  }

  // ------------------------------------------------------------ pointer on the screen (tap, scroll, pinch-zoom)
  const ptrs = new Map();
  let down = null, pinch = null, inertia = 0, wheelBusy = 0;
  canvas.style.touchAction = "none";
  const onMap = () => { const r = cells[0]; return !!r && r.ch.slice(0, 9).join("") === " AMINOMON"; };
  function cellAt(e) {
    const r = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * cols), y = Math.floor(((e.clientY - r.top) / r.height) * rows);
    return [Math.max(0, Math.min(cols - 1, x)), Math.max(0, Math.min(rows - 1, y))];
  }
  // zoom: the picture scales smoothly under your fingers; the grid is rebuilt once you let go
  function setZoom(f, save) {
    const lim = maxFont(), cur = userFont || Math.min(lim, 18);
    const t = clampFont(f);
    if (f > lim + 0.01) toast("Maximum zoom"); else if (f < MIN_FONT - 0.01) toast("Minimum zoom");
    if (t === cur && !save) return;
    userFont = t; store.set("amn:font", userFont);
    relayout(); toast(cols + "×" + rows);
  }
  function wheelOut(cx, cy, up) {
    if (wheelBusy >= 3) return;              // the game is still busy drawing: do not pile up
    wheelBusy++; wheel(cx, cy, up); buzz(3);
  }
  function stopInertia() { if (inertia) { cancelAnimationFrame(inertia); inertia = 0; } }
  function startInertia(v, cx, cy) {         // v: rows per second (signed, + = down)
    stopInertia();
    let last = performance.now(), acc = 0;
    const tick = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      v *= Math.pow(0.04, dt);               // glides, slowing like a flick on a phone
      acc += v * dt;
      while (Math.abs(acc) >= 1) { wheelOut(cx, cy, acc > 0); acc -= Math.sign(acc); }
      inertia = Math.abs(v) > 1.5 ? requestAnimationFrame(tick) : 0;
    };
    inertia = requestAnimationFrame(tick);
  }
  canvas.addEventListener("pointerdown", (e) => {
    unlockAudio(); stopInertia();
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (ptrs.size === 2) {                                   // second finger: pinch-zoom
      const [p, q] = [...ptrs.values()];
      pinch = { d: Math.hypot(p.x - q.x, p.y - q.y) || 1, f: userFont || Math.min(maxFont(), 18), t: null,
        cx: (p.x + q.x) / 2, cy: (p.y + q.y) / 2 };
      canvas.style.transformOrigin = pinch.cx + "px " + pinch.cy + "px";
      down = null; return;
    }
    if (ptrs.size === 1) down = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), scrolled: 0,
      lastY: e.clientY, lastX: e.clientX, moves: [], map: onMap() };
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = ptrs.get(e.pointerId); if (p) { p.x = e.clientX; p.y = e.clientY; }
    if (pinch && ptrs.size >= 2) {
      const [a1, b1] = [...ptrs.values()];
      const ratio = (Math.hypot(a1.x - b1.x, a1.y - b1.y) || 1) / pinch.d;
      pinch.t = clampFont(pinch.f * ratio);
      canvas.style.transform = "scale(" + (pinch.t / pinch.f).toFixed(4) + ")";
      return;
    }
    if (!down || e.pointerId !== down.id || e.pointerType === "mouse") return;
    const rowPx = chh / dpr, now = performance.now();
    down.moves.push([now, e.clientY]); if (down.moves.length > 6) down.moves.shift();
    if (down.map) {                                          // on the map: dragging walks, like a joystick
      const dx = e.clientX - down.lastX, dy = e.clientY - down.lastY;
      const stepPx = rowPx * 1.9;
      if (Math.abs(dx) >= stepPx * 0.55 || Math.abs(dy) >= stepPx) {
        if (Math.abs(dx) * 0.55 >= Math.abs(dy) * 0.45 && Math.abs(dx) >= stepPx * 0.55) { special(dx > 0 ? K.RIGHT : K.LEFT); down.lastX = e.clientX; down.lastY = e.clientY; }
        else if (Math.abs(dy) >= stepPx) { special(dy > 0 ? K.DOWN : K.UP); down.lastX = e.clientX; down.lastY = e.clientY; }
        down.scrolled++; buzz(3);
      }
      return;
    }
    const dy = e.clientY - down.lastY;                       // lists: finger drag scrolls, row by row
    if (Math.abs(dy) >= rowPx * 1.1) {
      const [cx, cy] = cellAt(e);
      wheelOut(cx, cy, dy > 0);
      down.lastY = e.clientY; down.scrolled++;
    }
  });
  function endPointer(e, cancelled) {
    ptrs.delete(e.pointerId);
    if (pinch) {
      if (ptrs.size < 2) {
        const t = pinch.t; pinch = null; down = null;
        canvas.style.transform = ""; canvas.style.transformOrigin = "";
        if (t) { userFont = t; store.set("amn:font", userFont); relayout(); toast(cols + "×" + rows + (t >= maxFont() - 0.01 ? " · max zoom" : "")); }
      }
      return;
    }
    if (!down || e.pointerId !== down.id) return;
    const d = down; down = null;
    if (cancelled) return;
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
    if (d.scrolled && !d.map && d.moves.length > 2) {       // flick: keep gliding
      const f = d.moves[0], l = d.moves[d.moves.length - 1], dt = (l[0] - f[0]) / 1000;
      const v = dt > 0.01 ? (l[1] - f[1]) / dt / (chh / dpr) : 0;
      if (Math.abs(v) > 6 && performance.now() - l[0] < 90) { const [cx, cy] = cellAt(e); startInertia(Math.max(-40, Math.min(40, v)), cx, cy); }
    }
    if (d.scrolled || moved > 14 || performance.now() - d.t > 900) return;
    const [cx, cy] = cellAt(e); click(cx, cy);
    ripple(e.clientX, e.clientY); buzz(6);
  }
  canvas.addEventListener("pointerup", (e) => endPointer(e, false));
  canvas.addEventListener("pointercancel", (e) => endPointer(e, true));
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (e.ctrlKey) { setZoom((userFont || Math.min(maxFont(), 18)) * (e.deltaY < 0 ? 1.08 : 0.93), true); return; }   // trackpad pinch / ctrl+wheel
    const [cx, cy] = cellAt(e); wheel(cx, cy, e.deltaY < 0);
  }, { passive: false });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  // ------------------------------------------------------------ on-screen buttons
  function bindButton(el, fire, repeat) {
    let t1 = 0, t2 = 0;
    const stop = () => { clearTimeout(t1); clearInterval(t2); el.classList.remove("on"); };
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault(); unlockAudio(); el.classList.add("on"); buzz(10); window.AmnAudio.sfx("tick");
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      fire();
      if (repeat) { t1 = setTimeout(() => { t2 = setInterval(fire, 70); }, 210); }
    });
    for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) el.addEventListener(ev, stop);
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  for (const b of document.querySelectorAll("[data-k]")) {
    const k = b.dataset.k;
    const fire = { up: () => special(K.UP), down: () => special(K.DOWN), left: () => special(K.LEFT), right: () => special(K.RIGHT),
      enter: () => key(10), esc: () => key(27), space: () => key(32), back: () => special(K.BACKSPACE) }[k];
    if (fire) bindButton(b, fire, ["up", "down", "left", "right"].includes(k));
  }

  // quick keys panel: every letter and digit, for the game's hotkeys
  (function () {
    const rowsDef = ["1234567890", "QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];
    const host = $("keyrows");
    for (const r of rowsDef) {
      const d = document.createElement("div"); d.className = "krow";
      for (const ch of r) {
        const b = document.createElement("div"); b.className = "b kb"; b.textContent = ch;
        bindButton(b, () => key(ch.toLowerCase().codePointAt(0)), false);
        d.appendChild(b);
      }
      host.appendChild(d);
    }
    const d = document.createElement("div"); d.className = "krow";
    for (const [t, f] of [["Esc", () => key(27)], ["Space", () => key(32)], ["⌫", () => special(K.BACKSPACE)], ["Enter", () => key(10)], ["Close", () => $("keys").classList.add("hide")]]) {
      const b = document.createElement("div"); b.className = "b kb wide"; b.textContent = t;
      bindButton(b, f, false); d.appendChild(b);
    }
    host.appendChild(d);
  })();

  // ------------------------------------------------------------ menu
  const menu = $("menu");
  const toggleMenu = (v) => menu.classList.toggle("hide", v === undefined ? !menu.classList.contains("hide") : !v);
  $("menubtn").addEventListener("pointerdown", (e) => { e.preventDefault(); unlockAudio(); buzz(10); toggleMenu(); });
  function relayout() {
    computeGeometry(); sendSize();
    $("fontlbl").textContent = userFont ? userFont.toFixed(1) + " px" : "auto";
    refreshLabels(); updateRotate();
  }
  function refreshLabels() {
    $("l-ctl").textContent = { side: "Side bars", float: "Floating", off: "Hidden" }[ctlMode];
    $("l-hand").textContent = leftHand ? "Left" : "Right";
    $("l-theme").textContent = { dark: "Dark", light: "Light", contrast: "High contrast" }[theme];
    $("l-haptic").textContent = haptic ? "On" : "Off";
    const A = window.AmnAudio.S;
    $("l-music").textContent = A.music ? "On" : "Off";
    $("l-sfx").textContent = A.sfx ? "On" : "Off";
    $("l-wake").textContent = wakeOn ? "On" : "Off";
  }
  let wakeOn = store.get("amn:wake") !== "0", wakeLock = null;
  async function applyWake() {
    try {
      if (wakeOn && "wakeLock" in navigator && document.visibilityState === "visible") wakeLock = await navigator.wakeLock.request("screen");
      else if (wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) { /* not allowed */ }
  }
  document.addEventListener("visibilitychange", () => { applyWake(); window.AmnAudio.pause(document.visibilityState !== "visible"); });
  $("vol-music").addEventListener("input", (e) => window.AmnAudio.setMusicVol(+e.target.value));
  $("vol-sfx").addEventListener("input", (e) => window.AmnAudio.setSfxVol(+e.target.value));
  $("vol-sfx").addEventListener("change", () => window.AmnAudio.sfx("captura"));
  $("vol-music").value = window.AmnAudio.S.mvol; $("vol-sfx").value = window.AmnAudio.S.svol;
  let installEvt = null;
  addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; $("b-install").classList.remove("hide"); });
  function currentF() { return Math.round((cw / ADV) / dpr * 4) / 4; }
  function saveBundle() {
    const o = {};
    for (const k of store.keys()) if (k.startsWith("amn:f:")) o[k.slice(6)] = store.get(k);
    return JSON.stringify(o);
  }
  function showBackup(mode) {
    $("save").classList.remove("hide");
    $("save-title").textContent = mode === "export" ? "Back up your game" : "Restore a backup";
    $("save-help").textContent = mode === "export"
      ? "Copy this text (or share it to yourself). To restore later, paste it in “Restore”."
      : "Paste the backup text here, then press Restore.";
    $("save-text").value = mode === "export" ? saveBundle() : "";
    $("b-copy").classList.toggle("hide", mode !== "export");
    $("b-share").classList.toggle("hide", mode !== "export");
    $("b-restore").classList.toggle("hide", mode === "export");
  }
  const act = {
    smaller() { setZoom((userFont || Math.min(maxFont(), 18)) - 0.75, true); },
    bigger() { setZoom((userFont || Math.min(maxFont(), 18)) + 0.75, true); },
    auto() { userFont = 0; store.del("amn:font"); relayout(); },
    ctl() { ctlMode = { side: "float", float: "off", off: "side" }[ctlMode]; store.set("amn:ctl", ctlMode); relayout(); },
    hand() { leftHand = !leftHand; store.set("amn:lh", leftHand ? "1" : "0"); relayout(); },
    theme() { theme = { dark: "light", light: "contrast", contrast: "dark" }[theme]; store.set("amn:theme", theme); applyTheme(); refreshLabels(); },
    haptic() { haptic = !haptic; store.set("amn:haptic", haptic ? "1" : "0"); refreshLabels(); buzz(15); },
    music() { window.AmnAudio.setMusic(!window.AmnAudio.S.music); refreshLabels(); },
    sfx() { window.AmnAudio.setSfx(!window.AmnAudio.S.sfx); refreshLabels(); window.AmnAudio.sfx("correcto"); },
    wake() { wakeOn = !wakeOn; store.set("amn:wake", wakeOn ? "1" : "0"); refreshLabels(); applyWake(); },
    keys() { toggleMenu(false); $("keys").classList.toggle("hide"); },
    full() {
      const d = document.documentElement;
      if (document.fullscreenElement) document.exitFullscreen();
      else if (d.requestFullscreen) d.requestFullscreen().then(lockLandscape).catch(() => {});
    },
    shot() {
      toggleMenu(false);
      setTimeout(() => canvas.toBlob((blob) => blob && shareBlob(blob, "aminomon.png"), "image/png"), 150);
    },
    home() { if (confirm("Back to the games menu? (Progress is saved.)")) { toggleMenu(false); showHub(); } },
    export() { showBackup("export"); },
    import() { showBackup("import"); },
    install() { if (installEvt) { installEvt.prompt(); installEvt = null; $("b-install").classList.add("hide"); } },
    restart() { if (confirm("Restart the game? (Your saved game is kept.)")) startWorker(); toggleMenu(false); },
    close() { toggleMenu(false); },
  };
  for (const b of document.querySelectorAll("[data-a]")) {
    b.addEventListener("click", () => { buzz(8); const f = act[b.dataset.a]; if (f) f(); });
  }
  $("b-copy").addEventListener("click", async () => {
    const t = $("save-text"); t.focus(); t.select();
    try { await navigator.clipboard.writeText(t.value); toast("Copied"); } catch (e) { try { document.execCommand("copy"); toast("Copied"); } catch (e2) { toast("Select the text and copy it"); } }
  });
  $("b-share").addEventListener("click", () => {
    const text = $("save-text").value;
    if (window.AndroidBridge && window.AndroidBridge.shareText) window.AndroidBridge.shareText(text);
    else if (navigator.share) navigator.share({ title: "Aminomon save", text }).catch(() => {});
    else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "application/json" })); a.download = "aminomon-save.json";
      document.body.appendChild(a); a.click(); a.remove();
    }
  });
  $("b-restore").addEventListener("click", () => {
    try {
      const o = JSON.parse($("save-text").value.trim());
      let n = 0;
      for (const [k, v] of Object.entries(o)) if (/^\.aminomon[\w.]*$/.test(k) && typeof v === "string") { store.set("amn:f:" + k, v); n++; }
      if (!n) throw new Error("no save data");
      $("save").classList.add("hide"); toggleMenu(false); toast("Backup restored"); startWorker();
    } catch (err) { toast("That is not an Aminomon backup"); }
  });
  $("b-saveclose").addEventListener("click", () => $("save").classList.add("hide"));
  $("save-text").addEventListener("pointerdown", (e) => e.stopPropagation());
  if (window.AndroidBridge) $("quit").classList.remove("hide");
  $("quit").addEventListener("click", () => { try { window.AndroidBridge.quit(); } catch (e) { /* ignore */ } });
  $("again").addEventListener("click", () => { $("exit").classList.add("hide"); startWorker(); });

  // ------------------------------------------------------------ orientation / fullscreen
  function lockLandscape() {
    try { screen.orientation.lock("landscape").catch(() => {}); } catch (e) { /* unsupported */ }
  }
  let rotateDismissed = false;
  function updateRotate() {
    const portrait = innerHeight > innerWidth && innerWidth < 700;
    $("rotate").classList.toggle("hide", !(portrait && !rotateDismissed));
  }
  $("rotateok").addEventListener("click", () => { rotateDismissed = true; updateRotate(); });
  let rt = 0;
  const onResize = () => { clearTimeout(rt); rt = setTimeout(relayout, 120); };
  addEventListener("resize", onResize);
  addEventListener("orientationchange", () => { rotateDismissed = false; onResize(); });
  // The page itself must never scroll or zoom
  document.addEventListener("touchmove", (e) => { if (e.target === document.body) e.preventDefault(); }, { passive: false });
  // Android's Back button (native wrapper calls this) acts as Esc
  window.gvBack = () => {
    const ex = $("exit"), mn = $("menu");
    if (!ex.classList.contains("hide")) return "quit";
    if (!mn.classList.contains("hide")) { toggleMenu(false); return "ok"; }
    key(27); return "ok";
  };

  // ------------------------------------------------------------ boot
  async function boot() {
    const isolated = window.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined";
    if (!isolated) {
      if (window.AndroidBridge && window.AndroidBridge.push) {
        native = true;                      // the Android app answers the worker's input waits itself
      } else if ("serviceWorker" in navigator && location.protocol !== "file:") {
        // static web hosting: a service worker adds the headers that make SharedArrayBuffer available
        try {
          statusEl.textContent = "Preparing offline mode…";
          await navigator.serviceWorker.register("sw.js");
          await navigator.serviceWorker.ready;
          if (!navigator.serviceWorker.controller) { location.reload(); return; }
          if (!window.crossOriginIsolated && !sessionStorage.getItem("amn:reloaded")) {
            sessionStorage.setItem("amn:reloaded", "1"); location.reload(); return;
          }
        } catch (e) { /* handled below */ }
      }
      if (!native && !(window.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined")) {
        fail("This browser cannot run the game here.\nOpen it with Chrome (Android) over https, or install the Aminomon app.");
        return;
      }
    } else if (!window.AndroidBridge && "serviceWorker" in navigator && location.protocol.startsWith("http")) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { /* ignore */ }
    try {
      await Promise.all([
        new FontFace("GVMono", "url(fonts/mono.woff)", { weight: "400" }).load().then((f) => document.fonts.add(f)),
        new FontFace("GVMono", "url(fonts/mono-Bold.woff)", { weight: "700" }).load().then((f) => document.fonts.add(f)),
      ]);
    } catch (e) { /* falls back to the system monospace font */ }
    applyTheme(); applyWake();
    relayout();
    showHub();
  }
  boot();
  window.gvDebug = { stats, get cols() { return cols; }, get rows() { return rows; }, get cells() { return cells; }, key, click, special };
})();
