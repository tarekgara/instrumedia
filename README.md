# Instrumedia

Identify musical instruments by ear. By Tarek Gara.

- **Library**: over a hundred instruments in ten families. Each has single notes across its range, playing techniques, a short phrase, the same phrase buried in a busy mix, and the phrase through a small speaker. Every clip is loudness-matched, so you compare the sound of the instrument, not its volume.
- **Not sure?**: a few questions you answer by ear, each with example sounds taken from instruments that still fit your earlier answers. Questions that can't help (like "does the note hold?" once you've said it's a drum) are skipped. A wrong answer lowers a candidate but never removes it.
- **Compare**: drop in any recording (audio or video), select the part that matters, and flip between it and each candidate with the number keys. Candidates follow the recording's detected pitch, and you end with a plain answer such as `Oboe (Woodwinds › Double reed). Fairly sure. Could also be: Clarinet.`
- **Often confused with**: every instrument lists what it's mistaken for and how to tell them apart.

Nothing you load is uploaded. Recordings are decoded in your browser.

## Use it

**Online:** open the GitHub Pages site. The download icon in the sidebar saves the whole library for offline use.

**Offline, no install:** download this repository as a ZIP, unzip it, and open `index.html`.

### Keyboard

| Key | Action |
| --- | --- |
| `/` or `Ctrl+K` | Search |
| `0` | Play your recording, from any page |
| `1`–`6` | Compare: play a candidate. Not sure?: pick an answer |
| `Space` | Stop |
| `L` | Loop on/off |

## How it's built

A static site with no front-end build step: `index.html`, `css/app.css` and plain scripts in `js/`. The library data is a generated script (`js/data.js`) rather than JSON, which is what lets the page run straight from disk.

Reference audio is produced by `tools/build.py` from openly licensed sources:

```
pip install numpy scipy pyyaml pillow pyloudnorm py7zr
python tools/fetch_freepats.py    # downloads the FreePats banks into .cache/
python tools/build.py             # fetches only the VCSL/VSCO/Commons files it needs, renders audio/ and js/data.js
```

It needs `ffmpeg` on PATH (or `FFMPEG=` set). The build caches per instrument: `--only oboe,flute` rebuilds a subset and `--force` rebuilds everything. `python tools/commons_search.py "sitar"` lists openly licensed Wikimedia Commons recordings when you're looking for a new source.

### Adding or changing an instrument

Everything lives in [`data/library.yaml`](data/library.yaml): family, perceptual traits (used by *Not sure?*), listening cues, the confusion map, and which recordings to use. Confusions are made two-way automatically. Instruments marked `status: wanted` appear in the confusion map without audio until a clean, openly licensed recording is found.

## Sources and licenses

Only openly licensed audio is used: Versilian VCSL and VSCO 2 CE (CC0), FreePats banks (mostly CC0; MuldjordKit is CC BY 4.0 and the steel-string guitar is GPL-3.0+ with the FreePats exception), individual recordings from Wikimedia Commons (CC0, public domain, CC BY or CC BY-SA, credited per clip), and sounds synthesized in `tools/synth.py`. Totals are in [SOURCES.md](SOURCES.md) and per-clip provenance in [`data/provenance.json`](data/provenance.json).

Code © Tarek Gara, MIT licensed (see `LICENSE`). Each recording keeps the license of its source.
