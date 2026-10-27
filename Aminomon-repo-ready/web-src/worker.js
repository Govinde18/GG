/* Module web worker: runs Aminomon (Python) in Pyodide. Blocking input uses a
   SharedArrayBuffer ring written by app.js; see src/curses.py. */
"use strict";
import { loadPyodide } from "./pyodide/pyodide.mjs";
const N = 512;            // ring slots, 4 ints each, starting at index 8
let A = null;

let ROWS = 24, COLS = 80, GEN = 0, seq = 0;
// Two ways to block for input:
//  - SAB mode: a SharedArrayBuffer ring + Atomics.wait (browsers, cross-origin isolated)
//  - XHR mode: synchronous XHR to /__gv/* which the host (Android app) answers
function xhr(path) {
  const x = new XMLHttpRequest();
  x.open("GET", path + (path.includes("?") ? "&" : "?") + "g=" + GEN + "&_=" + (++seq), false);
  try { x.send(); } catch (e) { return ""; }
  return x.status === 200 ? x.responseText : "";
}
self.gvWait = (ms) => {
  if (!A) {
    let left = ms < 0 ? 1000 : ms;
    for (;;) {
      const s = xhr("__gv/wait?ms=" + Math.min(Math.max(left, 0), 1000));
      if (s) {
        const p = s.split(",");
        if (p[0] === "3") { COLS = +p[1]; ROWS = +p[2]; }
        return s;
      }
      left -= 1000;
      if (left <= 0) return "";
    }
  }
  const tail = Atomics.load(A, 1);
  let head = Atomics.load(A, 0);
  if (head === tail) {
    Atomics.wait(A, 0, head, ms < 0 ? 1e9 : ms);
    head = Atomics.load(A, 0);
    if (head === tail) return "";
  }
  const o = 8 + (tail % N) * 4;
  const s = A[o] + "," + A[o + 1] + "," + A[o + 2] + "," + A[o + 3];
  Atomics.store(A, 1, tail + 1);
  return s;
};
self.gvSleep = (ms) => { if (ms > 0) { if (A) Atomics.wait(A, 4, 0, ms); else xhr("__gv/sleep?ms=" + ms); } };
self.gvFlush = () => { if (A) Atomics.store(A, 1, Atomics.load(A, 0)); else xhr("__gv/flush"); };
self.gvProf = (j) => postMessage({ t: "prof", d: j });
self.gvRows = () => (A ? Atomics.load(A, 2) : ROWS);
self.gvCols = () => (A ? Atomics.load(A, 3) : COLS);
self.gvDraw = (j) => postMessage({ t: "draw", d: j });
self.gvSound = (j) => postMessage({ t: "sound", d: j });
self.gvSave = (name, text) => postMessage({ t: "save", name, text });
self.gvRestart = () => postMessage({ t: "restart" });
self.gvAsk = (label, hint) => postMessage({ t: "ask", label, hint });
self.gvShow = (title, text) => postMessage({ t: "show", title, text });
self.gvCard = (j) => postMessage({ t: "card", d: j });
self.gvExit = () => postMessage({ t: "exit" });
self.gvFatal = (text) => postMessage({ t: "fatal", text });

self.onmessage = async (e) => {
  const m = e.data;
  if (m.t !== "init") return;
  A = m.sab ? new Int32Array(m.sab) : null;
  ROWS = m.rows || 24; COLS = m.cols || 80; GEN = m.gen || 0;
  try {
    postMessage({ t: "status", s: "Loading Python…", p: 12 });
    const py = await loadPyodide({ indexURL: "pyodide/" });
    postMessage({ t: "status", s: "Loading game…", p: 70 });
    const unpack = async (name) => {
      const r = await fetch(name);
      if (!r.ok) throw new Error("missing " + name);
      py.unpackArchive(await r.arrayBuffer(), "zip", { extractDir: "/game" });
    };
    await unpack("common.zip");
    await unpack({ amino: "amino.zip", study: "amino.zip", gv: "govinde.zip" }[m.game || "amino"]);
    const home = "/home/pyodide";
    py.FS.mkdirTree(home);
    for (const [name, text] of Object.entries(m.files || {})) {
      py.FS.writeFile(home + "/" + name, text, { encoding: "utf8" });
    }
    py.runPython(
      "import os\nos.environ['HOME']='" + home + "'\nos.environ['LANG']=" +
      JSON.stringify(m.lang || "en_US.UTF-8") + "\nos.environ['TERM']='xterm-256color'\nos.environ['AMN_GAME']='" + (m.game || "amino") + "'\nos.environ['AMN_PRO']='" + (m.pro ? 1 : 0) + "'\nos.environ['AMN_TZ_MIN']='" + (m.tzmin | 0) + "'"
    );
    postMessage({ t: "status", s: "Starting…", p: 92 });
    postMessage({ t: "ready" });
    py.runPython("import sys; sys.path.insert(0,'/game'); import boot");
  } catch (err) {
    postMessage({ t: "fatal", text: String((err && err.stack) || err) });
  }
};
