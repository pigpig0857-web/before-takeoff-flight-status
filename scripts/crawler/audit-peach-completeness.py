"""Recheck fresh official PDFs against collection and deployed snapshots.

Read-only for existing data; write audit evidence only into the new source run.
"""
import argparse
import hashlib
import importlib.util
import json
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("peach_extract", ROOT / "scripts/crawler/extract-peach.py")
peach = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(peach)


def read_json(path):
    return json.loads(path.read_text(encoding="utf8"))


def identity(record):
    return record["date"], "MM" + str(int(record["number"][2:])), record["airport"]


def fields(records):
    return {"records": len(records), "dates": len({r["date"] for r in records}),
            "airports": len({r["airport"] for r in records}),
            **{key: sum(r.get(key) is not None for r in records) for key in
               ("arrival", "detail", "terminal", "arrivalTerminal", "aircraft")}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("fresh_source_directory", type=Path)
    args = parser.parse_args()
    directory = args.fresh_source_directory.resolve()
    if directory.parent != (ROOT / "data/source-samples/crawler").resolve():
        raise ValueError("Audit evidence must stay in the project source run")
    receipt = read_json(directory / "receipt.json")
    archived = read_json(ROOT / "data/source-samples/crawler/peach-1791771540676/receipt.json")
    saved = read_json(ROOT / "data/cache/peach-yearend/flights.json")
    website = read_json(ROOT / "src/server/data/peach-flights.json")
    eva = read_json(ROOT / "src/server/data/eva-flights.json")
    rules, sections, hashes = [], [], []
    for source in receipt["sources"]:
        body = (directory / source["file"]).read_bytes()
        actual_sha = hashlib.sha256(body).hexdigest()
        if actual_sha != source["sha256"]:
            raise ValueError("Downloaded source hash mismatch")
        earlier = next(s for s in archived["sources"] if s["id"] == source["id"])
        hashes.append({"id": source["id"], "sha256": actual_sha,
                       "sameAsCollectionSource": actual_sha == earlier["sha256"],
                       "repeatDownloadMatches": source["repeatHashMatches"]})
        current, discovered, _ = peach.extract_rules(directory / source["file"], source)
        rules.extend(current)
        sections.extend(discovered)
    from_date, to_date = date.fromisoformat(receipt["requestedFrom"]), date.fromisoformat(receipt["requestedTo"])
    records = peach.expand_rules(rules, {s["id"]: s for s in receipt["sources"]}, from_date, to_date)
    expected = {identity(r): r for r in records}
    differences = []
    comparison_keys = ["departure", "arrival", "minutes", "arrivalTimeZone", "airline", "operatingAirline",
                       "countryCode", "terminal", "arrivalTerminal", "aircraft", "codeshare", "kind", "url", "sourcePublishedAt"]
    for label, dataset in (("collected", saved), ("website", website)):
        observed = {identity(r): r for r in dataset["records"]}
        if len(observed) != len(dataset["records"]):
            differences.append({"dataset": label, "problem": "duplicate_identity"})
        for key in expected.keys() - observed.keys():
            differences.append({"dataset": label, "problem": "missing", "identity": key})
        for key in observed.keys() - expected.keys():
            differences.append({"dataset": label, "problem": "unexpected", "identity": key})
        for key in expected.keys() & observed.keys():
            for field in comparison_keys:
                if expected[key].get(field) != observed[key].get(field):
                    differences.append({"dataset": label, "identity": key, "field": field,
                                        "freshPdf": expected[key].get(field), "saved": observed[key].get(field)})
    all_dates = [(from_date + timedelta(days=i)).isoformat() for i in range((to_date - from_date).days + 1)]
    daily = Counter(r["date"] for r in records)
    missing_dates = sorted(set(all_dates) - set(daily))
    selected_eva = [r for r in eva["records"] if str(from_date) <= r["date"] <= str(to_date)]
    report = {"checkedAt": datetime.now(timezone.utc).isoformat(), "status": "passed" if not differences and not missing_dates else "failed",
              "from": str(from_date), "through": str(to_date), "sourceDirectory": str(directory),
              "currentSourceHashes": hashes, "freshPdfRules": len(rules), "freshPdfSections": len(sections),
              "peachRecords": len(records), "days": len(daily), "airports": dict(sorted(Counter(r["airport"] for r in records).items())),
              "missingDates": missing_dates, "differences": differences, "dailyCounts": dict(sorted(daily.items())),
              "fieldCompleteness": {"peach": fields(website["records"]), "evaAllSaved": fields(eva["records"]), "evaSameDateRange": fields(selected_eva)},
              "scope": "All TPE outbound direct flight rules in the current two official PDFs, not a booking inventory audit.",
              "sameDetailCompletenessAsEva": False, "allActualFlightsIndependentlyConfirmed": False,
              "blockingGapsForEvaParity": ["per_departure_date_official_detail_crosscheck", "departure_terminal", "aircraft", "arrival_terminal_where_published"],
              "sourceEvidencePolicy": "No aircraft or terminal is filled from fleet descriptions or undated airport guides.",
              "candidateAndWebsiteSnapshotsModified": False,
              "sources": receipt["sources"]}
    (directory / "completeness-audit.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf8")
    print(json.dumps({key: report[key] for key in ("status", "peachRecords", "days", "airports", "differences", "fieldCompleteness", "sameDetailCompletenessAsEva")}, ensure_ascii=False, indent=2))
    if report["status"] != "passed":
        raise ValueError("Fresh official source differs from saved dataset")


if __name__ == "__main__":
    main()
