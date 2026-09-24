#!/usr/bin/env python3
"""Build the Instrumedia reference library.

Reads data/library.yaml, pulls only the raw recordings it needs from the
source libraries (cached in .cache/), and writes:

  audio/<instrument>/<key>.mp3    loudness-matched reference clips
  audio/<instrument>/<key>.webp   spectrogram (transparent background)
  js/data.js                      everything the app needs, as a plain script
                                  (so the site also works from file://)
  data/provenance.json            where every clip came from
  SOURCES.md                      human-readable credits

Usage:
  python tools/build.py                 build everything (cached per instrument)
  python tools/build.py --only oboe,flute
  python tools/build.py --force         ignore the per-instrument cache
"""

import argparse
import concurrent.futures as cf
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import pyloudnorm
import yaml
from PIL import Image
from scipy import signal

sys.path.insert(0, str(Path(__file__).parent))
import synth  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache"
AUDIO = ROOT / "audio"
SR = 44100
BUILD_VERSION = 7  # bump to invalidate every cached instrument

REPOS = {"vcsl": "sgossner/VCSL/master", "vsco": "sgossner/VSCO-2-CE/master"}

FREEPATS = {
    "SpanishClassicalGuitar": ("CC0-1.0", "FreePats Spanish Classical Guitar", "https://freepats.zenvoid.org/Guitar/acoustic-guitar.html"),
    "FSS-SteelStringGuitar": ("GPL-3.0-or-later WITH FreePats exception", "FSS Steel-String Guitar, Gary Campion (FlameStudios), adapted by FreePats", "https://freepats.zenvoid.org/Guitar/steel-acoustic-guitar.html"),
    "Ukulele": ("CC0-1.0", "FreePats Ukulele", "https://freepats.zenvoid.org/GuitarFamily/ukulele.html"),
    "EGuitarFSBS-clean-bridge-small": ("CC0-1.0", "FreePats Electric Guitar FSBS (clean)", "https://freepats.zenvoid.org/ElectricGuitar/clean-electric-guitar.html"),
    "EGuitarFSBS-dist1": ("CC0-1.0", "FreePats Electric Guitar FSBS (distortion 1)", "https://freepats.zenvoid.org/ElectricGuitar/distorted-electric-guitar.html"),
    "FingerBassYR": ("CC0-1.0", "FreePats Finger Bass YR", "https://freepats.zenvoid.org/ElectricGuitar/clean-electric-bass.html"),
    "ButtonAccordionHN": ("CC0-1.0", "FreePats Button Accordion HN (michael02022)", "https://freepats.zenvoid.org/Organ/accordion.html"),
    "DrawbarOrganEmulation": ("CC0-1.0", "FreePats Drawbar Organ Emulation", "https://freepats.zenvoid.org/Organ/electric-organ.html"),
    "MuldjordKit": ("CC-BY-4.0", "MuldjordKit by Lars Muldjord (FreePats stereo version)", "https://freepats.zenvoid.org/Percussion/acoustic-drum-kit.html"),
    "Bagpipe-small": ("CC0-1.0", "FreePats Bagpipe", "https://freepats.zenvoid.org/Ethnic/bagpipe.html"),
    "Hang-D-minor": ("CC0-1.0", "FreePats Hang in D minor", "https://freepats.zenvoid.org/ChromaticPercussion/hang.html"),
    "JawHarp": ("CC0-1.0", "FreePats Jaw Harp", "https://freepats.zenvoid.org/Ethnic/jaw-harp.html"),
    "PianoFB-small": ("CC0-1.0", "FreePats Old Piano FB", "https://freepats.zenvoid.org/Piano/honky-tonk-piano.html"),
    "SynthStrings1": ("CC0-1.0", "FreePats Synth Strings 1", "https://freepats.zenvoid.org/Synthesizer/synth-strings.html"),
    "SynthBrass1": ("CC0-1.0", "FreePats Synth Brass 1", "https://freepats.zenvoid.org/Synthesizer/synth-brass.html"),
    "WorldPercussion": ("CC0-1.0", "FreePats World Percussion", "https://freepats.zenvoid.org/Percussion/world-and-rare-percussion.html"),
    "Glass": ("CC0-1.0", "FreePats Glasses of Water", "https://freepats.zenvoid.org/ChromaticPercussion/glass.html"),
}

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
NOTE_RE = re.compile(r"(?:^|[_\-\s])([A-Ga-g])(#|b)?(-?\d)(?=[_\-\s.]|$)")

# Melody used for assembled phrases: (scale degree in semitones, beats).
PHRASE = [(0, 1), (2, 1), (4, 1), (5, 1), (7, 2), (4, 1), (2, 1), (0, 3)]
PHRASE_SHORT = [(0, 1), (0, 1), (4, 1), (4, 1), (7, 1), (7, 1), (4, 1), (0, 1), (2, 1), (2, 1), (5, 1), (5, 1), (4, 1), (2, 1), (0, 2)]
BEAT = 0.42


# ------------------------------------------------------------------ utilities

def log(*a):
    print(*a, flush=True)


