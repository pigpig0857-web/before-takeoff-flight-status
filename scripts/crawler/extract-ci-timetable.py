"""Read-only extraction helper. PDF layout is checked before schedule parsing."""
import json
import sys
import pdfplumber

with pdfplumber.open(sys.argv[1]) as document:
    if not 2 <= len(document.pages) <= 100:
        raise ValueError("Unexpected timetable page count")
    blocks = []
    for index, page in enumerate(document.pages):
        # This booklet has outbound flights on the left and inbound on the right.
        text = page.crop((0, 0, page.width / 2, page.height)).extract_text() or ""
        if "TAIPEI TAOYUAN TOKYO NARITA" in text:
            blocks.append({"page": index + 1, "text": text})
    print(json.dumps({
        "coverText": document.pages[0].extract_text() or "",
        "pages": len(document.pages),
        "blocks": blocks,
    }, ensure_ascii=True))
