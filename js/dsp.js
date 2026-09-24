/* Signal helpers for the user's own clip: peaks, loudness, pitch, spectrogram.
   Reference clips ship with precomputed peaks and spectrograms (tools/build.py),
   so this only ever runs on audio the user drops in. */
(function () {
  'use strict';

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function noteName(midi) {
    const m = Math.round(midi);
    return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  }

  function midiToHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  /** Mix an AudioBuffer down to one Float32Array. */
  function mono(buffer) {
    const n = buffer.length;
    const out = new Float32Array(n);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < n; i++) out[i] += d[i] / buffer.numberOfChannels;
    }
    return out;
  }

  /** Peak envelope as numbers 0..1. */
  function peaks(x, n) {
    const out = new Float32Array(n);
    const step = x.length / n;
    let max = 1e-9;
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * step), b = Math.max(a + 1, Math.floor((i + 1) * step));
      let p = 0;
      for (let j = a; j < b; j++) { const v = Math.abs(x[j]); if (v > p) p = v; }
      out[i] = p;
      if (p > max) max = p;
    }
    for (let i = 0; i < n; i++) out[i] /= max;
    return out;
  }

  /** Decode the build's 64-level peak string. */
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function decodePeaks(s) {
    const out = new Float32Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = ALPHA.indexOf(s[i]) / 63;
    return out;
  }

  function rmsDb(x, a = 0, b = x.length) {
    let s = 0, n = 0;
    for (let i = a; i < b; i++) { s += x[i] * x[i]; n++; }
    return 10 * Math.log10(s / Math.max(n, 1) + 1e-12);
  }

  /** YIN on a few windows of the selection. Returns {midi, hz, confidence} or null. */
  function pitch(x, sr, a = 0, b = x.length) {
    const n = 2048;
    const tauMin = Math.floor(sr / 2000), tauMax = Math.floor(sr / 40);
    if (b - a < n + tauMax) return null;
    const hops = Math.min(12, Math.floor((b - a - n - tauMax) / (sr * 0.05)) + 1);
    const ests = [];
    const d = new Float32Array(tauMax);
    for (let h = 0; h < hops; h++) {
      const s = a + Math.floor(((b - a - n - tauMax) * h) / Math.max(1, hops - 1));
      let energy = 0;
      for (let i = 0; i < n; i++) energy += x[s + i] * x[s + i];
      if (energy / n < 1e-6) continue;
      for (let t = 1; t < tauMax; t++) {
        let sum = 0;
        for (let i = 0; i < n; i++) { const diff = x[s + i] - x[s + i + t]; sum += diff * diff; }
        d[t] = sum;
      }
      let run = 0, tau = -1;
      const cm = new Float32Array(tauMax); cm[0] = 1;
      for (let t = 1; t < tauMax; t++) { run += d[t]; cm[t] = d[t] * t / (run || 1); }
      for (let t = tauMin; t < tauMax - 1; t++) {
        if (cm[t] < 0.15) { while (t + 1 < tauMax && cm[t + 1] < cm[t]) t++; tau = t; break; }
      }
      if (tau < 0) continue;
      const y0 = cm[tau - 1], y1 = cm[tau], y2 = cm[tau + 1];
      const den = y0 - 2 * y1 + y2;
      const refined = tau + (den ? 0.5 * (y0 - y2) / den : 0);
      ests.push({ midi: 69 + 12 * Math.log2(sr / refined / 440), q: 1 - y1 });
    }
    if (ests.length < 2) return null;
    ests.sort((p, q) => p.midi - q.midi);
    const med = ests[Math.floor(ests.length / 2)].midi;
    const agree = ests.filter(e => Math.abs(e.midi - med) < 0.7);
    const confidence = agree.length / hops;
    if (confidence < 0.3) return null;
    const midi = agree.reduce((s, e) => s + e.midi, 0) / agree.length;
    return { midi, hz: midiToHz(midi), confidence };
  }

  /* ---- spectrogram ---- */

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ar = re[i + k], ai = im[i + k];
          const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ar + br; im[i + k] = ai + bi;
          re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }

  // Same ember ramp as tools/build.py so the user's clip reads like the references.
  const STOPS = [
    [0.00, 30, 8, 20, 0], [0.22, 90, 20, 45, 120], [0.45, 170, 45, 40, 200],
    [0.68, 232, 110, 45, 245], [0.86, 250, 185, 90, 255], [1.00, 255, 244, 214, 255],
  ];
  function ramp(v) {
    for (let i = 1; i < STOPS.length; i++) {
      if (v <= STOPS[i][0]) {
        const a = STOPS[i - 1], b = STOPS[i], t = (v - a[0]) / (b[0] - a[0]);
        return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t, a[4] + (b[4] - a[4]) * t];
      }
    }
    return STOPS[STOPS.length - 1].slice(1);
  }

  /** Render a log-frequency spectrogram of x[a:b] into an ImageData of w x h. */
  function spectrogram(x, sr, a, b, w, h) {
    const nfft = 2048, win = new Float32Array(nfft);
    for (let i = 0; i < nfft; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (nfft - 1));
    const rows = new Float32Array(h);
    for (let r = 0; r < h; r++) rows[r] = 40 * Math.pow(16000 / 40, r / (h - 1));
    const levels = new Float32Array(w * h);
    let top = -Infinity;
    const re = new Float32Array(nfft), im = new Float32Array(nfft);
    const span = Math.max(0, b - a - nfft);
    for (let c = 0; c < w; c++) {
      const s = a + Math.floor(span * c / Math.max(1, w - 1));
      for (let i = 0; i < nfft; i++) { re[i] = (x[s + i] || 0) * win[i]; im[i] = 0; }
      fft(re, im);
      for (let r = 0; r < h; r++) {
        const bin = rows[r] * nfft / sr, lo = Math.floor(bin), t = bin - lo;
        const m0 = Math.hypot(re[lo], im[lo]), m1 = Math.hypot(re[lo + 1] || 0, im[lo + 1] || 0);
        const db = 20 * Math.log10(m0 + (m1 - m0) * t + 1e-9);
        levels[(h - 1 - r) * w + c] = db;
        if (db > top) top = db;
      }
    }
    const img = new ImageData(w, h);
    for (let i = 0; i < levels.length; i++) {
      const v = Math.min(1, Math.max(0, (levels[i] - top + 72) / 72));
      const [R, G, B, A] = ramp(v);
      img.data[i * 4] = R; img.data[i * 4 + 1] = G; img.data[i * 4 + 2] = B; img.data[i * 4 + 3] = A;
    }
    return img;
  }

  window.DSP = { noteName, midiToHz, mono, peaks, decodePeaks, rmsDb, pitch, spectrogram };
})();