def find_ffmpeg():
    exe = os.environ.get("FFMPEG") or shutil.which("ffmpeg")
    if not exe:
        hits = glob.glob(os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\*\bin\ffmpeg.exe"))
        exe = hits[0] if hits else None
    if not exe:
        sys.exit("ffmpeg not found. Install it or set FFMPEG=/path/to/ffmpeg")
    return exe


FFMPEG = find_ffmpeg()
FFPROBE = str(Path(FFMPEG).with_name("ffprobe" + Path(FFMPEG).suffix))


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def note_name(m):
    m = int(round(m))
    return f"{NOTE_NAMES[m % 12]}{m // 12 - 1}"


def parse_note(name):
    m = NOTE_RE.search(Path(name).stem)
    if not m:
        return None
    letter, acc, octv = m.groups()
    pc = PC[letter.upper()] + (1 if acc == "#" else -1 if acc == "b" else 0)
    return (int(octv) + 1) * 12 + pc


def http_get(url, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    # Wikimedia asks for a descriptive User-Agent and rate-limits bursts (HTTP 429).
    req = urllib.request.Request(url, headers={"User-Agent": "InstrumediaBuild/1.0 (open-source instrument reference; sample sourcing)"})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
                shutil.copyfileobj(r, f)
            tmp.replace(dest)
            return dest
        except Exception as e:  # network hiccups and rate limits: retry with backoff
            if attempt == 5:
                raise RuntimeError(f"download failed: {url}: {e}")
            wait = 5 * (attempt + 1)
            retry_after = getattr(e, "headers", None) and e.headers.get("Retry-After")
            if retry_after and str(retry_after).isdigit():
                wait = max(wait, int(retry_after))
            elif getattr(e, "code", None) == 429:
                wait = 30 * (attempt + 1)
            time.sleep(wait)


# ------------------------------------------------------------------ sources

_TREES = {}


def tree(src):
    """Directory -> [audio file names] for a GitHub-hosted library."""
    if src in _TREES:
        return _TREES[src]
    path = CACHE / "trees" / f"{src}.json"
    if not path.exists():
        owner, repo, branch = REPOS[src].split("/")
        http_get(f"https://api.github.com/repos/{owner}/{repo}/git/trees/{branch}?recursive=1", path)
    data = json.loads(path.read_text(encoding="utf-8"))
    out = {}
    for item in data["tree"]:
        if item["type"] == "blob" and item["path"].lower().endswith((".wav", ".flac")):
            d, n = item["path"].rsplit("/", 1)
            out.setdefault(d, []).append(n)
    _TREES[src] = out
    return out


def remote_url(src, relpath):
    owner, repo, branch = REPOS[src].split("/")
    return f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/" + urllib.parse.quote(relpath)


def fetch(src, relpath):
    local = CACHE / src / relpath
    if not local.exists():
        http_get(remote_url(src, relpath), local)
    return local


def freepats_dir(bank):
    hits = [p for p in (CACHE / "freepats" / bank).glob("*") if p.is_dir()]
    if not hits:
        sys.exit(f"FreePats bank {bank} missing. Run tools/fetch_freepats.py")
    return hits[0]


def parse_sfz(bank, want=None):
    """Return one region per key: dicts with file, key, loop points."""
    base = freepats_dir(bank)
    files = sorted(base.glob("*.sfz"))
    if want:
        files = [f for f in files if want.lower() in f.name.lower()] or files
    text = files[0].read_text(encoding="utf-8", errors="replace")
    text = re.sub(r"//[^\n]*", "", text)
    default_path = ""
    regions, group, glob_ = [], {}, {}
    for tag, body in re.findall(r"<(\w+)>([^<]*)", text):
        opts = dict(re.findall(r"(\w+)=(.+?)(?=\s+\w+=|\s*$)", body.strip(), flags=re.M))
        opts = {k: v.strip() for k, v in opts.items()}
        if tag == "control":
            default_path = opts.get("default_path", "")
        elif tag == "global":
            glob_ = opts
        elif tag in ("group", "master"):
            group = opts
        elif tag == "region":
            r = {**glob_, **group, **opts}
            key = r.get("pitch_keycenter") or r.get("key") or r.get("lokey")
            if not key or "sample" not in r:
                continue
            try:
                key = int(key)
            except ValueError:
                key = parse_note("_" + key) or 60
            path = base / (default_path + r["sample"].replace("\\", "/"))
            # skip missing files and non-note effects (e.g. the ukulele's "chuck")
            if not path.exists() or path.stat().st_size < 1024 or re.search(r"chuck|noise|click|fx", path.stem, re.I):
                continue
            regions.append({
                "file": path,
                "key": key,
                "hivel": int(r.get("hivel", 127)),
                "lorand": float(r.get("lorand", 0)),
                "loop": (int(r["loop_start"]), int(r["loop_end"])) if "loop_start" in r and "loop_end" in r and "loop" in r.get("loop_mode", "") and "no_loop" not in r.get("loop_mode", "") else None,
            })
    by_key = {}
    for r in regions:
        best = by_key.get(r["key"])
        # prefer the loud-but-not-maximum layer and the first round robin
        score = -abs(r["hivel"] - 110) - r["lorand"] * 10
        if not best or score > best[0]:
            by_key[r["key"]] = (score, r)
    return base, [v[1] for v in sorted(by_key.values(), key=lambda v: v[1]["key"])]


COMMONS_API = "https://commons.wikimedia.org/w/api.php"


def commons_key(title):
    """Cache filename: readable part plus a hash, so all-CJK titles don't collide."""
    name = title.replace("File:", "")
    ext = Path(name).suffix.lower()
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(name).stem).strip("_")[:60]
    return f"{stem or 'file'}-{hashlib.sha1(title.encode()).hexdigest()[:8]}{ext}"


def commons(title):
    """Download a Wikimedia Commons file (cached) and return (path, metadata)."""
    key = commons_key(title)
    meta_path = CACHE / "commons" / (key + ".json")
    if not meta_path.exists():
        q = urllib.parse.urlencode({"action": "query", "titles": title, "prop": "imageinfo",
                                    "iiprop": "url|extmetadata", "format": "json", "formatversion": "2"})
        http_get(f"{COMMONS_API}?{q}", meta_path)
    page = json.loads(meta_path.read_text(encoding="utf-8"))["query"]["pages"][0]
    ii = page["imageinfo"][0]
    em = ii.get("extmetadata", {})
    strip = lambda v: re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", v or "")).strip()
    meta = {
        "source": "commons", "file": title, "url": ii["descriptionurl"],
        "license": strip(em.get("LicenseShortName", {}).get("value")),
        "artist": strip(em.get("Artist", {}).get("value")) or "Unknown author",
    }
    audio = CACHE / "commons" / key
    if not audio.exists():
        http_get(ii["url"].split("?")[0], audio)
    return audio, meta


def best_window(x, dur):
    """Start (s) of the steadiest, most active `dur`-second stretch: skips silence,
    applause-like bursts and fade-ins at the edges."""
    if len(x) <= dur * SR:
        return 0.0
    hop = int(0.1 * SR)
    frames = np.array([np.sqrt(np.mean(x[i:i + hop] ** 2) + 1e-12) for i in range(0, len(x) - hop, hop)])
    lv = 20 * np.log10(frames)
    w = int(dur / 0.1)
    lo = min(10, max(0, len(lv) - w))
    hi = max(lo, len(lv) - w - 10)
    best, best_s = -1e9, lo
    for i in range(lo, hi + 1):
        seg = lv[i:i + w]
        score = np.median(seg) - 0.6 * np.std(seg) - 2.0 * np.mean(seg < np.max(lv) - 35)
        if score > best:
            best, best_s = score, i
    return best_s * 0.1


# ------------------------------------------------------------------ audio io

def probe_sr(path):
    out = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate",
                          "-of", "csv=p=0", str(path)], capture_output=True, text=True)
    return int(out.stdout.strip() or SR)


