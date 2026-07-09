#!/usr/bin/env python3
"""
Bundle viewer.css / viewer.js / viewer.html into assets.json.

Run after editing any of those three source files. assets.json is what
trace_to_html.py reads at runtime to inject into the generated trace.html.

Usage:
    python3 build.py
"""
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent

def main() -> None:
    out = {
        "css": (HERE / "viewer.css").read_text(encoding="utf-8"),
        "js": (HERE / "viewer.js").read_text(encoding="utf-8"),
        "html": (HERE / "viewer.html").read_text(encoding="utf-8"),
        "dash_css": (HERE / "dashboard.css").read_text(encoding="utf-8"),
        "dash_js": (HERE / "dashboard.js").read_text(encoding="utf-8"),
        "dash_html": (HERE / "dashboard.html").read_text(encoding="utf-8"),
    }
    target = HERE / "assets.json"
    target.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"✓ Wrote {target} ({target.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
