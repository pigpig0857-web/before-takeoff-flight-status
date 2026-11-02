import assert from 'node:assert/strict';
import {
  normalizeCollected,
  type CollectedSnapshot,
  type SavedFlight,
} from '../../src/server/providers/collected';
import { arrivalAirport } from '../../src/features/flights/destinations';
import { validDate } from '../../src/lib/time';

export type Airline = 'eva' | 'peach';
/** Only these date/airport cells were actually queried; other saved rows stay untouched. */
export interface ObservationScope {
  cells: { date: string; airport: string }[];
}
export const identity = (r: SavedFlight) =>
  `${r.date}|${r.number.replace(/^([A-Z0-9]{2})0+(?=\d)/, '$1')}|${r.airport}`;
const core = [
  'date',
  'number',
  'airline',
  'departure',
  'arrival',
  'arrivalTimeZone',
  'airport',
  'countryCode',
  'minutes',
  'operatingAirline',
  'operatingNumber',
  'codeshare',
  'continuationAirport',
] as const;
const stableValue = (r: SavedFlight, field: (typeof core)[number]) =>
  ['number', 'operatingNumber'].includes(field) && typeof r[field] === 'string'
    ? String(r[field]).replace(/^([A-Z0-9]{2})0+(?=\d)/, '$1')
    : (r[field] ?? null);
export function validateSnapshot(
  snapshot: CollectedSnapshot,
  airline: Airline,
) {
  assert.equal(snapshot.version, 1);
  assert.ok(
    Array.isArray(snapshot.records) && snapshot.records.length,
    'Empty candidate is not a valid update',
  );
  assert.ok(Array.isArray(snapshot.coverage) && snapshot.coverage.length);
  const kind = airline === 'eva' ? 'collected_eva' : 'collected_peach';
  const keys = new Set<string>();
  for (const r of snapshot.records) {
    assert.equal(r.kind, kind, 'Mixed airline candidate');
    normalizeCollected(r);
    assert.equal(
      arrivalAirport(r.airport!)?.countryCode,
      r.countryCode,
      'Country/airport mismatch',
    );
    assert.ok(r.operatingAirline && r.operatingNumber);
    assert.ok(!keys.has(identity(r)), 'Duplicate canonical flight identity');
    keys.add(identity(r));
  }
}
export function compareSchedules(
  before: CollectedSnapshot,
  incoming: CollectedSnapshot,
  airline: Airline,
  from: string,
  now = new Date().toISOString(),
  scope?: ObservationScope,
) {
  assert.ok(validDate(from) && from <= '2026-12-31', 'Invalid update range');
  validateSnapshot(before, airline);
  validateSnapshot(incoming, airline);
  const within = (r: SavedFlight) => r.date >= from && r.date <= '2026-12-31';
  let cells: Set<string> | undefined;
  if (scope) {
    assert.ok(
      Array.isArray(scope.cells) && scope.cells.length,
      'Empty observation scope',
    );
    cells = new Set();
    for (const c of scope.cells) {
      assert.ok(
        validDate(c.date) &&
          c.date >= from &&
          c.date <= '2026-12-31' &&
          arrivalAirport(c.airport),
        'Invalid observation cell',
      );
      const key = `${c.date}|${c.airport}`;
      assert.ok(!cells.has(key), 'Duplicate observation cell');
      cells.add(key);
    }
    assert.ok(
      incoming.records.every(
        (r) => within(r) && cells!.has(`${r.date}|${r.airport}`),
      ),
      'Candidate outside observed scope',
    );
  }
  const observed = (r: SavedFlight) =>
    within(r) && (!cells || cells.has(`${r.date}|${r.airport}`));
  const old = new Map(
    before.records.filter(observed).map((r) => [identity(r), r]),
  );
  const next = new Map(
    incoming.records.filter(within).map((r) => [identity(r), r]),
  );
  assert.ok(
    next.size,
    'Candidate does not contain flights in the requested range',
  );
  const records = before.records.filter((r) => !observed(r));
  const added: SavedFlight[] = [],
    changed: {
      identity: string;
      before: SavedFlight;
      after: SavedFlight;
      fields: string[];
    }[] = [],
    pending: { identity: string; reason: string; record: SavedFlight }[] = [];
  let unchanged = 0;
  for (const [id, r] of next) {
    assert.ok(
      Date.parse(r.fetchedAt) <= Date.parse(now) + 60000,
      'Future source timestamp',
    );
    const previous = old.get(id);
    if (!previous) {
      added.push(r);
      records.push(r);
      continue;
    }
    assert.ok(
      Date.parse(r.fetchedAt) >= Date.parse(previous.fetchedAt),
      'Candidate is older than saved evidence',
    );
    const sameTimes =
      Date.parse(previous.departure) === Date.parse(r.departure) &&
      Date.parse(previous.arrival) === Date.parse(r.arrival);
    const observed =
      sameTimes &&
      !Object.hasOwn(r, 'continuationAirport') &&
      previous.continuationAirport
        ? { ...r, continuationAirport: previous.continuationAirport }
        : r;
    const fields = core.filter(
      (field) => stableValue(previous, field) !== stableValue(observed, field),
    );
    if (fields.length) {
      changed.push({ identity: id, before: previous, after: observed, fields });
      records.push(observed);
    } else {
      unchanged++;
      // An unchanged basic schedule may retain its separately dated detailed evidence.
      const preserved =
        airline === 'eva' && !r.detail && previous.detail
          ? {
              ...observed,
              terminal: previous.terminal,
              arrivalTerminal: previous.arrivalTerminal,
              aircraft: previous.aircraft,
              detail: previous.detail,
            }
          : observed;
      records.push(preserved);
    }
  }
  for (const [id, r] of old)
    if (!next.has(id)) {
      records.push(r);
      pending.push({
        identity: id,
        reason: 'not_listed_in_candidate_not_a_cancellation',
        record: r,
      });
    }
  records.sort(
    (a, b) =>
      a.departure.localeCompare(b.departure) ||
      a.number.localeCompare(b.number),
  );
  const active = records.filter(within),
    dates = [...new Set(records.map((r) => r.date))].sort();
  const kind = airline === 'eva' ? 'collected_eva' : 'collected_peach';
  const base = incoming.coverage.find((c) => c.kind === kind);
  assert.ok(base);
  const staged: CollectedSnapshot = {
    version: 1,
    importedAt: now,
    records,
    coverage: [
      {
        ...base,
        dates,
        records: records.length,
        fetchedAt: active.map((r) => r.fetchedAt).sort()[0],
        description: `${airline === 'eva' ? '長榮航空' : '樂桃航空'}桃園直飛已保存班表：${from}～2026-12-31；${new Set(active.map((r) => r.airport)).size} 個目的地。${scope ? `本次只核對 ${scope.cells.length} 個日期／機場組合，其餘保留原資料。` : ''}${pending.length ? `${pending.length} 筆來源未列出，保留待確認。` : ''}非即時動態，未保證完整航班清單。`,
      },
    ],
  };
  validateSnapshot(staged, airline);
  return {
    staged,
    changes: { added, changed, pending },
    summary: {
      airline,
      from,
      through: '2026-12-31',
      before: old.size,
      incoming: next.size,
      added: added.length,
      changed: changed.length,
      unchanged,
      retainedPending: pending.length,
      deleted: 0,
      stagedTotal: records.length,
      ...(scope
        ? {
            observationCells: scope.cells.length,
            notRechecked: before.records.filter(
              (r) => within(r) && !observed(r),
            ).length,
          }
        : {}),
    },
  };
}