def load(path, loop=None, min_len=None):
    """Load any audio file as mono float32 at SR. Optionally extend a sustain loop."""
    native = probe_sr(path)
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", str(path), "-ac", "1", "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    x = np.frombuffer(raw, dtype=np.float32).copy()
    if loop and min_len:
        ls, le = loop
        need = int(min_len * native)
        if 0 <= ls < le <= len(x) and len(x) < need:
            seg = x[ls:le]
            reps = int(np.ceil((need - ls) / len(seg))) + 1
            x = np.concatenate([x[:ls], np.tile(seg, reps)])[:need + native]
    if native != SR:
        g = np.gcd(native, SR)
        x = signal.resample_poly(x, SR // g, native // g).astype(np.float32)
    return x


def encode(x, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "-",
                    "-c:a", "libmp3lame", "-q:a", "4", str(dest)],
                   input=np.ascontiguousarray(x, dtype=np.float32).tobytes(), check=True)


# ------------------------------------------------------------------ dsp

METER = pyloudnorm.Meter(SR)


def db(v):
    return 20 * np.log10(max(v, 1e-12))


def trim(x, max_dur, fade=0.3):
    """Start at the onset, stop at the tail (or max_dur with a fade)."""
    if len(x) == 0:
        return x
    peak = np.max(np.abs(x)) or 1.0
    above = np.nonzero(np.abs(x) > peak * 10 ** (-42 / 20))[0]
    if len(above) == 0:
        return x[:int(0.5 * SR)]
    start = max(0, above[0] - int(0.004 * SR))
    end = min(len(x), above[-1] + int(0.05 * SR))
    tail = np.nonzero(np.abs(x[start:end]) > peak * 10 ** (-60 / 20))[0]
    if len(tail):
        end = start + tail[-1] + int(0.05 * SR)
    y = x[start:end].copy()
    if len(y) > max_dur * SR:
        y = y[:int(max_dur * SR)]
        f = int(fade * SR)
        y[-f:] *= np.linspace(1, 0, f) ** 2
    ramp = min(len(y), int(0.002 * SR))
    y[:ramp] *= np.linspace(0, 1, ramp)
    return y


def normalize(x, target=-20.0):
    if len(x) == 0:
        return x
    probe = x if len(x) >= int(0.5 * SR) else np.pad(x, (0, int(0.5 * SR) - len(x)))
    try:
        lufs = METER.integrated_loudness(probe.astype(np.float64))
    except Exception:
        lufs = float("-inf")
    if not np.isfinite(lufs):
        y = x / (np.max(np.abs(x)) or 1) * 0.5
    else:
        y = x * 10 ** ((target - lufs) / 20)
    peak = np.max(np.abs(y))
    if peak > 0.89:
        y *= 0.89 / peak
    return y.astype(np.float32)


def yin(x, fmin=28.0, fmax=4200.0):
    """Median YIN estimate across a few windows after the attack. Returns MIDI or None."""
    n = 4096
    tau_min, tau_max = int(SR / fmax), int(SR / fmin)
    ests = []
    for off in (0.12, 0.25, 0.4, 0.6):
        s = int(off * SR)
        w = x[s:s + n + tau_max]
        if len(w) < n + tau_max:
            break
        w = w - w.mean()
        if np.max(np.abs(w)) < 1e-4:
            continue
        # difference function via autocorrelation
        a = w[:n]
        d = np.array([np.sum((a - w[t:t + n]) ** 2) for t in range(tau_max)])
        cmnd = np.ones_like(d)
        cmnd[1:] = d[1:] * np.arange(1, tau_max) / np.maximum(np.cumsum(d[1:]), 1e-12)
        cand = np.nonzero(cmnd[tau_min:] < 0.2)[0]
        if not len(cand):
            continue
        t = cand[0] + tau_min
        while t + 1 < tau_max and cmnd[t + 1] < cmnd[t]:
            t += 1
        if 1 <= t < tau_max - 1:  # parabolic refinement
            y0, y1, y2 = cmnd[t - 1], cmnd[t], cmnd[t + 1]
            denom = y0 - 2 * y1 + y2
            t = t + (0.5 * (y0 - y2) / denom if denom else 0)
        ests.append(69 + 12 * np.log2(SR / t / 440))
    return float(np.median(ests)) if ests else None


