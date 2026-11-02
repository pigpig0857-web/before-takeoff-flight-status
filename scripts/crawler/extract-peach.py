"""Extract visually reviewed Peach PDF cells and expand published TPE schedules.

Requires pdfplumber. No network or production website import. Stops on changed
layout, malformed dates, incomplete route sections or duplicate daily flights.
"""
import argparse
import csv
import hashlib
import json
import re
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pdfplumber

DESTINATIONS = {
    "Osaka (Kansai)": ("KIX", "大阪", "關西國際機場"),
    "Tokyo (Narita)": ("NRT", "東京", "成田國際機場"),
    "Tokyo (Haneda)": ("HND", "東京", "東京國際機場（羽田）"),
    "Nagoya (Chubu)": ("NGO", "名古屋", "中部國際機場"),
    "Okinawa (Naha)": ("OKA", "沖繩", "那霸機場"),
}
TPE = timezone(timedelta(hours=8))
JAPAN = timezone(timedelta(hours=9))


def compact(text):
    return re.sub(r"\s+", " ", text or "").strip()


def merged_cuts(values):
    result = []
    for value in sorted(values):
        if not result or value - result[-1] > 0.5:
            result.append(value)
    return result


def cell_text(page, x0, x1, y0, y1):
    # Include whole characters by centre to avoid cutting text on a border.
    selected = page.filter(lambda obj: obj.get("object_type") == "char"
                           and x0 <= (obj["x0"] + obj["x1"]) / 2 < x1
                           and y0 <= (obj["top"] + obj["bottom"]) / 2 < y1)
    return compact(selected.extract_text(x_tolerance=1, y_tolerance=2))


def column_text(page, lines, x0, x1, ymid, start, end):
    cuts = merged_cuts([start, end] + [e["top"] for e in lines
                        if e["x0"] <= x0 + 1 and e["x1"] >= x1 - 1])
    above = max(y for y in cuts if y < ymid)
    below = min(y for y in cuts if y > ymid)
    return cell_text(page, x0, x1, above, below)


