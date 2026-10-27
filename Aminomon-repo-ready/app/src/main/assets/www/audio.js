/* Aminomon sound: an original, generated light-jazz loop plus soft sound effects.
   Nothing here is sampled or copied: every note is synthesised with the Web Audio
   API from the small score below, so there is no copyright to worry about. */
"use strict";
(() => {
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };
  const S = {
    music: store.get("amn:music") !== "0",
    sfx: store.get("amn:sfx") !== "0",
    mvol: parseFloat(store.get("amn:mvol") || "0.55"),
    svol: parseFloat(store.get("amn:svol") || "0.8"),
  };
  let ctx = null, master, musicBus, sfxBus, reverb, wet, noiseBuf;
  let timer = 0, nextT = 0, step = 0, moodTarget = "calm", moodMix = 1, hidden = false;

  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

  function build() {
    if (ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.25;
    master.connect(comp); comp.connect(ctx.destination);
    musicBus = ctx.createGain(); sfxBus = ctx.createGain();
    musicBus.connect(master); sfxBus.connect(master);
    // a small generated room reverb (decaying noise), shared by music and bells
    const len = Math.floor(ctx.sampleRate * 1.7), ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
    }
    reverb = ctx.createConvolver(); reverb.buffer = ir;
    wet = ctx.createGain(); wet.gain.value = 0.32;
    reverb.connect(wet); wet.connect(master);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    applyVolumes();
    return true;
  }
  function applyVolumes() {
    if (!ctx) return;
    const t = ctx.currentTime;
    musicBus.gain.setTargetAtTime(S.music ? S.mvol * 0.5 : 0, t, 0.15);
    sfxBus.gain.setTargetAtTime(S.sfx ? S.svol : 0, t, 0.05);
  }

  // ------------------------------------------------------------ instruments
  function env(g, t, a, peak, dur) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }
  // electric-piano-like note: soft sine + a quick bell overtone
  function keys(bus, f, t, dur, vel, send) {
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain(), g2 = ctx.createGain();
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2600;
    o1.type = "sine"; o1.frequency.value = f;
    o2.type = "triangle"; o2.frequency.value = f * 2.005;
    env(g, t, 0.008, vel, dur); env(g2, t, 0.004, vel * 0.22, Math.min(dur, 0.45));
    o1.connect(g); o2.connect(g2); g.connect(lp); g2.connect(lp);
    lp.connect(bus); if (send) { const s = ctx.createGain(); s.gain.value = send; lp.connect(s); s.connect(reverb); }
    o1.start(t); o2.start(t); o1.stop(t + dur + 0.05); o2.stop(t + dur + 0.05);
  }
  function bass(f, t, dur, vel) {
    const o = ctx.createOscillator(), g = ctx.createGain(), lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 520;
    o.type = "triangle"; o.frequency.value = f;
    env(g, t, 0.012, vel, dur);
    o.connect(g); g.connect(lp); lp.connect(musicBus);
    o.start(t); o.stop(t + dur + 0.05);
  }
  function vibes(f, t, dur, vel) {            // gentle mallet for the melody
    const o = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain(), g2 = ctx.createGain();
    o.type = "sine"; o.frequency.value = f; o2.type = "sine"; o2.frequency.value = f * 3.9;
    env(g, t, 0.004, vel, dur); env(g2, t, 0.002, vel * 0.18, 0.18);
    o.connect(g); o2.connect(g2); g.connect(musicBus); g2.connect(musicBus);
    const s = ctx.createGain(); s.gain.value = 0.7; g.connect(s); s.connect(reverb);
    o.start(t); o2.start(t); o.stop(t + dur + 0.05); o2.stop(t + dur + 0.05);
  }
  function hat(t, vel, hp, dur) {
    const n = ctx.createBufferSource(), g = ctx.createGain(), f = ctx.createBiquadFilter();
    n.buffer = noiseBuf; f.type = "highpass"; f.frequency.value = hp || 6500;
    env(g, t, 0.002, vel, dur || 0.07);
    n.connect(f); f.connect(g); g.connect(musicBus);
    n.start(t, Math.random() * 0.5); n.stop(t + (dur || 0.07) + 0.02);
  }
  function brush(t, vel) {                    // soft brushed snare on 2 and 4
    const n = ctx.createBufferSource(), g = ctx.createGain(), f = ctx.createBiquadFilter();
    n.buffer = noiseBuf; f.type = "bandpass"; f.frequency.value = 2400; f.Q.value = 0.7;
    env(g, t, 0.006, vel, 0.16);
    n.connect(f); f.connect(g); g.connect(musicBus);
    n.start(t, Math.random() * 0.5); n.stop(t + 0.2);
  }

  // ------------------------------------------------------------ the score (original)
  // Eight bars in C: ii - V - I - VI, ii - (iii VI) - (ii V) - I.  Voicings are rootless.
  const BARS = [
    [{ r: 38, v: [53, 57, 60, 64] }],                                      // Dm9
    [{ r: 43, v: [53, 59, 64, 69] }],                                      // G13
    [{ r: 36, v: [52, 55, 59, 62] }],                                      // Cmaj9
    [{ r: 45, v: [55, 61, 65, 67] }],                                      // A7b13
    [{ r: 38, v: [53, 57, 60, 64] }],                                      // Dm9
    [{ r: 40, v: [55, 59, 62, 66] }, { r: 45, v: [55, 61, 64, 67] }],      // Em7  A7
    [{ r: 38, v: [53, 57, 60, 64] }, { r: 43, v: [53, 59, 64, 69] }],      // Dm9  G13
    [{ r: 36, v: [52, 55, 59, 62] }],                                      // Cmaj9
  ];
  const SCALE = [62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81, 83];     // D dorian / C major
  const BPM = 86, BEAT = 60 / BPM;
  let mel = 6;

  function chordAt(bar, beat) {
    const cs = BARS[bar % BARS.length];
    return cs.length === 1 ? cs[0] : cs[beat < 2 ? 0 : 1];
  }
  function scheduleStep(t, st) {              // st counts eighth notes
    const bar = Math.floor(st / 8) % BARS.length, e = st % 8, beat = Math.floor(e / 2), off = e % 2 === 1;
    const ch = chordAt(bar, beat);
    const calm = moodMix, focus = 1 - 0.45 * (1 - moodMix);
    const swing = off ? BEAT * 0.17 : 0;      // swung eighths
    const tt = t + swing;
    // bass: root, step, fifth, chromatic approach (walking)
    if (!off) {
      const nextCh = chordAt(e === 6 || e === 7 ? bar + 1 : bar, (beat + 1) % 4);
      const notes = [ch.r, ch.r + 2 + (rnd() < 0.5 ? 2 : 0), ch.r + 7, nextCh.r + (rnd() < 0.5 ? -1 : 1)];
      bass(hz(notes[beat]), t, BEAT * 0.9, 0.34 * focus);
    }
    // comping on the "charleston" places: beat 1 and the "and" of 2 (plus the odd extra)
    if ((e === 0) || (e === 3) || (e === 6 && rnd() < 0.35) || (e === 5 && rnd() < 0.2)) {
      const long = e === 0 ? BEAT * 2.3 : BEAT * 0.9;
      ch.v.forEach((m, i) => keys(musicBus, hz(m), tt + i * 0.011, long, (e === 0 ? 0.13 : 0.1) * focus, 0.5));
    }
    // ride cymbal: ding, ding-a, ding
    if (calm > 0.05) {
      if (!off) hat(t, 0.045 * calm, 7500, 0.16);
      else if (e === 3 || e === 7) hat(tt, 0.035 * calm, 7500, 0.09);
      if (e === 2 || e === 6) { hat(t, 0.02 * calm, 5000, 0.04); }
    }
    if (e === 2 || e === 6) brush(t, 0.05 * focus);
    // melody: a few unhurried mallet notes (only in the calm mood)
    if (calm > 0.3 && ((e % 2 === 1 && rnd() < 0.3) || (e === 0 && rnd() < 0.4))) {
      mel = Math.max(0, Math.min(SCALE.length - 1, mel + [-2, -1, -1, 0, 1, 1, 2][Math.floor(rnd() * 7)]));
      vibes(hz(SCALE[mel] + (bar % 4 === 3 ? 0 : 0)), tt, BEAT * (rnd() < 0.3 ? 1.6 : 0.9), 0.1 * calm);
    }
  }
  function pump() {
    if (!ctx || ctx.state !== "running") return;
    const stepLen = BEAT / 2;
    moodMix += ((moodTarget === "calm" ? 1 : 0) - moodMix) * 0.08;
    if (nextT < ctx.currentTime - 0.1) nextT = ctx.currentTime + 0.05;   // we fell behind (tab was asleep)
    while (nextT < ctx.currentTime + 0.35) {
      if (S.music) scheduleStep(nextT, step);
      nextT += stepLen; step++;
    }
  }
  function startLoop() { if (!timer) timer = setInterval(pump, 60); }

  // ------------------------------------------------------------ sound effects
  const bell = (f, t, dur, v) => keys(sfxBus, f, t, dur, v, 0.6);
  function noiseSweep(t, dur, v, f0, f1) {
    const n = ctx.createBufferSource(), g = ctx.createGain(), f = ctx.createBiquadFilter();
    n.buffer = noiseBuf; f.type = "bandpass"; f.Q.value = 1.2;
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    env(g, t, 0.01, v, dur);
    n.connect(f); f.connect(g); g.connect(sfxBus); n.start(t, Math.random() * 0.4); n.stop(t + dur + 0.02);
  }
  function slide(type, f0, f1, t, dur, v, lp) {
    const o = ctx.createOscillator(), g = ctx.createGain(), fl = ctx.createBiquadFilter();
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    fl.type = "lowpass"; fl.frequency.value = lp || 2000;
    env(g, t, 0.006, v, dur);
    o.connect(g); g.connect(fl); fl.connect(sfxBus); o.start(t); o.stop(t + dur + 0.03);
  }
  const SFX = {
    correcto(t) { bell(1318.5, t, 0.5, 0.2); bell(1760, t + 0.09, 0.7, 0.2); },
    error(t) { slide("triangle", 200, 120, t, 0.22, 0.28, 900); },
    golpe(t) { slide("sine", 160, 55, t, 0.14, 0.4, 600); noiseSweep(t, 0.06, 0.08, 3000, 900); },
    critico(t) { [1046.5, 1318.5, 1568].forEach((f, i) => bell(f, t + i * 0.05, 0.5, 0.18)); noiseSweep(t, 0.25, 0.1, 800, 6000); },
    captura(t) {
      [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => bell(f, t + i * 0.085, 0.8, 0.2));
      [1046.5, 1318.5, 1568].forEach((f) => bell(f, t + 0.5, 1.4, 0.12));
    },
    nivel(t) {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => { slide("sawtooth", f, f, t + i * 0.1, 0.32, 0.1, 1800); bell(f * 2, t + i * 0.1, 0.5, 0.1); });
    },
    logro(t) { [783.99, 987.77, 1174.7, 1318.5, 1568, 1975.5].forEach((f, i) => bell(f, t + i * 0.075, 0.9, 0.17)); },
    huida(t) { slide("sine", 700, 180, t, 0.3, 0.2, 1500); noiseSweep(t, 0.3, 0.07, 3000, 400); },
    ph(t) { bell(987.77, t, 0.3, 0.12); bell(783.99, t + 0.07, 0.4, 0.12); },
    paso(t) { slide("sine", 520, 440, t, 0.04, 0.05, 1200); },
    menu(t) { slide("sine", 880, 760, t, 0.035, 0.06, 2000); },
    viaje(t) { slide("sine", 300, 1300, t, 0.35, 0.16, 2400); [880, 1318.5].forEach((f, i) => bell(f, t + 0.25 + i * 0.07, 0.6, 0.12)); },
    pickup(t) { bell(1318.5, t, 0.35, 0.16); },
    gate(t) { slide("sine", 330, 660, t, 0.25, 0.16, 2200); bell(988, t + 0.18, 0.5, 0.12); },
    good(t) { SFX.correcto(t); },
    bad(t) { SFX.error(t); },
    step(t) { SFX.paso(t); },
    hazard(t) { SFX.golpe(t); },
    win(t) { SFX.logro(t); },
    upgrade(t) { SFX.nivel(t); },
    blip(t) { SFX.tick(t); },
    tick(t) { slide("sine", 1000, 900, t, 0.03, 0.07, 3000); },
  };

  window.AmnAudio = {
    S,
    unlock() {
      if (!build()) return;
      if (ctx.state === "suspended" && !hidden) ctx.resume();
      startLoop();
    },
    sfx(name) {
      if (!ctx || ctx.state !== "running" || !S.sfx) return;
      const f = SFX[name]; if (f) { try { f(ctx.currentTime + 0.01); } catch (e) { /* ignore */ } }
    },
    mood(m) { moodTarget = m; },
    setMusic(on) { S.music = on; store.set("amn:music", on ? "1" : "0"); if (on) this.unlock(); applyVolumes(); },
    setSfx(on) { S.sfx = on; store.set("amn:sfx", on ? "1" : "0"); applyVolumes(); },
    setMusicVol(v) { S.mvol = v; store.set("amn:mvol", String(v)); applyVolumes(); },
    setSfxVol(v) { S.svol = v; store.set("amn:svol", String(v)); applyVolumes(); },
    pause(h) {
      hidden = h;
      if (!ctx) return;
      if (h) ctx.suspend(); else ctx.resume();
    },
    get state() { return ctx ? ctx.state : "none"; },
    get steps() { return step; },
  };
})();
