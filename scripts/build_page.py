"""Assemble the single-file page: src/page.html with the core logic, the case
record and the sample run inlined. Output: dist/witness-workbench.html.

    python3 scripts/build_page.py
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent


def inline_json(path):
    data = json.loads((ROOT / path).read_text(encoding="utf-8"))
    # "</" inside a <script> block would end it early.
    return json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")


def main():
    page = (ROOT / "src/page.html").read_text(encoding="utf-8")
    out = (page.replace("__RECORD__", inline_json("data/record.json"))
               .replace("__SAMPLE__", inline_json("data/sample-holcomb.json"))
               .replace("__BRIEF__", json.dumps((ROOT / "data/sample-brief.txt").read_text(encoding="utf-8"), ensure_ascii=False).replace("</", "<\\/"))
               .replace("__CORE__", (ROOT / "src/core.js").read_text(encoding="utf-8")))
    dest = ROOT / "dist/witness-workbench.html"
    dest.parent.mkdir(exist_ok=True)
    dest.write_text(out, encoding="utf-8")
    print(f"wrote {dest.relative_to(ROOT)} ({len(out.encode()) // 1024} KB)")


if __name__ == "__main__":
    main()