def octave_offset(pairs):
    """Vote the octave convention of a file set: pairs of (name_midi, detected)."""
    ks = []
    for name, det in pairs:
        if det is None:
            continue
        k = round((det - name) / 12)
        if abs(det - name - 12 * k) < 1.2:
            ks.append(k)
    return int(np.median(ks)) * 12 if ks else 0


def peaks(x, n=180):
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    if len(x) == 0:
        return "A" * n
    edges = np.linspace(0, len(x), n + 1).astype(int)
    v = np.array([np.max(np.abs(x[edges[i]:max(edges[i + 1], edges[i] + 1)])) for i in range(n)])
    v = v / (np.max(v) or 1)
    return "".join(alphabet[int(round(c * 63))] for c in v)


SPEC_STOPS = np.array([
    [0.00, 30, 8, 20, 0],
    [0.22, 90, 20, 45, 120],
    [0.45, 170, 45, 40, 200],
    [0.68, 232, 110, 45, 245],
    [0.86, 250, 185, 90, 255],
    [1.00, 255, 244, 214, 255],
])


def spectrogram(x, dest, w=360, h=128, fmin=40.0, fmax=16000.0):
    nfft = 2048
    if len(x) < nfft:
        x = np.pad(x, (0, nfft - len(x)))
    starts = np.linspace(0, len(x) - nfft, w).astype(int)
    win = np.hanning(nfft)
    frames = np.stack([x[s:s + nfft] * win for s in starts])
    mag = np.abs(np.fft.rfft(frames, axis=1))
    bins = np.fft.rfftfreq(nfft, 1 / SR)
    rows = np.geomspace(fmin, fmax, h)
    img = np.stack([np.interp(rows, bins, m) for m in mag], axis=1)
    level = 20 * np.log10(img + 1e-9)
    level -= level.max()
    v = np.clip((level + 72) / 72, 0, 1)[::-1]
    rgba = np.stack([np.interp(v, SPEC_STOPS[:, 0], SPEC_STOPS[:, c]) for c in range(1, 5)], axis=-1)
    dest.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba.astype(np.uint8), "RGBA").save(dest, "WEBP", quality=80, method=6)


def reverb(x, secs=1.1, wet=0.22):
    n = int(secs * SR)
    t = np.arange(n) / SR
    ir = synth.RNG.standard_normal(n) * np.exp(-t / (secs / 5))
    ir = signal.sosfilt(signal.butter(2, 6000, "lowpass", fs=SR, output="sos"), ir)
    ir /= np.sqrt(np.sum(ir ** 2))
    tail = signal.fftconvolve(x, ir)[: len(x) + n]
    dry = np.pad(x, (0, len(tail) - len(x)))
    return dry * (1 - wet) + tail * wet * 0.9


# ------------------------------------------------------------------ context renders

_KIT = {}


def kit(piece, q):
    key = (piece, q)
    if key not in _KIT:
        files = sorted((freepats_dir("MuldjordKit") / "samples" / piece).glob("*.flac"),
                       key=lambda p: int(re.match(r"\d+", p.name).group()))
        f = files[min(len(files) - 1, int(q * len(files)))]
        _KIT[key] = (trim(load(f), 2.0), f)
    return _KIT[key]


def speech_noise(n):
    """Pink-ish noise band-limited to speech and chopped into syllables."""
    w = synth.RNG.standard_normal(n)
    pink = signal.lfilter([0.049922035, -0.095993537, 0.050612699, -0.004408786],
                          [1, -2.494956002, 2.017265875, -0.522189400], w)
    band = signal.sosfilt(signal.butter(3, [220, 3400], "bandpass", fs=SR, output="sos"), pink)
    rate = synth.RNG.uniform(3.2, 5.0)
    t = np.arange(n) / SR
    env = np.clip(np.sin(2 * np.pi * rate * t + 2 * np.sin(2 * np.pi * 0.7 * t)), 0, None) ** 1.5
    env = signal.sosfilt(signal.butter(2, 18, "lowpass", fs=SR, output="sos"), env)
    return band * env


def busy_mix(phrase):
    n = len(phrase) + int(0.4 * SR)
    drums = np.zeros(n)
    step = BEAT / 2
    k, _ = kit("KdrumL", 0.7)
    s, _ = kit("Snare1", 0.7)
    h, _ = kit("HihatClosed", 0.55)
    for i in range(int(n / SR / step)):
        pos = int(i * step * SR)
        parts = [(h, 0.5 if i % 2 else 0.8)]
        if i % 8 in (0, 5):
            parts.append((k, 1.0))
        if i % 8 in (2, 6):
            parts.append((s, 0.9))
        for x, g in parts:
            end = min(n, pos + len(x))
            drums[pos:end] += x[:end - pos] * g
    wet = reverb(phrase)[:n]
    wet = np.pad(wet, (0, n - len(wet)))
    mix = (normalize(wet, -20) + normalize(drums, -24) + normalize(speech_noise(n), -25))
    return normalize(mix, -18)


def small_speaker(x):
    y = signal.sosfilt(signal.butter(4, [320, 3600], "bandpass", fs=SR, output="sos"), x)
    y = np.tanh(2.2 * y / (np.max(np.abs(y)) or 1)) * 0.8
    return normalize(y, -20)