def extract_rules(pdf_path, source):
    rules, sections, raw_pages = [], [], []
    with pdfplumber.open(pdf_path) as doc:
        if not 1 <= len(doc.pages) <= 6:
            raise ValueError("Unexpected PDF page count")
        cover = compact(doc.pages[0].extract_text())
        publication = re.search(r"\(As of ([A-Za-z]+ \d{1,2}, \d{4})\)", cover)
        if not publication:
            raise ValueError("Missing PDF publication date")
        source["publishedAt"] = datetime.strptime(publication[1], "%B %d, %Y").date().isoformat()
        for boundary in (source["from"], source["to"]):
            d = date.fromisoformat(boundary)
            if f"{d.strftime('%B')} {d.day}, {d.year}" not in cover:
                raise ValueError("PDF validity does not match downloaded receipt")
        for page_index, page in enumerate(doc.pages):
            if page.width != 595 or page.height != 842:
                raise ValueError("Unreviewed PDF dimensions")
            raw_pages.append({"page": page_index + 1, "text": page.extract_text()})
            headers = sorted([r for r in page.rects
                              if r["x0"] < 40 and 550 < r["x1"] < 560
                              and 10 < r["height"] < 20
                              and isinstance(r.get("non_stroking_color"), (tuple, list))
                              and len(r["non_stroking_color"]) == 3
                              and 0.7 < r["non_stroking_color"][0] < 0.8],
                             key=lambda r: r["top"])
            for index, header in enumerate(headers):
                title = cell_text(page, 34, 556, header["top"], header["bottom"])
                if "Taipei (Taoyuan)" not in title:
                    continue
                matches = [name for name in DESTINATIONS if title == name + " - Taipei (Taoyuan)"]
                if len(matches) != 1:
                    raise ValueError(f"Unrecognised TPE route: {title}")
                destination = matches[0]
                next_top = headers[index + 1]["top"] if index + 1 < len(headers) else page.height
                region_lines = [e for e in page.lines
                                if abs(e["top"] - e["bottom"]) < 0.1
                                and 297 < e["x0"] < 412 and 550 < e["x1"] < 556
                                and header["bottom"] <= e["top"] < next_top]
                if not region_lines:
                    raise ValueError("Missing right-hand table lines")
                words = [w for w in page.extract_words() if 300 < w["x0"] < 333
                         and header["bottom"] < w["top"] < next_top and w["text"] == "Flight"]
                if len(words) != 1:
                    raise ValueError("Missing Flight column header")
                start = min(e["top"] for e in region_lines if e["top"] > words[0]["bottom"])
                end = max(e["top"] for e in region_lines)
                direction = cell_text(page, 298, 555.3, header["bottom"], words[0]["top"])
                if direction != "Taipei (Taoyuan) → " + destination:
                    raise ValueError(f"Wrong source direction: {direction}")
                lines = [e for e in region_lines if start - 0.5 <= e["top"] <= end + 0.5]
                cuts = merged_cuts([start, end] + [e["top"] for e in lines if e["x0"] <= 411])
                section = {"sourceId": source["id"], "page": page_index + 1, "title": title,
                           "direction": direction, "bbox": [298.2, start, 555.3, end], "rules": 0}
                section_rules = []
                for row_index, (top, bottom) in enumerate(zip(cuts, cuts[1:])):
                    if bottom - top < 2:
                        raise ValueError("Unreviewed row geometry")
                    ymid = (top + bottom) / 2
                    flight = column_text(page, lines, 298.2, 333.0, ymid, start, end)
                    departure = column_text(page, lines, 333.0, 370.5, ymid, start, end)
                    arrival = column_text(page, lines, 370.5, 410.0, ymid, start, end)
                    dates = cell_text(page, 410.0, 555.3, top, bottom)
                    arrival = arrival.replace("▶", "").strip()
                    if not any((flight, departure, arrival, dates)):
                        continue
                    # An empty grid row under a vertically merged flight cell is not a rule.
                    if not departure and not arrival and not dates:
                        continue
                    if not re.fullmatch(r"MM\d{3,4}", flight):
                        raise ValueError(f"Missing/invalid flight cell: {flight}")
                    for clock in (departure, arrival):
                        if not re.fullmatch(r"(?:[01]?\d|2[0-3]):[0-5]\d", clock):
                            raise ValueError(f"Missing/invalid time cell: {clock}")
                    rule = {"id": f"{source['id']}-p{page_index + 1}-r{len(rules) + 1}",
                                  "sourceId": source["id"], "page": page_index + 1,
                                  "departureAirport": "TPE", "arrivalAirport": DESTINATIONS[destination][0],
                                  "number": flight, "departureTime": departure.zfill(5),
                                  "arrivalTime": arrival.zfill(5), "operatingDatesText": dates,
                                  "rawOperatingDatesText": dates,
                                  "blankDatesPolicy": "daily_within_source_validity" if not dates else None,
                                  "rowBounds": [top, bottom]}
                    # The July PDF prints MM624's wrapped "12, 24" below its
                    # dotted border, above MM620's own "3/29". Preserve raw cells
                    # and repair only an unambiguous inherited-day continuation.
                    if section_rules and section_rules[-1]["operatingDatesText"].endswith(","):
                        next_month = re.search(r"\d{1,2}/", dates)
                        if not next_month or next_month.start() == 0:
                            raise ValueError("Unresolved operating-date overflow")
                        continuation = dates[:next_month.start()].strip()
                        if not re.fullmatch(r"\d{1,2}(?:-\d{1,2})?(?:,\s*\d{1,2}(?:-\d{1,2})?)*", continuation):
                            raise ValueError("Ambiguous operating-date overflow")
                        previous = section_rules[-1]
                        previous["operatingDatesText"] += " " + continuation
                        previous["extractionCorrection"] = {"reason": "wrapped_date_text_printed_below_cell_border",
                                                             "continuationFromRule": rule["id"], "text": continuation}
                        rule["operatingDatesText"] = dates[next_month.start():]
                        rule["extractionCorrection"] = {"reason": "previous_cell_continuation_removed",
                                                         "previousRule": previous["id"], "text": continuation}
                    rules.append(rule)
                    section_rules.append(rule)
                    section["rules"] += 1
                sections.append(section)
        if len(sections) != 5 or set(s["title"] for s in sections) != {n + " - Taipei (Taoyuan)" for n in DESTINATIONS}:
            raise ValueError("Incomplete TPE route sections")
    return rules, sections, raw_pages


