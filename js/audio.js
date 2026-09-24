/* One transport for the whole app: only one thing sounds at a time.
   Reference clips play through an <audio> element (works from file://);
   the user's clip plays through Web Audio so it can loop a selection. */
(function () {
  'use strict';

  const listeners = {};
  const emit = (ev, data) => (listeners[ev] || []).forEach(fn => fn(data));

  const el = new Audio();
  el.preload = 'auto';
  let ctx = null, gain = null, src = null;

  const state = {
    current: null,     // { id, kind, title, sub, peaks, dur, startedAt }
    loop: false,
    volume: 0.9,
    clip: null,        // { name, buffer, data, sr, dur, peaks, sel:[a,b], gainDb, pitch }
    matchLevel: true,
  };

  try {
    const v = parseFloat(localStorage.getItem('im.volume'));
    if (!Number.isNaN(v)) state.volume = v;
  } catch (e) { /* storage unavailable */ }
  el.volume = state.volume;

  function audioCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      gain = ctx.createGain();
      gain.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function stopInternal() {
    el.pause();
    if (src) { try { src.onended = null; src.stop(); } catch (e) { /* already stopped */ } src = null; }
  }

  function stop() {
    if (!state.current) return;
    stopInternal();
    state.current = null;
    emit('change', null);
  }

  /** Play a reference sample. `inst` and `sample` come from window.INSTRUMEDIA. */
  function playSample(inst, sample, opts = {}) {
    const id = inst.id + '/' + sample.key;
    if (state.current && state.current.id === id) { stop(); return; }
    stopInternal();
    el.src = sample.src;
    el.loop = state.loop;
    el.currentTime = 0;
    const p = el.play();
    if (p && p.catch) p.catch(err => { if (err.name !== 'AbortError') emit('error', err); });
    state.current = {
      id, kind: 'sample', inst, sample,
      title: opts.title || inst.name,
      sub: opts.sub || sample.label + (sample.note && sample.group !== 'register' ? ' · ' + sample.note : ''),
      peaks: window.DSP.decodePeaks(sample.peaks),
      dur: sample.dur,
    };
    emit('change', state.current);
  }

  el.addEventListener('ended', () => { if (state.current && state.current.kind === 'sample') { state.current = null; emit('change', null); } });

  /** Play the user's clip (its selected region), level-matched to the references. */
  function playClip() {
    const clip = state.clip;
    if (!clip) { emit('need-clip'); return; }
    if (state.current && state.current.id === 'clip') { stop(); return; }
    stopInternal();
    const c = audioCtx();
    src = c.createBufferSource();
    src.buffer = clip.buffer;
    const [a, b] = clip.sel;
    gain.gain.value = state.volume * (state.matchLevel ? Math.pow(10, clip.gainDb / 20) : 1);
    src.connect(gain);
    if (state.loop) {
      src.loop = true; src.loopStart = a; src.loopEnd = b;
      src.start(0, a);
    } else {
      src.start(0, a, b - a);
    }
    const mine = src;
    src.onended = () => { if (src === mine) { src = null; state.current = null; emit('change', null); } };
    state.current = {
      id: 'clip', kind: 'clip',
      title: clip.name,
      sub: 'Your recording · ' + fmt(a) + '–' + fmt(b) + (clip.pitch ? ' · ≈ ' + window.DSP.noteName(clip.pitch.midi) : ''),
      peaks: clip.selPeaks,
      dur: b - a,
      startedAt: c.currentTime,
    };
    emit('change', state.current);
  }

  /** Seconds into the current sound. */
  function position() {
    const cur = state.current;
    if (!cur) return 0;
    if (cur.kind === 'sample') return el.currentTime || 0;
    const t = ctx.currentTime - cur.startedAt;
    return state.loop ? t % cur.dur : Math.min(t, cur.dur);
  }

  function seekFraction(f) {
    const cur = state.current;
    if (cur && cur.kind === 'sample' && el.duration) el.currentTime = f * el.duration;
  }

  function setLoop(v) {
    state.loop = v;
    el.loop = v;
    if (state.current && state.current.kind === 'clip') { const again = state.current; stop(); playClip(); return again; }
    emit('loop', v);
  }

  function setVolume(v) {
    state.volume = v;
    el.volume = v;
    if (gain && state.clip) gain.gain.value = v * (state.matchLevel ? Math.pow(10, state.clip.gainDb / 20) : 1);
    try { localStorage.setItem('im.volume', String(v)); } catch (e) { /* ignore */ }
  }

  /* ---- user clip ---- */

  async function loadClip(file) {
    const c = audioCtx();
    const buf = await file.arrayBuffer();
    let buffer;
    try {
      buffer = await c.decodeAudioData(buf);
    } catch (e) {
      throw new Error('This browser could not decode that file. Try an MP3, WAV, M4A or MP4.');
    }
    const data = window.DSP.mono(buffer);
    const clip = {
      name: file.name.replace(/\.[^.]+$/, ''),
      buffer, data, sr: buffer.sampleRate, dur: buffer.duration,
      peaks: window.DSP.peaks(data, 600),
    };
    state.clip = clip;
    // Start with a sensible window: the loudest 4 seconds.
    const win = Math.min(clip.dur, 4);
    let best = 0, bestE = -Infinity;
    for (let s = 0; s + win <= clip.dur; s += 0.25) {
      const e = window.DSP.rmsDb(data, Math.floor(s * clip.sr), Math.floor((s + win) * clip.sr));
      if (e > bestE) { bestE = e; best = s; }
    }
    setSelection(best, best + win);
    emit('clip', clip);
    return clip;
  }

  function setSelection(a, b) {
    const clip = state.clip;
    if (!clip) return;
    a = Math.max(0, Math.min(a, clip.dur)); b = Math.max(a + 0.05, Math.min(b, clip.dur));
    clip.sel = [a, b];
    const ia = Math.floor(a * clip.sr), ib = Math.floor(b * clip.sr);
    // References are normalized to about -20 LUFS, roughly -23 dB RMS for typical material.
    clip.gainDb = Math.max(-12, Math.min(24, -23 - window.DSP.rmsDb(clip.data, ia, ib)));
    clip.pitch = window.DSP.pitch(clip.data, clip.sr, ia, ib);
    clip.selPeaks = window.DSP.peaks(clip.data.subarray(ia, ib), 180);
    if (state.current && state.current.id === 'clip') { stop(); }
    emit('selection', clip);
  }

  function fmt(t) {
    const m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }

  window.Player = {
    state, playSample, playClip, stop, position, seekFraction, setLoop, setVolume, loadClip, setSelection, fmt,
    toggle() { if (state.current) stop(); else emit('toggle-idle'); },
    setMatchLevel(v) { state.matchLevel = v; if (gain && state.clip) gain.gain.value = state.volume * (v ? Math.pow(10, state.clip.gainDb / 20) : 1); },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    get element() { return el; },
  };
})();
