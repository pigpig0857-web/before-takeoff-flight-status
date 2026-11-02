"""Collect reviewed Tokyo -> TPE PDF cells into isolated return candidates.

No network and no website import. Reuses the established date/cell parser.
"""
import argparse
import hashlib
import importlib.util
import json
import re
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pdfplumber

spec = importlib.util.spec_from_file_location("peach", Path(__file__).with_name("extract-peach.py"))
peach = importlib.util.module_from_spec(spec)
spec.loader.exec_module(peach)


def extract(root, all_routes=False):
    receipt = json.loads((root / "receipt.json").read_text(encoding="utf8"))
    if receipt["status"] != "downloaded" or len(receipt["sources"]) != 2:
        raise ValueError("Incomplete download")
    start, end = map(date.fromisoformat, (receipt["requestedFrom"], receipt["requestedTo"]))
    if end > date(2026, 12, 31):
        raise ValueError("Unapproved date range")
    rules, records, identities = [], [], set()
    for source in receipt["sources"]:
        pdf = root / source["file"]
        if hashlib.sha256(pdf.read_bytes()).hexdigest() != source["sha256"]:
            raise ValueError("Source hash mismatch")
        found = set()
        with pdfplumber.open(pdf) as doc:
            cover = peach.compact(doc.pages[0].extract_text())
            published = re.search(r"\(As of ([A-Za-z]+ \d{1,2}, \d{4})\)", cover)
            if not published:
                raise ValueError("Missing publication")
            for boundary in (source["from"], source["to"]):
                d = date.fromisoformat(boundary)
                if f"{d.strftime('%B')} {d.day}, {d.year}" not in cover:
                    raise ValueError("Validity mismatch")
            for page_index, page in enumerate(doc.pages):
                headers = sorted([r for r in page.rects if r["x0"] < 40 and 550 < r["x1"] < 560
                                  and 10 < r["height"] < 20
                                  and isinstance(r.get("non_stroking_color"), (tuple, list))
                                  and len(r["non_stroking_color"]) == 3
                                  and .7 < r["non_stroking_color"][0] < .8], key=lambda r: r["top"])
                for index, header in enumerate(headers):
                    title = peach.cell_text(page, 34, 556, header["top"], header["bottom"])
                    routes = {n + " - Taipei (Taoyuan)": (code, "TPE", n, "Taipei (Taoyuan)")
                              for n, code in (("Tokyo (Narita)", "NRT"), ("Tokyo (Haneda)", "HND"))}
                    if all_routes:
                        routes.update({n + " - Taipei (Taoyuan)": (code, "TPE", n, "Taipei (Taoyuan)")
                                       for n, code in (("Osaka (Kansai)", "KIX"), ("Nagoya (Chubu)", "NGO"), ("Okinawa (Naha)", "OKA"))})
                        routes["Osaka (Kansai) - Kaohsiung"] = ("KIX", "KHH", "Osaka (Kansai)", "Kaohsiung")
                    if title not in routes:
                        continue
                    origin, target, origin_name, target_name = routes[title]
                    route = (origin, target)
                    if route in found:
                        raise ValueError("Repeated route section")
                    found.add(route)
                    bottom = headers[index + 1]["top"] if index + 1 < len(headers) else page.height
                    lines = [e for e in page.lines if abs(e["top"] - e["bottom"]) < .1
                             and 33 < e["x0"] < 148 and 286 < e["x1"] < 292
                             and header["bottom"] <= e["top"] < bottom]
                    words = [w for w in page.extract_words() if 35 < w["x0"] < 69
                             and header["bottom"] < w["top"] < bottom and w["text"] == "Flight"]
                    if len(words) != 1 or not lines:
                        raise ValueError("Unreviewed table layout")
                    direction = peach.cell_text(page, 34, 291.3, header["bottom"], words[0]["top"])
                    if direction != origin_name + " → " + target_name:
                        raise ValueError("Wrong direction")
                    top = min(e["top"] for e in lines if e["top"] > words[0]["bottom"])
                    last = max(e["top"] for e in lines)
                    lines = [e for e in lines if top - .5 <= e["top"] <= last + .5]
                    cuts = peach.merged_cuts([top, last] + [e["top"] for e in lines if e["x0"] <= 147])
                    for row_top, row_bottom in zip(cuts, cuts[1:]):
                        mid = (row_top + row_bottom) / 2
                        flight = peach.column_text(page, lines, 34.2, 69, mid, top, last)
                        departure = peach.column_text(page, lines, 69, 106.5, mid, top, last)
                        arrival = peach.column_text(page, lines, 106.5, 146, mid, top, last).replace("▶", "").strip()
                        dates = peach.cell_text(page, 146, 291.3, row_top, row_bottom)
                        if not departure and not arrival and not dates:
                            continue
                        if not re.fullmatch(r"MM\d{3,4}", flight):
                            raise ValueError(f"Invalid flight: {flight}")
                        if any(not re.fullmatch(r"(?:[01]?\d|2[0-3]):[0-5]\d", t) for t in (departure, arrival)):
                            raise ValueError(f"Invalid clocks: {departure}, {arrival}")
                        rule = dict(id=f"{source['id']}-return-{len(rules)+1}", sourceId=source["id"],
                                    page=page_index+1, departureAirport=origin, arrivalAirport=target,
                                    number=flight, departureTime=departure.zfill(5), arrivalTime=arrival.zfill(5),
                                    operatingDatesText=dates, rowBounds=[row_top, row_bottom],
                                    blankDatesPolicy="daily_within_source_validity" if not dates else None)
                        rules.append(rule)
                        days = peach.operating_dates(dates, date.fromisoformat(source["from"]), date.fromisoformat(source["to"]))
                        for day in sorted(d for d in days if start <= d <= end):
                            number = "MM" + str(int(flight[2:]))
                            key = (str(day), origin, target, number)
                            if key in identities:
                                raise ValueError(f"Duplicate: {key}")
                            identities.add(key)
                            dep = datetime.fromisoformat(f"{day}T{departure.zfill(5)}").replace(tzinfo=peach.JAPAN)
                            arr = datetime.fromisoformat(f"{day}T{arrival.zfill(5)}").replace(tzinfo=peach.TPE)
                            if arr <= dep:
                                arr += timedelta(days=1)
                            minutes = int((arr - dep).total_seconds() / 60)
                            if not 60 <= minutes <= 360:
                                raise ValueError("Unexpected duration")
                            records.append(dict(date=str(day), number=number, airlineCode="MM", airline="樂桃航空",
                                                departureAirport=origin, arrivalAirport=target,
                                                departure=dep.isoformat(), arrival=arr.isoformat(),
                                                departureTimeZone="Asia/Tokyo", arrivalTimeZone="Asia/Taipei",
                                                arrivalDayOffset=(arr.date()-day).days, minutes=minutes,
                                                url=source["url"], fetchedAt=source["fetchedAt"],
                                                sourceSha256=source["sha256"], page=page_index+1, ruleId=rule["id"],
                                                sourcePublishedAt=datetime.strptime(published[1], "%B %d, %Y").date().isoformat(),
                                                status="published_schedule", nonstop=True,
                                                terminal=None, arrivalTerminal=None, aircraft=None))
        required_routes = {("NRT", "TPE"), ("HND", "TPE")}
        if all_routes:
            required_routes.update({("KIX", "TPE"), ("NGO", "TPE"), ("OKA", "TPE"), ("KIX", "KHH")})
        if found != required_routes:
            raise ValueError("Missing return section")
    records.sort(key=lambda r: (r["date"], r["departure"], r["number"]))
    expected_dates = {str(start + timedelta(days=i)) for i in range((end-start).days+1)}
    for origin, target in required_routes:
        if {r["date"] for r in records if (r["departureAirport"], r["arrivalAirport"]) == (origin, target)} != expected_dates:
            raise ValueError(f"Missing requested route dates: {origin}")
    output = root / ("return-candidates-all" if all_routes else "return-candidates-v2")
    output.mkdir(exist_ok=False)
    result = dict(version=1, requestedFrom=str(start), requestedTo=str(end),
                  dateBasis="departure local date in Japan", integratedIntoWebsite=False,
                  scope="Peach Japan to TPE/KHH published routes" if all_routes else "Peach Tokyo NRT/HND to TPE only", records=records, sources=receipt["sources"])
    for name, value in (("flights.json", result), ("rules.json", rules)):
        (output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf8")
    summary = dict(records=len(records), routes=dict(Counter(r["departureAirport"] + "-" + r["arrivalAirport"] for r in records)),
                   dates=len(set(r["date"] for r in records)), duplicates=0,
                   crossDayArrivals=sum(r["arrivalDayOffset"] for r in records),
                   rules=len(rules), integratedIntoWebsite=False,
                   flightsSha256=hashlib.sha256((output / "flights.json").read_bytes()).hexdigest(),
                   limitations=["Not booking availability or live flight status", "Only downloaded published PDF coverage",
                                "Blank operating dates interpreted as daily within PDF validity", "Other airlines/routes not collected"])
    (output / "audit.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source_directory", type=Path)
    parser.add_argument("--all-routes", action="store_true")
    args = parser.parse_args()
    extract(args.source_directory.resolve(), args.all_routes)