def operating_dates(text, source_from, source_to):
    """Parse explicit month/day lists, inherited months, ranges and winter year rollover."""
    if not text:
        return {source_from + timedelta(days=i) for i in range((source_to - source_from).days + 1)}
    cleaned = re.sub(r"\s+", "", text)
    tokens = cleaned.split(",")
    month = None
    result = set()
    for token in tokens:
        match = re.fullmatch(r"(?:(\d{1,2})/)?(\d{1,2})(?:-(\d{1,2}))?", token)
        if not match:
            raise ValueError(f"Unsupported operating dates: {text}")
        if match[1]:
            month = int(match[1])
        if month is None:
            raise ValueError("Date list missing initial month")
        day_from = int(match[2])
        day_to = int(match[3] or match[2])
        if day_from > day_to:
            raise ValueError("Reversed date range")
        year = source_from.year if month >= source_from.month else source_to.year
        for day in range(day_from, day_to + 1):
            value = date(year, month, day)
            if not source_from <= value <= source_to:
                raise ValueError(f"Date outside PDF validity: {value}")
            if value in result:
                raise ValueError("Repeated date inside one rule")
            result.add(value)
    return result


def expand_rules(rules, sources, requested_from, requested_to):
    records, identities = [], set()
    airports = {v[0]: (name, v[1], v[2]) for name, v in DESTINATIONS.items()}
    for rule in rules:
        source = sources[rule["sourceId"]]
        days = operating_dates(rule["operatingDatesText"], date.fromisoformat(source["from"]), date.fromisoformat(source["to"]))
        rule["publishedOperatingDays"] = len(days)
        selected = sorted(d for d in days if requested_from <= d <= requested_to)
        rule["collectedOperatingDays"] = len(selected)
        for day in selected:
            number = "MM" + str(int(rule["number"][2:]))
            identity = (day.isoformat(), number, rule["arrivalAirport"])
            if identity in identities:
                raise ValueError(f"Conflicting daily flight rules: {identity}")
            identities.add(identity)
            departure = datetime.fromisoformat(f"{day}T{rule['departureTime']}").replace(tzinfo=TPE)
            arrival = datetime.fromisoformat(f"{day}T{rule['arrivalTime']}").replace(tzinfo=JAPAN)
            if arrival <= departure:
                arrival += timedelta(days=1)
            minutes = int((arrival - departure).total_seconds() / 60)
            if not 60 <= minutes <= 360:
                raise ValueError(f"Unexpected Japan direct flight duration: {minutes}")
            destination, city, airport_name = airports[rule["arrivalAirport"]]
            records.append({"number": number, "sourceNumber": rule["number"], "airlineCode": "MM",
                            "airline": "樂桃航空", "date": day.isoformat(), "departureAirport": "TPE",
                            "airport": rule["arrivalAirport"], "destination": city, "destinationEnglish": destination,
                            "airportName": airport_name, "countryCode": "JP",
                            "departure": departure.isoformat(timespec="seconds"),
                            "arrival": arrival.isoformat(timespec="seconds"), "arrivalTimeZone": "Asia/Tokyo",
                            "arrivalDayOffset": (arrival.date() - day).days, "minutes": minutes,
                            "terminal": None, "arrivalTerminal": None, "aircraft": None, "gate": None,
                            "counter": None, "kind": "collected_peach", "label": "樂桃官方預定班表",
                            "url": source["url"], "fetchedAt": source["fetchedAt"],
                            "sourcePublishedAt": source["publishedAt"],
                            "sourceSha256": source["sha256"], "page": rule["page"], "ruleId": rule["id"],
                            "operatingAirline": "樂桃航空", "operatingNumber": number,
                            "codeshare": False, "nonstop": True, "status": "scheduled",
                            "sourceStatus": "已保存的預定班表，非即時動態"})
    return sorted(records, key=lambda r: (r["date"], r["departure"], r["number"]))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source_directory", type=Path)
    parser.add_argument("--extract-only", action="store_true")
    parser.add_argument("--output-dir", type=Path, help="Isolated output under the source run; does not replace the shared cache")
    args = parser.parse_args()
    root = args.source_directory.resolve()
    receipt = json.loads((root / "receipt.json").read_text(encoding="utf8"))
    rules, sections, pages = [], [], {}
    for source in receipt["sources"]:
        pdf_path = root / source["file"]
        if hashlib.sha256(pdf_path.read_bytes()).hexdigest() != source["sha256"]:
            raise ValueError("Source PDF hash mismatch")
        extracted, discovered, texts = extract_rules(pdf_path, source)
        rules.extend(extracted)
        sections.extend(discovered)
        pages[source["id"]] = texts
    (root / "raw-rules.json").write_text(json.dumps({"rules": rules, "sections": sections}, ensure_ascii=False, indent=2), encoding="utf8")
    (root / "pdf-text.json").write_text(json.dumps(pages, ensure_ascii=False, indent=2), encoding="utf8")
    if args.extract_only:
        print(json.dumps({"sections": sections, "rules": rules}, ensure_ascii=False, indent=2))
        return
    start, end = date.fromisoformat(receipt["requestedFrom"]), date.fromisoformat(receipt["requestedTo"])
    sources = {s["id"]: s for s in receipt["sources"]}
    records = expand_rules(rules, sources, start, end)
    daily = Counter(r["date"] for r in records)
    dates = [(start + timedelta(days=i)).isoformat() for i in range((end - start).days + 1)]
    route_counts = Counter(r["airport"] for r in records)
    route_daily = {airport: dict(sorted(Counter(r["date"] for r in records if r["airport"] == airport).items())) for airport in route_counts}
    if sorted(daily) != dates or set(route_counts) != {v[0] for v in DESTINATIONS.values()}:
        raise ValueError("Requested date/route coverage incomplete")
    output = args.output_dir.resolve() if args.output_dir else Path("data/cache/peach-yearend").resolve()
    if args.output_dir and (output == root or not output.is_relative_to(root)):
        raise ValueError("Isolated output must stay below the source run")
    output.mkdir(parents=True, exist_ok=True)
    snapshot = {"version": 1, "collectedAt": datetime.now(timezone.utc).isoformat(),
                "requestedFrom": str(start), "requestedTo": str(end), "departureAirport": "TPE",
                "integratedIntoWebsite": False, "sources": receipt["sources"], "records": records}
    coverage = {"version": 1, "sourceDirectory": str(root), "requestedFrom": str(start), "requestedTo": str(end),
                "dates": dates, "dateCount": len(dates), "records": len(records), "rules": len(rules),
                "destinations": dict(sorted(route_counts.items())), "dailyCounts": dict(sorted(daily.items())),
                "routeDailyCounts": route_daily, "crossDayArrivals": sum(r["arrivalDayOffset"] for r in records),
                "duplicateDailyIdentities": 0, "missingRequestedDates": [], "sourceSections": sections,
                "scope": "All TPE outbound rules in the two downloaded official Peach international PDFs, expanded for the requested dates.",
                "allPublishedTpeRulesParsed": True, "allRequestedDatesExpanded": True,
                "allActualFlightsIndependentlyConfirmed": False, "longTermAutomationProven": False,
                "integratedIntoWebsite": False,
                "blankDatesPolicy": "Blank Operating Date cells mean daily within PDF validity; reviewed against layout, not independently confirmed for every date.",
                "missingFields": ["terminal", "arrivalTerminal", "aircraft", "gate", "counter", "realTimeStatus"],
                "sources": receipt["sources"]}
    for directory in (root, output):
        (directory / "flights.json").write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf8")
        (directory / "coverage.json").write_text(json.dumps(coverage, ensure_ascii=False, indent=2), encoding="utf8")
        (directory / "rules.json").write_text(json.dumps({"rules": rules, "sections": sections}, ensure_ascii=False, indent=2), encoding="utf8")
        with (directory / "flights.csv").open("w", encoding="utf-8-sig", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=list(records[0]))
            writer.writeheader()
            writer.writerows(records)
    print(json.dumps({"output": str(output), "records": len(records), "dates": len(dates),
                      "destinations": route_counts, "crossDayArrivals": coverage["crossDayArrivals"], "rules": len(rules)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
