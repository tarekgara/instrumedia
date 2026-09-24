"""Small subtractive synthesizer for the electronic reference sounds.

Everything here is generated from first principles so the output carries no
third-party license. Each preset is deliberately "textbook": the goal is a
clear example of the sound category, not a flattering patch.
"""

import numpy as np
from scipy import signal

SR = 44100
RNG = np.random.default_rng(7)


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def _t(dur):
    return np.arange(int(dur * SR)) / SR


def _phase(freq):
    """Integrate an instantaneous-frequency curve into phase (radians)."""
    return 2 * np.pi * np.cumsum(freq) / SR


def saw(freq_curve):
    """Band-limited sawtooth by additive synthesis."""
    ph = _phase(freq_curve)
    top = float(np.max(freq_curve))
    out = np.zeros_like(ph)
    for k in range(1, int(18000 / top) + 1):
        out += np.sin(k * ph) / k
    return out * (2 / np.pi)


def square(freq_curve):
    ph = _phase(freq_curve)
    top = float(np.max(freq_curve))
    out = np.zeros_like(ph)
    for k in range(1, int(18000 / top) + 1, 2):
        out += np.sin(k * ph) / k
    return out * (4 / np.pi)


def lowpass(x, cutoff_curve, q=0.9, block=256):
    """Time-varying resonant lowpass: a biquad re-designed every block."""
    y = np.zeros_like(x)
    zi = np.zeros((1, 2))
    for i in range(0, len(x), block):
        fc = float(np.clip(cutoff_curve[min(i, len(cutoff_curve) - 1)], 30, SR * 0.45))
        b, a = _rbj_lowpass(fc, q)
        sos = np.concatenate([b, a])[None, :]
        y[i:i + block], zi = signal.sosfilt(sos, x[i:i + block], zi=zi)
    return y


def _rbj_lowpass(fc, q):
    w = 2 * np.pi * fc / SR
    alpha = np.sin(w) / (2 * q)
    cw = np.cos(w)
    b = np.array([(1 - cw) / 2, 1 - cw, (1 - cw) / 2])
    a = np.array([1 + alpha, -2 * cw, 1 - alpha])
    return b / a[0], a / a[0]


def adsr(n, a, d, s, r, gate):
    t = np.arange(n) / SR
    env = np.where(t < a, t / max(a, 1e-4), s + (1 - s) * np.exp(-(t - a) / max(d, 1e-4)))
    rel = t >= gate
    if rel.any():
        level = env[np.argmax(rel)]
        env[rel] = level * np.exp(-(t[rel] - gate) / max(r, 1e-4))
    return env


def vibrato(n, base, depth_cents=12, rate=5.5, delay=0.35):
    t = np.arange(n) / SR
    ramp = np.clip((t - delay) / 0.4, 0, 1)
    return base * 2 ** (depth_cents * ramp * np.sin(2 * np.pi * rate * t) / 1200)


def noise(n):
    return RNG.standard_normal(n)


# ------------------------------------------------------------------ presets

def synth_bass(midi, gate):
    n = int((gate + 0.25) * SR)
    f = np.full(n, hz(midi))
    x = 0.65 * saw(f) + 0.35 * square(f / 2)
    t = np.arange(n) / SR
    cutoff = 280 + 2600 * np.exp(-t / 0.18)
    x = lowpass(x, cutoff, q=2.2)
    return x * adsr(n, 0.004, 0.25, 0.75, 0.08, gate)


def sub_808(midi, gate):
    n = int((gate + 0.4) * SR)
    t = np.arange(n) / SR
    f = hz(midi) * (1 + 1.6 * np.exp(-t / 0.035))
    x = np.sin(_phase(f))
    x = np.tanh(1.8 * x) / np.tanh(1.8)
    return x * np.exp(-t / 1.1) * adsr(n, 0.001, 1, 1, 0.12, gate)


