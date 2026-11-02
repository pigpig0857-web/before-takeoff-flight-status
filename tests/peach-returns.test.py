"""Independent, visually reviewed Tokyo return timetable regression audit."""
import hashlib
import json
from datetime import date, datetime, timedelta
from pathlib import Path

root = Path("data/source-samples/crawler/peach-return-20261019-network")
output = root / "return-candidates-v2"
data = json.loads((output / "flights.json").read_text(encoding="utf8"))
rows = data["records"]
expected = set()
start, end = date(2026, 10, 19), date(2026, 12, 31)
for offset in range((end-start).days+1):
    day = start + timedelta(days=offset)
    if day < date(2026, 10, 25):
        flights = [("HND", "MM859", "05:55", "08:35"), ("NRT", "MM625", "16:50", "19:40"),
                   ("NRT", "MM627", "22:10", "01:00")]
        if day == date(2026, 10, 23):
            flights.append(("NRT", "MM631", "21:50", "00:40"))
    else:
        december = day.month == 12
        tuesday = day.weekday() == 1
        flights = [("HND", "MM859", "05:45", "08:55"),
                   ("NRT", "MM621", "12:40" if december and tuesday else "12:45" if tuesday else "12:50" if december else "12:55", "16:05" if tuesday else "16:15"),
                   ("NRT", "MM623", "16:35" if december else "16:40", "20:00"),
                   ("NRT", "MM627", "22:05", "01:25")]
        if day in (date(2026, 10, 25), date(2026, 10, 26)):
            flights.append(("NRT", "MM625", "21:50", "01:10"))
    expected.update((str(day), origin, number, dep, arr) for origin, number, dep, arr in flights)
actual = {(r["date"], r["departureAirport"], r["number"], r["departure"][11:16], r["arrival"][11:16]) for r in rows}
assert len(actual) == len(rows) == 293
assert actual == expected, {"missing": sorted(expected-actual), "unexpected": sorted(actual-expected)}
required = ("date", "number", "departureAirport", "arrivalAirport", "departure", "arrival", "departureTimeZone", "arrivalTimeZone", "url", "sourceSha256", "fetchedAt", "page", "ruleId")
sources = {s["sha256"]: s for s in data["sources"]}
for row in rows:
    assert all(row.get(k) for k in required)
    dep, arr = map(datetime.fromisoformat, (row["departure"], row["arrival"]))
    assert dep.utcoffset() == timedelta(hours=9) and arr.utcoffset() == timedelta(hours=8)
    assert int((arr-dep).total_seconds()/60) == row["minutes"]
    assert row["arrivalAirport"] == "TPE"
    assert (arr.date()-dep.date()).days == row["arrivalDayOffset"]
    assert row["url"] == sources[row["sourceSha256"]]["url"]
for source in data["sources"]:
    assert hashlib.sha256((root/source["file"]).read_bytes()).hexdigest() == source["sha256"]
report = dict(status="passed", records=293, independentlyMatchedDailySchedules=293,
              checkedDates=74, duplicateRecords=0, missingRequiredFields=0,
              allSourceHashesMatch=True, allTimeZoneDurationsMatch=True,
              basis="Independent date/weekday expectations transcribed from visually reviewed summer p3 and winter p2",
              notIndependentlyConfirmedWithBookingSystem=True)
(output / "independent-audit.json").write_text(json.dumps(report, indent=2), encoding="utf8")
print(json.dumps(report, indent=2))