def groove(hit):
    n = int(8 * BEAT * SR) + len(hit)
    out = np.zeros(n)
    accents = [1, 0.45, 0.7, 0.45, 0.9, 0.45, 0.7, 0.55]
    for i in range(16):
        pos = int(i * BEAT / 2 * SR)
        end = min(n, pos + len(hit))
        out[pos:end] += hit[:end - pos] * accents[i % 8]
    return out


# ------------------------------------------------------------------ selection

def score_name(name, prefer):
    s = 0
    for tok in prefer or []:
        if tok in name:
            s += 10
    low = name.lower()
    if re.search(r"(rr|_)1(\D|$)", low) or "rr1" in low:
        s += 2
    for mic in ("main", "sum", "mid"):
        if mic in low:
            s += 1
    if "rel" in low.split("_"):
        s -= 50
    return s


def candidates(spec):
    """Map name-midi -> (loader, origin) for a pitched sample spec."""
    src = spec["src"]
    out = {}
    if src in REPOS:
        files = tree(src).get(spec["dir"], [])
        if not files:
            raise RuntimeError(f"no files in {src}:{spec['dir']}")
        best = {}
        for f in files:
            if spec.get("match") and not re.search(spec["match"], f):
                continue
            m = parse_note(f)
            if m is None:
                continue
            sc = score_name(f, spec.get("prefer"))
            if m not in best or sc > best[m][0]:
                best[m] = (sc, f)
        for m, (_, f) in best.items():
            rel = f"{spec['dir']}/{f}"
            out[m] = (lambda rel=rel: load(fetch(src, rel)),
                      {"source": src, "file": rel, "url": remote_url(src, rel)})
    elif src == "freepats":
        base, regions = parse_sfz(spec["bank"], spec.get("sfz"))
        for r in regions:
            rel = r["file"].relative_to(freepats_dir(spec["bank"])).as_posix()
            out[r["key"]] = (lambda r=r: load(r["file"], r["loop"], min_len=4.0),
                             {"source": "freepats", "bank": spec["bank"], "file": rel})
    elif src == "generated":
        _, notes = synth.PRESETS[spec["preset"]]
        for m in notes:
            out[m] = (lambda m=m: synth.render(spec["preset"], m),
                      {"source": "generated", "preset": spec["preset"]})
    return out


def spread(keys, count):
    keys = sorted(keys)
    if len(keys) <= count:
        return keys
    qs = np.linspace(0.06, 0.94, count)
    idx = sorted({int(round(q * (len(keys) - 1))) for q in qs})
    return [keys[i] for i in idx]


def phrase_notes(keys, pattern):
    """Plan a melody as (target pitch, recorded note to use, beats)."""
    keys = sorted(keys)
    lo, hi = keys[0], keys[-1]
    root_target = lo + (hi - lo) * 0.42
    root = min(keys, key=lambda k: abs(k - root_target))
    if root + 7 > hi:  # keep the melody inside the range
        root = min(keys, key=lambda k: abs(k - (hi - 7)))
    return [(root + deg, min(keys, key=lambda k: abs(k - (root + deg))), beats) for deg, beats in pattern]


def repitch(x, semitones):
    """Sampler-style transposition by resampling (fine for the few semitones between recorded notes)."""
    if abs(semitones) < 0.01:
        return x
    ratio = 2 ** (semitones / 12)
    idx = np.arange(0, len(x) - 1, ratio)
    return np.interp(idx, np.arange(len(x)), x).astype(np.float32)


def assemble(parts, held, beat):
    """parts: list of (audio, beats). Returns one phrase."""
    slots = [int(b * beat * SR) for _, b in parts]
    total = sum(slots) + int((2.2 if not held else 0.6) * SR)
    out = np.zeros(total, dtype=np.float32)
    pos = 0
    for (x, b), slot in zip(parts, slots):
        x = trim(x, 6.0)
        if held:
            L = min(len(x), slot + int(0.05 * SR))
            seg = x[:L].copy()
            r = min(L, int(0.07 * SR))
            seg[-r:] *= np.linspace(1, 0, r)
        else:
            L = min(len(x), slot + int(1.6 * SR))
            seg = x[:L].copy()
            r = min(L, int(0.35 * SR))
            seg[-r:] *= np.linspace(1, 0, r) ** 2
        # level each note so the phrase is even
        seg = seg / (np.max(np.abs(seg[:int(0.3 * SR)])) or 1)
        end = min(total, pos + len(seg))
        out[pos:end] += seg[:end - pos]
        pos += slot
    return trim(out, 20)


# ------------------------------------------------------------------ per instrument

def is_held(inst):
    s = inst["traits"].get("sustain")
    return s == "held" or (isinstance(s, list) and s[0] == "held")


