"""Offline regression audit against manually reviewed October 12 source PDFs."""
import importlib.util
import json
import unittest
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data/source-samples/crawler/peach-1791771540676"
SPEC = importlib.util.spec_from_file_location("peach", ROOT / "scripts/crawler/extract-peach.py")
peach = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(peach)

# Transcribed from rendered right-hand TPE tables. This audit independently
# compares every collected day, including seasonal times and additional flights.
SUMMER = [
    ("MM24", "KIX", "09:30", "13:20"), ("MM26", "KIX", "13:40", "17:25"),
    ("MM28", "KIX", "18:15", "22:00"), ("MM620", "NRT", "02:00", "06:30"),
    ("MM626", "NRT", "10:50", "15:20"), ("MM860", "HND", "20:25", "00:45"),
    ("MM722", "NGO", "02:10", "06:05"), ("MM922", "OKA", "09:35", "12:20"),
    ("MM930", "OKA", "18:05", "20:50"),
]
WINTER = [
    ("MM24", "KIX", "09:40", "13:10"), ("MM26", "KIX", "13:40", "17:10"),
    ("MM28", "KIX", "18:50", "22:20"), ("MM626", "NRT", "10:40", "14:55"),
    ("MM860", "HND", "20:55", "00:50"), ("MM922", "OKA", "09:45", "12:25"),
    ("MM926", "OKA", "15:20", "17:50"), ("MM930", "OKA", "18:20", "20:50"),
]


def manually_reviewed(day):
    if day <= date(2026, 10, 24):
        rows = list(SUMMER)
        if day.day in (12, 13, 14, 19, 20, 21):
            rows.append(("MM6924", "OKA", "15:00", "17:45"))
        elif day.day in (17, 24):
            rows.append(("MM6924", "OKA", "14:55", "17:40"))
        else:
            rows.append(("MM924", "OKA", "14:50", "17:35"))
        if day.day in (12, 24):
            rows.extend([("MM30", "KIX", "01:45", "05:30"), ("MM624", "NRT", "02:20", "06:50")])
    else:
        rows = list(WINTER)
        rows.extend([("MM620", "NRT", "02:00" if day == date(2026, 10, 25) else "02:25", "06:30"),
                     ("MM724", "NGO", "02:10" if day == date(2026, 10, 25) else "02:55",
                      "06:05" if day == date(2026, 10, 25) else "06:25"),
                     ("MM628", "NRT", "17:10" if day.weekday() == 1 else "17:15",
                      "21:25" if day.weekday() == 1 else "21:30")])
        if day in (date(2026, 10, 26), date(2026, 10, 27)):
            rows.append(("MM622", "NRT", "02:45", "06:50"))
        if day == date(2026, 10, 27):
            rows.append(("MM30", "KIX", "02:00", "05:30"))
    return sorted(rows)


class PeachScheduleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.receipt = json.loads((SOURCE / "receipt.json").read_text(encoding="utf8"))
        cls.rules, cls.sections = [], []
        for source in cls.receipt["sources"]:
            rules, sections, _ = peach.extract_rules(SOURCE / source["file"], source)
            cls.rules.extend(rules)
            cls.sections.extend(sections)
        cls.records = peach.expand_rules(cls.rules, {s["id"]: s for s in cls.receipt["sources"]},
                                        date(2026, 10, 12), date(2026, 12, 31))

    def test_all_dates_against_visually_reviewed_timetable(self):
        for i in range(81):
            day = date(2026, 10, 12) + timedelta(days=i)
            actual = sorted((r["number"], r["airport"], r["departure"][11:16], r["arrival"][11:16])
                            for r in self.records if r["date"] == str(day))
            self.assertEqual(actual, manually_reviewed(day), str(day))

    def test_whole_requested_range_and_route_totals(self):
        self.assertEqual(len(self.records), 885)
        self.assertEqual(len({r["date"] for r in self.records}), 81)
        self.assertEqual(Counter(r["airport"] for r in self.records),
                         {"KIX": 246, "NRT": 234, "HND": 81, "NGO": 81, "OKA": 243})
        self.assertEqual(len(self.rules), 35)
        self.assertEqual(len(self.sections), 10)

    def test_pdf_overflow_repaired_without_losing_extra_flights(self):
        extra = next(r for r in self.rules if r["sourceId"] == "summer" and r["number"] == "MM624")
        self.assertTrue(extra["rawOperatingDatesText"].endswith(","))
        self.assertTrue(extra["operatingDatesText"].endswith("10/9, 12, 24"))
        self.assertEqual(extra["collectedOperatingDays"], 2)
        self.assertEqual(extra["extractionCorrection"]["text"], "12, 24")

    def test_cross_day_year_end_and_actual_elapsed_minutes(self):
        flights = [r for r in self.records if r["airport"] == "HND"]
        self.assertEqual(len(flights), 81)
        self.assertTrue(all(r["arrivalDayOffset"] == 1 for r in flights))
        last = flights[-1]
        self.assertEqual(last["departure"], "2026-12-31T20:55:00+08:00")
        self.assertEqual(last["arrival"], "2027-01-01T00:50:00+09:00")
        self.assertEqual(last["minutes"], 175)
        for flight in self.records:
            self.assertEqual((datetime.fromisoformat(flight["arrival"]) - datetime.fromisoformat(flight["departure"])).total_seconds() / 60,
                             flight["minutes"])

    def test_no_wrong_direction_no_invented_detail_fields(self):
        self.assertTrue(all(r["departureAirport"] == "TPE" and r["airlineCode"] == "MM" and r["nonstop"]
                            and not r["codeshare"] for r in self.records))
        self.assertTrue(all(r[key] is None for r in self.records for key in
                            ("terminal", "arrivalTerminal", "aircraft", "gate", "counter")))

    def test_inherited_months_and_winter_year(self):
        self.assertEqual(peach.operating_dates("10/27, 11/3, 10, 12/29, 1/5, 12", date(2026, 10, 25), date(2027, 3, 27)),
                         {date(2026, 10, 27), date(2026, 11, 3), date(2026, 11, 10),
                          date(2026, 12, 29), date(2027, 1, 5), date(2027, 1, 12)})

    def test_invalid_or_ambiguous_dates_stop_collection(self):
        for text in ("11/31", "11/5-3", "15", "11/3 Tuesday", "10/24", "12/31, 31"):
            with self.subTest(text=text), self.assertRaises(ValueError):
                peach.operating_dates(text, date(2026, 10, 25), date(2027, 3, 27))

    def test_duplicate_daily_flight_rules_stop_collection(self):
        with self.assertRaisesRegex(ValueError, "Conflicting daily flight"):
            peach.expand_rules(self.rules + [self.rules[5]], {s["id"]: s for s in self.receipt["sources"]},
                               date(2026, 10, 12), date(2026, 12, 31))

    def test_saved_snapshot_equals_pdf_replay(self):
        saved = json.loads((SOURCE / "flights.json").read_text(encoding="utf8"))
        self.assertEqual(saved["records"], self.records)
        self.assertFalse(saved["integratedIntoWebsite"])


if __name__ == "__main__":
    unittest.main()
