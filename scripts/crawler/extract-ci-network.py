"""Extract public booklet columns independently; no network or schedule inference."""
import json
import sys
import pdfplumber

with pdfplumber.open(sys.argv[1]) as document:
    if not 2 <= len(document.pages) <= 100:
        raise ValueError('Unexpected timetable page count')
    print(json.dumps({
        'coverText': document.pages[0].extract_text() or '',
        'pages': len(document.pages),
        'columns': [
            {'page': index + 1,
             'text': page.crop((0, 0, page.width / 2, page.height)).extract_text() or ''}
            for index, page in enumerate(document.pages)
        ],
    }, ensure_ascii=True))
