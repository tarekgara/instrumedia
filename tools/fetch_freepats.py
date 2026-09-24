#!/usr/bin/env python3
"""Download and unpack the FreePats sound banks the library uses into .cache/freepats/."""

import shutil
import subprocess
import tarfile
import urllib.request
from pathlib import Path

CACHE = Path(__file__).resolve().parent.parent / ".cache" / "freepats"

URLS = [
    "https://freepats.zenvoid.org/Guitar/SpanishClassicalGuitar/SpanishClassicalGuitar-SFZ+FLAC-20190618.7z",
    "https://freepats.zenvoid.org/Guitar/FSS-SteelStringGuitar/FSS-SteelStringGuitar-SFZ-20200521.tar.xz",
    "https://github.com/freepats/ukulele1/releases/download/2026-08-11/Ukulele-SFZ+FLAC-20260811.7z",
    "https://github.com/freepats/electric-guitar-FSBS-clean/releases/download/2026-08-07/EGuitarFSBS-clean-bridge-small-SFZ+FLAC-20260807.7z",
    "https://github.com/freepats/electric-guitar-FSBS-dist1/releases/download/2022-09-11/EGuitarFSBS-dist1-SFZ+FLAC-20220911.7z",
    "https://github.com/freepats/electric-bass-YR/releases/download/2019-09-30/FingerBassYR-SFZ+FLAC-20190930.7z",
    "https://github.com/freepats/button-accordion-HN/releases/download/2024-03-29/ButtonAccordionHN-SFZ+FLAC-20240329.7z",
    "https://freepats.zenvoid.org/Organ/DrawbarOrganEmulation/DrawbarOrganEmulation-SFZ-20190712.tar.xz",
    "https://github.com/freepats/muldjordkit/releases/download/2020-10-18/MuldjordKit-SFZ+FLAC-20201018.7z",
    "https://github.com/freepats/bagpipe/releases/download/2026-08-06/Bagpipe-small-SFZ+FLAC-20260806.7z",
    "https://github.com/freepats/hang-D-minor/releases/download/2022-03-30/Hang-D-minor-SFZ+FLAC-20220330.7z",
    "https://freepats.zenvoid.org/Ethnic/JawHarp/JawHarp-SFZ-20200606.tar.bz2",
    "https://github.com/freepats/old-piano-FB/releases/download/2020-04-01/PianoFB-small-SFZ+FLAC-20200401.7z",
    "https://github.com/freepats/synth-strings-1/releases/download/2020-05-28/SynthStrings1-SFZ+FLAC-20200528.7z",
    "https://github.com/freepats/synth-brass-1/releases/download/2021-04-26/SynthBrass1-SFZ+FLAC-20210426.7z",
    "https://github.com/freepats/world-percussion/releases/download/2020-09-05/WorldPercussion-SFZ+FLAC-20200905.7z",
    "https://freepats.zenvoid.org/ChromaticPercussion/Glass/Glass-SFZ+FLAC-20191227.7z",
]


def unpack(archive, dest):
    dest.mkdir(parents=True, exist_ok=True)
    if ".tar." in archive.name:
        with tarfile.open(archive) as t:
            t.extractall(dest, filter="data")
        return
    try:
        import py7zr
        with py7zr.SevenZipFile(archive) as z:
            z.extractall(dest)
    except Exception:
        # some banks use filters py7zr lacks; bsdtar (Windows tar, libarchive) handles most
        win_tar = Path(r"C:\Windows\System32\tar.exe")
        tar = str(win_tar) if win_tar.exists() else shutil.which("tar")
        subprocess.run([tar, "-xf", str(archive), "-C", str(dest)])


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    for url in URLS:
        name = url.rsplit("/", 1)[1]
        archive = CACHE / name
        bank = name.split("-SFZ")[0]
        if (CACHE / bank).is_dir():
            continue
        if not archive.exists():
            print("downloading", name)
            urllib.request.urlretrieve(url, archive)
        print("unpacking", name)
        unpack(archive, CACHE / bank)


if __name__ == "__main__":
    main()