def build_instrument(inst):
    """Render every clip for one instrument. Returns list of sample dicts."""
    iid = inst["id"]
    held = is_held(inst)
    samples = []
    outdir = AUDIO / iid
    if outdir.exists():
        shutil.rmtree(outdir)

    def emit(key, label, group, x, origin, midi=None, note_dur=None):
        x = normalize(x)
        encode(x, outdir / f"{key}.mp3")
        spectrogram(x, outdir / f"{key}.webp")
        samples.append({
            "key": key, "label": label, "group": group,
            "midi": None if midi is None else round(float(midi), 2),
            "note": None if midi is None else note_name(midi),
            "dur": round(len(x) / SR, 2),
            "peaks": peaks(x),
            "origin": origin if isinstance(origin, list) else [origin],
        })

    spec = inst.get("samples", {})
    max_note = 2.6 if held else 3.6
    offset = 0
    main_center = None

    if "notes" in spec:
        ns = spec["notes"]
        cands = candidates(ns)
        if not cands:
            raise RuntimeError(f"{iid}: no pitched candidates")
        chosen = spread(cands.keys(), ns.get("count", 5))
        loaded = {m: cands[m][0]() for m in chosen}
        if ns["src"] in ("freepats", "generated"):
            offset = 0
        else:
            offset = octave_offset([(m, yin(trim(loaded[m], 3))) for m in chosen])
        main_center = float(np.median(chosen))
        for i, m in enumerate(chosen, 1):
            emit(f"note-{i}", note_name(m + offset), "register", trim(loaded[m], max_note), cands[m][1], midi=m + offset)

        if ns.get("phrase") and len(cands) >= 3:
            if ns["src"] == "generated" and ns["preset"] == "synth-pad":
                chords = [[0, 4, 7], [-3, 0, 4], [-7, -3, 0], [-5, -1, 2]]
                root = chosen[len(chosen) // 2]
                bars = [sum(synth.render("synth-pad", root + d + 12, gate=1.5) for d in ch) for ch in chords]
                parts = [(b, 4) for b in bars]
                phrase = assemble(parts, True, BEAT)
                origin = [cands[chosen[0]][1]]
            else:
                if ns["src"] == "generated":
                    # Synths can play any pitch, so play the melody exactly rather than snapping to stored notes.
                    root = chosen[len(chosen) // 2]
                    plan = [(root + deg, b) for deg, b in PHRASE]
                    if ns["preset"] == "theremin":
                        phrase = trim(synth.theremin_phrase(plan, BEAT), 20)
                    else:
                        parts = [(synth.render(ns["preset"], m, gate=b * BEAT * 0.9), b) for m, b in plan]
                        phrase = assemble(parts, held, BEAT)
                    origin = [cands[chosen[0]][1]]
                else:
                    plan = phrase_notes(cands.keys(), PHRASE)
                    need = {m for _, m, _ in plan}
                    for m in need:
                        if m not in loaded:
                            loaded[m] = cands[m][0]()
                    phrase = assemble([(repitch(loaded[m], t - m), b) for t, m, b in plan], held, BEAT)
                    origin = [cands[m][1] for m in sorted(need)]
            emit("phrase", "Phrase", "phrase", phrase, origin)
            emit("mix", "Buried in a busy mix", "context", busy_mix(phrase),
                 origin + [{"source": "freepats", "bank": "MuldjordKit", "file": "drum groove (kick, snare, hi-hat)"},
                           {"source": "generated", "preset": "speech-shaped noise and room reverb"}])
            emit("phone", "Through a small speaker", "context", small_speaker(phrase), origin)

    for k, ex in enumerate(spec.get("excerpts", []), 1):
        path, meta = commons(ex["file"])
        full = load(path)
        dur = ex.get("dur", 8.0)
        start = ex["start"] if "start" in ex else best_window(full, dur)
        x = full[int(start * SR): int((start + dur) * SR)].copy()
        fi, fo = min(len(x), int(0.02 * SR)), min(len(x), int(0.25 * SR))
        x[:fi] *= np.linspace(0, 1, fi)
        x[-fo:] *= np.linspace(1, 0, fo) ** 2
        origin = {**meta, "excerpt": f"{start:.1f}-{start + dur:.1f}s"}
        key = "phrase" if k == 1 and not any(s["key"] == "phrase" for s in samples) else f"excerpt-{k}"
        emit(key, ex.get("label", "Recording"), "phrase", x, origin)
        if key == "phrase":
            emit("mix", "Buried in a busy mix", "context", busy_mix(x),
                 [origin, {"source": "freepats", "bank": "MuldjordKit", "file": "drum groove (kick, snare, hi-hat)"},
                  {"source": "generated", "preset": "speech-shaped noise and room reverb"}])
            emit("phone", "Through a small speaker", "context", small_speaker(x), origin)

    for v in spec.get("variants", []):
        cands = candidates(v)
        if not cands:
            log(f"  ! {iid}: variant {v['label']} has no files")
            continue
        target = main_center if main_center is not None else float(np.median(list(cands.keys())))
        m = min(cands.keys(), key=lambda k: abs(k - target))
        x = cands[m][0]()
        vs = slug(v["label"])
        emit(f"v-{vs}", v["label"], "technique", trim(x, max_note), cands[m][1], midi=m + offset)
        if v.get("phrase") and len(cands) >= 3:
            plan = phrase_notes(cands.keys(), PHRASE_SHORT)
            cache = {m: cands[m][0]() for m in {m for _, m, _ in plan}}
            parts = [(repitch(cache[m], t - m), b) for t, m, b in plan]
            emit(f"phrase-{vs}", f"Phrase, {v['label'].lower()}", "phrase", assemble(parts, False, BEAT / 2),
                 [cands[m][1] for m in sorted(cache)])

    hit_i = 0
    first_hit = None
    for h in spec.get("hits", []):
        picks = []
        if h["src"] in REPOS:
            files = tree(h["src"]).get(h["dir"], [])
            files = [f for f in files if (not h.get("match") or re.search(h["match"], f, re.I))
                     and (not h.get("exclude") or not re.search(h["exclude"], f))]
            files.sort(key=lambda f: -score_name(f, h.get("prefer")))
            for f in files[: h.get("limit", 1)]:
                rel = f"{h['dir']}/{f}"
                picks.append((lambda rel=rel, src=h["src"]: load(fetch(src, rel)),
                              {"source": h["src"], "file": rel, "url": remote_url(h["src"], rel)}))
        elif h["src"] == "freepats":
            files = sorted((freepats_dir(h["bank"]) / "samples" / h["files"]).glob("*.flac"),
                           key=lambda p: int(re.match(r"\d+", p.name).group()))
            for q in (0.8, 0.5)[: h.get("limit", 1)]:
                f = files[min(len(files) - 1, int(q * len(files)))]
                picks.append((lambda f=f: load(f),
                              {"source": "freepats", "bank": h["bank"],
                               "file": f.relative_to(freepats_dir(h["bank"])).as_posix()}))
        elif h["src"] == "generated":
            picks.append((lambda p=h["preset"]: synth.render(p), {"source": "generated", "preset": h["preset"]}))
        if not picks:
            log(f"  ! {iid}: hit '{h['label']}' matched nothing")
        for j, (loader, origin) in enumerate(picks):
            hit_i += 1
            x = trim(loader(), 6.0 if inst["family"] == "metal" else 4.5)
            label = h["label"] if len(picks) == 1 else f"{h['label']} {j + 1}"
            emit(f"hit-{hit_i}", label, "hits", x, origin)
            if first_hit is None:
                first_hit = (x, origin)

    if first_hit is not None and len(first_hit[0]) < 1.3 * SR and inst["id"] != "drum-machine":
        emit("groove", "Groove", "phrase", groove(first_hit[0]), first_hit[1])
    if inst["id"] == "drum-machine":
        parts = {p: synth.render(p) for p in ("dm-kick", "dm-snare", "dm-hat", "dm-clap")}
        n = int(16 * BEAT / 2 * SR) + SR
        beat = np.zeros(n)
        for i in range(16):
            pos = int(i * BEAT / 2 * SR)
            hits = [("dm-hat", 0.5)]
            if i % 8 in (0, 3, 5):
                hits.append(("dm-kick", 1.0))
            if i % 8 == 4:
                hits.append(("dm-snare", 0.8))
            if i % 16 == 12:
                hits.append(("dm-clap", 0.7))
            for p, g in hits:
                x = parts[p]
                end = min(n, pos + len(x))
                beat[pos:end] += x[:end - pos] * g
        emit("groove", "Beat", "phrase", beat, {"source": "generated", "preset": "drum-machine pattern"})
    return samples


def spec_hash(inst):
    blob = json.dumps({"v": BUILD_VERSION, "inst": inst.get("samples"), "traits": inst.get("traits"),
                       "synth": Path(synth.__file__).stat().st_mtime if inst.get("family") == "electronic" else 0},
                      sort_keys=True, default=str)
    return hashlib.sha1(blob.encode()).hexdigest()[:16]


def worker(inst, force):
    cache = CACHE / "built" / f"{inst['id']}.json"
    h = spec_hash(inst)
    if not force and cache.exists():
        prev = json.loads(cache.read_text(encoding="utf-8"))
        if prev["hash"] == h and all((AUDIO / inst["id"] / f"{s['key']}.mp3").exists() for s in prev["samples"]):
            return inst["id"], prev["samples"], "cached"
    t0 = time.time()
    samples = build_instrument(inst)
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps({"hash": h, "samples": samples}), encoding="utf-8")
    return inst["id"], samples, f"{len(samples)} clips in {time.time() - t0:.0f}s"


# ------------------------------------------------------------------ output

def license_for(origin, lib):
    src = origin["source"]
    if src == "commons":
        return origin["license"], f"{origin['artist']} (Wikimedia Commons)", origin["url"]
    if src == "freepats":
        lic, credit, url = FREEPATS[origin["bank"]]
        return lic, credit, url
    s = lib["sources"][src]
    return s["license"], s["credit"], origin.get("url") or s["url"]


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="comma-separated instrument ids")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--jobs", type=int, default=max(2, (os.cpu_count() or 4) - 2))
    args = ap.parse_args()

    lib = yaml.safe_load((ROOT / "data" / "library.yaml").read_text(encoding="utf-8"))
    insts = lib["instruments"]
    ids = {i["id"] for i in insts}
    fams = {f["id"] for f in lib["families"]}
    for i in insts:
        assert i["family"] in fams, f"{i['id']}: unknown family {i['family']}"
        for c in i.get("confusions", []):
            assert c["id"] in ids, f"{i['id']}: confusion target {c['id']} not defined"

    todo = [i for i in insts if i.get("status") != "wanted" and "samples" in i]
    if args.only:
        only = set(args.only.split(","))
        todo = [i for i in todo if i["id"] in only]
    for src in REPOS:
        tree(src)
    # Wikimedia rate-limits parallel downloads, so fetch Commons files one at a time up front.
    titles = [ex["file"] for i in todo for ex in i.get("samples", {}).get("excerpts", [])]
    missing = [t for t in titles if not (CACHE / "commons" / commons_key(t)).exists()]
    for n, t in enumerate(missing, 1):
        log(f"  fetching from Commons ({n}/{len(missing)}): {t}")
        try:
            commons(t)
        except Exception as e:
            log(f"  ! {t}: {e}")
        time.sleep(3)

    built = {}
    for f in (CACHE / "built").glob("*.json"):
        built[f.stem] = json.loads(f.read_text(encoding="utf-8"))["samples"]

    failures = []
    with cf.ProcessPoolExecutor(max_workers=args.jobs) as ex:
        futs = {ex.submit(worker, i, args.force): i["id"] for i in todo}
        for fut in cf.as_completed(futs):
            iid = futs[fut]
            try:
                _, samples, msg = fut.result()
                built[iid] = samples
                log(f"  {iid:28s} {msg}")
            except Exception as e:
                failures.append((iid, e))
                log(f"  ! {iid:26s} FAILED: {e}")

    # symmetric confusion map: if A lists B, B also points back to A
    conf = {i["id"]: {c["id"]: c["cue"] for c in i.get("confusions", [])} for i in insts}
    for a in list(conf):
        for b, cue in list(conf[a].items()):
            if a not in conf[b]:
                conf[b][a] = cue
    provenance = {}
    out_insts = []
    for i in insts:
        samples = built.get(i["id"], []) if i.get("status") != "wanted" else []
        for s in samples:
            s["src"] = f"audio/{i['id']}/{s['key']}.mp3"
            s["spec"] = f"audio/{i['id']}/{s['key']}.webp"
            lic = {license_for(o, lib)[0] for o in s["origin"]}
            s["license"] = " + ".join(sorted(lic))
            provenance[f"{i['id']}/{s['key']}"] = [
                {**o, "license": license_for(o, lib)[0], "credit": license_for(o, lib)[1]} for o in s["origin"]]
        slim = [{k: v for k, v in s.items() if k != "origin"} for s in samples]
        for s, full in zip(slim, samples):
            s["credit"] = sorted({license_for(o, lib)[1] for o in full["origin"]})
            link = next((o["url"] for o in full["origin"] if o.get("source") == "commons"), None)
            if link:
                s["link"] = link
        mids = [s["midi"] for s in samples if s.get("midi") is not None and s["group"] == "register"]
        out_insts.append({
            "id": i["id"], "name": i["name"], "family": i["family"], "sub": i.get("sub"),
            "aliases": i.get("aliases", []), "status": i.get("status", "ready"),
            "traits": {k: (v if isinstance(v, list) else [v]) for k, v in i["traits"].items()},
            "summary": i.get("summary", ""), "listen": i.get("listen", []), "note": i.get("note"),
            "confusions": [{"id": k, "cue": v} for k, v in conf[i["id"]].items()],
            "range": [min(mids), max(mids)] if mids else None,
            "samples": slim,
        })

    # validate question examples
    have = {f"{i['id']}/{s['key']}" for i in out_insts for s in i["samples"]}
    for q in lib["questions"]:
        for o in q["options"]:
            if o["example"] not in have:
                log(f"  ! question {q['id']}: example {o['example']} missing")

    data = {
        "version": time.strftime("%Y-%m-%d"),
        "families": lib["families"],
        "questions": lib["questions"],
        "sources": lib["sources"],
        "instruments": out_insts,
    }
    js = "/* generated by tools/build.py, do not edit */\nwindow.INSTRUMEDIA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n"
    (ROOT / "js" / "data.js").write_text(js, encoding="utf-8")
    (ROOT / "data" / "provenance.json").write_text(json.dumps(provenance, indent=1, ensure_ascii=False), encoding="utf-8")
    write_sources_md(lib, provenance)
    ready = sum(1 for i in out_insts if i["samples"])
    clips = sum(len(i["samples"]) for i in out_insts)
    log(f"\n{ready} instruments with audio, {clips} clips, {len(out_insts) - ready} listed without audio.")
    if failures:
        log(f"{len(failures)} failed: " + ", ".join(f for f, _ in failures))
        sys.exit(1)