def synth_lead_saw(midi, gate):
    n = int((gate + 0.2) * SR)
    base = vibrato(n, hz(midi))
    x = 0.5 * saw(base * 2 ** (7 / 1200)) + 0.5 * saw(base * 2 ** (-7 / 1200))
    x = lowpass(x, np.full(n, 5200.0), q=1.1)
    return x * adsr(n, 0.006, 0.3, 0.85, 0.12, gate)


def synth_lead_square(midi, gate):
    n = int((gate + 0.15) * SR)
    base = vibrato(n, hz(midi), depth_cents=8)
    x = lowpass(square(base), np.full(n, 7000.0), q=0.8)
    return x * adsr(n, 0.004, 0.2, 0.9, 0.05, gate)


def synth_pad(midi, gate):
    n = int((gate + 1.2) * SR)
    t = np.arange(n) / SR
    x = np.zeros(n)
    for cents in (-14, -7, 0, 7, 14):
        x += saw(np.full(n, hz(midi) * 2 ** (cents / 1200)))
    x /= 5
    cutoff = 1300 + 700 * np.sin(2 * np.pi * 0.25 * t)
    x = lowpass(x, cutoff, q=0.8)
    return x * adsr(n, 0.7, 1.0, 0.9, 1.0, gate)


def synth_pluck(midi, gate):
    n = int((gate + 0.5) * SR)
    t = np.arange(n) / SR
    f = np.full(n, hz(midi))
    x = 0.6 * saw(f) + 0.4 * square(f * 2 ** (5 / 1200))
    x = lowpass(x, 350 + 7000 * np.exp(-t / 0.07), q=1.4)
    return x * np.exp(-t / 0.35) * adsr(n, 0.002, 1, 1, 0.08, gate + 0.3)


def acid_bass(midi, gate):
    """TB-303 style: one saw, a squelchy resonant filter that snaps shut."""
    n = int((gate + 0.12) * SR)
    t = np.arange(n) / SR
    x = saw(np.full(n, hz(midi)))
    x = lowpass(x, 180 + 3200 * np.exp(-t / 0.11), q=7.5, block=64)
    x = np.tanh(2.2 * x)
    return x * adsr(n, 0.002, 0.3, 0.8, 0.03, gate)


def supersaw(midi, gate):
    """Seven detuned saws: the trance and EDM lead."""
    n = int((gate + 0.35) * SR)
    x = np.zeros(n)
    for cents in (-38, -24, -11, 0, 11, 24, 38):
        x += saw(np.full(n, hz(midi) * 2 ** (cents / 1200)))
    x = lowpass(x / 7, np.full(n, 9000.0), q=0.7)
    return x * adsr(n, 0.01, 0.4, 0.85, 0.3, gate)


def fm_bell(midi, gate):
    """Two-operator FM with an inharmonic ratio: the glassy digital bell."""
    n = int((gate + 2.2) * SR)
    t = np.arange(n) / SR
    f = hz(midi)
    index = 6 * np.exp(-t / 0.6)
    mod = np.sin(2 * np.pi * f * 3.5 * t) * index
    x = np.sin(2 * np.pi * f * t + mod)
    return x * np.exp(-t / 1.1) * adsr(n, 0.001, 1, 1, 0.4, gate + 1.8)


def theremin(midi, gate):
    """A near-sine oscillator with the wide, slow vibrato of a hand in the air."""
    n = int((gate + 0.3) * SR)
    f = vibrato(n, hz(midi), depth_cents=28, rate=5.8, delay=0.15)
    ph = _phase(f)
    x = np.sin(ph) + 0.18 * np.sin(2 * ph) + 0.06 * np.sin(3 * ph)
    return x * adsr(n, 0.12, 0.5, 0.9, 0.25, gate)


def dm_kick(_midi=None, gate=0.6):
    n = int(0.7 * SR)
    t = np.arange(n) / SR
    f = 48 + 110 * np.exp(-t / 0.04)
    x = np.sin(_phase(f)) * np.exp(-t / 0.28)
    click = noise(n) * np.exp(-t / 0.002) * 0.3
    return np.tanh(1.5 * (x + click))


