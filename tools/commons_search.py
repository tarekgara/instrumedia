#!/usr/bin/env python3
"""Search Wikimedia Commons for openly licensed recordings of an instrument.

    python tools/commons_search.py "celesta" "sitar raga"

Prints candidates with duration, license and title so a human (or the build)
can pick one. Only licenses that allow redistribution are shown.
"""
import json
import sys
import urllib.parse
import urllib.request

API = "https://commons.wikimedia.org/w/api.php"
OK = ("cc0", "public domain", "pd", "cc by 4.0", "cc by 3.0", "cc by 2.5", "cc by 2.0", "cc by-sa 4.0", "cc by-sa 3.0", "cc by-sa 2.5", "cc by-sa 2.0", "cc-by", "cc-by-sa")


def get(params):
    params = {**params, "format": "json", "formatversion": "2"}
    req = urllib.request.Request(API + "?" + urllib.parse.urlencode(params), headers={"User-Agent": "instrumedia-build/1.0 (sample sourcing)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def search(term, limit=25):
    d = get({"action": "query", "generator": "search", "gsrnamespace": 6, "gsrlimit": limit,
             "gsrsearch": f"{term} filetype:audio", "prop": "imageinfo",
             "iiprop": "url|size|mime|extmetadata|metadata"})
    out = []
    for p in (d.get("query", {}).get("pages") or []):
        ii = (p.get("imageinfo") or [{}])[0]
        meta = ii.get("extmetadata", {})
        lic = meta.get("LicenseShortName", {}).get("value", "")
        length = None
        for m in ii.get("metadata") or []:
            if m.get("name") in ("length", "playtime_seconds"):
                try:
                    length = float(m["value"])
                except (TypeError, ValueError):
                    pass
        out.append({"title": p["title"], "license": lic, "length": length, "url": ii.get("url"),
                    "mime": ii.get("mime"), "artist": meta.get("Artist", {}).get("value", ""),
                    "desc": meta.get("ImageDescription", {}).get("value", "")})
    return [c for c in out
            if any(k in c["license"].lower() for k in OK)
            and "midi" not in (c["mime"] or "")
            and (c["length"] or 0) >= 3
            and not c["title"].startswith(("File:LL-", "File:En-", "File:Nl-", "File:De-", "File:Fr-"))]


if __name__ == "__main__":
    import re
    sys.stdout.reconfigure(encoding="utf-8")
    for term in sys.argv[1:]:
        print(f"=== {term}")
        for c in search(term):
            desc = re.sub(r"<[^>]+>", "", c["desc"]).replace("\n", " ")[:90]
            ln = f"{c['length']:.0f}s" if c["length"] else "?"
            print(f"  {ln:>5} | {c['license'][:14]:14} | {c['title'][5:80]} | {desc}")