def write_sources_md(lib, provenance):
    counts = {}
    for entries in provenance.values():
        for o in entries:
            key = (o["credit"], o["license"])
            counts[key] = counts.get(key, 0) + 1
    lines = [
        "# Sources and licenses",
        "",
        "Every reference clip in `audio/` is an excerpt of a recording released under an open license,",
        "or was generated in code for this project. Clip-level detail (original file, URL, license)",
        "is in [`data/provenance.json`](data/provenance.json).",
        "",
        "Processing applied to all clips: trimmed to the onset, faded, mixed to mono, loudness-normalized",
        "to about -20 LUFS, encoded as MP3. Phrases are assembled from individual recorded notes.",
        "\"Busy mix\" clips add a drum groove (MuldjordKit), speech-shaped noise and synthetic reverb.",
        "",
        "| Source | License | Clips |",
        "| --- | --- | ---: |",
    ]
    for (credit, lic), n in sorted(counts.items(), key=lambda kv: -kv[1]):
        lines.append(f"| {credit} | {lic} | {n} |")
    lines += [
        "",
        "## Attribution notices",
        "",
        "- **MuldjordKit** by Lars Muldjord (www.muldjord.com), FreePats stereo version. Licensed under",
        "  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Used in the kick, crash and ride clips",
        "  and as the drum groove in every \"busy mix\" clip.",
        "- **FSS Steel-String Guitar**: Copyright 2008 Gary Campion (FlameStudios), modified by FreePats.",
        "  Distributed under the GNU GPL v3 or later with the FreePats sound-bank exception",
        "  (https://freepats.zenvoid.org/licenses.html).",
        "- **VCSL and VSCO 2 CE** by Versilian Studios are CC0. Credit is given as a courtesy.",
        "",
    ]
    commons_rows = {}
    for ref, entries in provenance.items():
        for o in entries:
            if o.get("source") == "commons":
                commons_rows.setdefault(o["file"], (ref.split("/")[0], o))
    if commons_rows:
        lines += [
            "## Wikimedia Commons recordings",
            "",
            "Excerpts (trimmed, faded, mono, loudness-normalized) of the following files. Share-alike files",
            "stay under their original license.",
            "",
            "| Instrument | File | Author | License |",
            "| --- | --- | --- | --- |",
        ]
        for title, (inst, o) in sorted(commons_rows.items(), key=lambda kv: kv[1][0]):
            name = title.replace("File:", "").replace("|", "\\|")
            lines.append(f"| {inst} | [{name}]({o['url']}) | {o['artist'].replace('|', '/')} | {o['license']} |")
        lines.append("")
    (ROOT / "SOURCES.md").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()