def dm_snare(_midi=None, gate=0.3):
    n = int(0.4 * SR)
    t = np.arange(n) / SR
    tone = np.sin(_phase(np.full(n, 185.0))) * np.exp(-t / 0.05)
    sos = signal.butter(2, [1800, 9000], "bandpass", fs=SR, output="sos")
    nz = signal.sosfilt(sos, noise(n)) * np.exp(-t / 0.11)
    return 0.55 * tone + 0.9 * nz


def dm_clap(_midi=None, gate=0.3):
    n = int(0.45 * SR)
    t = np.arange(n) / SR
    sos = signal.butter(2, [900, 2600], "bandpass", fs=SR, output="sos")
    nz = signal.sosfilt(sos, noise(n))
    env = np.zeros(n)
    for k, off in enumerate((0.0, 0.011, 0.022)):
        env += (t >= off) * np.exp(-np.clip(t - off, 0, None) / 0.006) * (0.8 + 0.1 * k)
    env += (t >= 0.03) * np.exp(-np.clip(t - 0.03, 0, None) / 0.12) * 0.7
    return nz * env


def dm_hat(_midi=None, gate=0.1):
    n = int(0.18 * SR)
    t = np.arange(n) / SR
    sos = signal.butter(4, 7000, "highpass", fs=SR, output="sos")
    return signal.sosfilt(sos, noise(n)) * np.exp(-t / 0.028)


PRESETS = {
    "synth-bass": (synth_bass, [28, 33, 40, 45, 52]),
    "sub-808": (sub_808, [24, 28, 31, 36, 40]),
    "synth-lead-saw": (synth_lead_saw, [55, 62, 69, 76, 83]),
    "synth-lead-square": (synth_lead_square, [55, 62, 69, 76, 83]),
    "synth-pad": (synth_pad, [43, 50, 57, 64, 71]),
    "synth-pluck": (synth_pluck, [52, 59, 66, 73, 80]),
    "acid-bass": (acid_bass, [31, 36, 43, 48, 55]),
    "supersaw": (supersaw, [55, 62, 69, 76, 83]),
    "fm-bell": (fm_bell, [60, 67, 74, 81, 88]),
    "theremin": (theremin, [57, 64, 71, 78, 85]),
    "dm-kick": (dm_kick, None),
    "dm-snare": (dm_snare, None),
    "dm-clap": (dm_clap, None),
    "dm-hat": (dm_hat, None),
}

# How long a single reference note is held, per preset.
NOTE_GATE = {"synth-pad": 2.6, "sub-808": 1.4, "synth-pluck": 0.4, "fm-bell": 0.3, "acid-bass": 0.9}


def theremin_phrase(plan, beat):
    """One continuous tone that glides between notes, as a thereminist plays."""
    n = int((sum(b for _, b in plan) * beat + 0.4) * SR)
    target = np.zeros(n)
    pos = 0
    for m, b in plan:
        end = min(n, pos + int(b * beat * SR))
        target[pos:end] = hz(m)
        pos = end
    target[pos:] = hz(plan[-1][0])
    # portamento: smooth the step curve in the log domain (~70 ms glide)
    lg = np.log(target)
    sos = signal.butter(1, 7.0, "lowpass", fs=SR, output="sos")
    lg = signal.sosfiltfilt(sos, lg)
    f = vibrato(n, np.exp(lg), depth_cents=26, rate=5.8, delay=0.2)
    ph = _phase(f)
    x = np.sin(ph) + 0.18 * np.sin(2 * ph) + 0.06 * np.sin(3 * ph)
    x *= adsr(n, 0.15, 0.5, 0.9, 0.3, n / SR - 0.35)
    return (x / (np.max(np.abs(x)) or 1) * 0.9).astype(np.float32)


def render(preset, midi=None, gate=None):
    fn, _ = PRESETS[preset]
    g = gate if gate is not None else NOTE_GATE.get(preset, 1.6)
    x = fn(midi, g)
    peak = np.max(np.abs(x)) or 1.0
    return (x / peak * 0.9).astype(np.float32)
