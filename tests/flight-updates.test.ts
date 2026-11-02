import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { compareSchedules } from '../scripts/flight-updates/compare';
import {
  prepareUpdate,
  applyUpdate,
  inspectUpdate,
} from '../scripts/flight-updates/store';
import type {
  CollectedSnapshot,
  SavedFlight,
} from '../src/server/providers/collected';
import { normalizeCollected } from '../src/server/providers/collected';
import { filterFlights } from '../src/features/flights/filter';
import peach from '../src/server/data/peach-flights.json';
import { createHash } from 'node:crypto';
import { refreshSchedules } from '../scripts/flight-updates/refresh';
const r: SavedFlight = {
  number: 'BR184',
  airline: '長榮航空',
  date: '2026-12-31',
  departure: '2026-12-31T07:55:00+08:00',
  arrival: '2026-12-31T12:00:00+09:00',
  arrivalTimeZone: 'Asia/Tokyo',
  airport: 'NRT',
  candidateAirport: null,
  destination: '東京',
  destinationEnglish: 'Tokyo Narita',
  countryCode: 'JP',
  terminal: null,
  arrivalTerminal: null,
  aircraft: null,
  minutes: 185,
  kind: 'collected_eva',
  label: '長榮官方班表',
  url: 'https://booking.evaair.com/flyeva/eva/b2c/flight-schedules.aspx?lang=en-hk',
  fetchedAt: '2026-10-08T03:00:00Z',
  operatingAirline: '長榮航空',
  operatingNumber: 'BR184',
  codeshare: false,
  page: null,
};
function snapshot(records: SavedFlight[]): CollectedSnapshot {
  return {
    version: 1,
    importedAt: '2026-10-08T04:00:00Z',
    records,
    coverage: [
      {
        kind: records[0]?.kind || 'collected_eva',
        label: '官方班表',
        url: records[0]?.url || r.url,
        fetchedAt: r.fetchedAt,
        dates: [...new Set(records.map((r) => r.date))],
        records: records.length,
        description: 'Test',
      },
    ],
  };
}
const compare = (before: CollectedSnapshot, incoming: CollectedSnapshot) =>
  compareSchedules(
    before,
    incoming,
    'eva',
    '2026-10-12',
    '2026-10-12T08:00:00Z',
  );
test('A source omission retains the saved flight and marks it pending without deleting history', () => {
  const omitted = { ...r, number: 'BR198', operatingNumber: 'BR198' };
  const historical = {
    ...r,
    date: '2026-10-08',
    departure: r.departure.replace('12-31', '10-08'),
    arrival: r.arrival.replace('12-31', '10-08'),
  };
  const result = compare(snapshot([r, omitted, historical]), snapshot([r]));
  assert.equal(result.summary.retainedPending, 1);
  assert.equal(result.summary.deleted, 0);
  assert.equal(result.staged.records.length, 3);
  assert.equal(result.changes.pending[0].record.number, 'BR198');
  assert.ok(result.staged.records.some((x) => x.date === '2026-10-08'));
});
test('Added flights and changed instants are separated, while canonical number formatting is unchanged', () => {
  const changed = {
    ...r,
    departure: '2026-12-31T08:05:00+08:00',
    arrival: '2026-12-31T12:10:00+09:00',
  };
  const extra = { ...r, number: 'BR198', operatingNumber: 'BR198' };
  const result = compare(snapshot([r]), snapshot([changed, extra]));
  assert.equal(result.summary.added, 1);
  assert.equal(result.summary.changed, 1);
  assert.deepEqual(result.changes.changed[0].fields, ['departure', 'arrival']);
  assert.equal(
    compare(
      snapshot([r]),
      snapshot([{ ...r, number: 'BR0184', operatingNumber: 'BR0184' }]),
    ).summary.changed,
    0,
  );
});
test('Invalid, duplicate, wrong-country, mixed-airline and stale candidates fail before staging', () => {
  assert.throws(() => compare(snapshot([r]), snapshot([])), /Empty candidate/);
  assert.throws(
    () => compare(snapshot([r]), snapshot([r, { ...r, number: 'BR0184' }])),
    /Duplicate/,
  );
  assert.throws(
    () => compare(snapshot([r]), snapshot([{ ...r, countryCode: 'KR' }])),
    /Country/,
  );
  assert.throws(
    () => compare(snapshot([r]), snapshot([{ ...r, kind: 'collected_peach' }])),
    /Mixed/,
  );
  assert.throws(
    () =>
      compare(
        snapshot([r]),
        snapshot([{ ...r, fetchedAt: '2026-10-07T00:00:00Z' }]),
      ),
    /older/,
  );
  assert.throws(
    () =>
      compare(
        snapshot([r]),
        snapshot([{ ...r, arrival: '2026-12-31T12:10:00+09:00' }]),
      ),
    /duration/,
  );
  assert.throws(
    () =>
      compare(
        snapshot([r]),
        snapshot([{ ...r, fetchedAt: '2026-10-13T00:00:00Z' }]),
      ),
    /Future/,
  );
});
test('Previously dated EVA details survive a matching basic schedule, but are not copied to a changed flight', () => {
  const detailed = {
    ...r,
    terminal: 'T2',
    aircraft: '787-10',
    detail: {
      url: 'https://booking.evaair.com/flyeva/eva/b2c/flight-details.aspx?Week_DT=12/31/2026',
      fetchedAt: r.fetchedAt,
      departureTerminal: 'T2',
      arrivalTerminal: null,
      aircraft: '787-10',
      scope: 'segment' as const,
      nonstop: true as const,
    },
  };
  assert.deepEqual(
    compare(snapshot([detailed]), snapshot([r])).staged.records[0].detail,
    detailed.detail,
  );
  const moved = {
    ...r,
    departure: '2026-12-31T08:05:00+08:00',
    arrival: '2026-12-31T12:10:00+09:00',
  };
  assert.equal(
    compare(snapshot([detailed]), snapshot([moved])).staged.records[0].detail,
    undefined,
  );
});
test('Missing optional continuation metadata is preserved only when the dated schedule still matches', () => {
  const continued = { ...r, continuationAirport: 'LHR' };
  const unchanged = compare(snapshot([continued]), snapshot([r]));
  assert.equal(unchanged.summary.changed, 0);
  assert.equal(unchanged.staged.records[0].continuationAirport, 'LHR');
  const moved = {
    ...r,
    departure: '2026-12-31T08:05:00+08:00',
    arrival: '2026-12-31T12:10:00+09:00',
  };
  assert.equal(
    compare(snapshot([continued]), snapshot([moved])).staged.records[0]
      .continuationAirport,
    undefined,
  );
});
test('The cutoff applies to departure date and keeps January arrival with country/time search', () => {
  const night = peach.records.find(
    (x) => x.date === '2026-12-31' && x.number === 'MM860',
  )! as SavedFlight;
  const result = compareSchedules(
    snapshot([night]),
    snapshot([night]),
    'peach',
    '2026-10-12',
    new Date(Date.parse(night.fetchedAt) + 1000).toISOString(),
  );
  const flights = result.staged.records.map(normalizeCollected);
  const found = filterFlights(flights, {
    date: '2026-12-31',
    q: '日本東京',
    start: '20:55',
    end: '23:59',
    status: '',
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].scheduledArrival, '2027-01-01T00:50:00+09:00');
  assert.equal(
    filterFlights(flights, {
      date: '2026-12-31',
      q: '日本東京',
      start: '20:56',
      end: '23:59',
      status: '',
    }).length,
    0,
  );
});
async function fixture(t: any) {
  const fixtureRoot = path.resolve('data/cache/flight-update-tests');
  await fs.mkdir(fixtureRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(fixtureRoot, 'case-'));
  t.after(async () => {
    const resolved = await fs.realpath(dir);
    assert.equal(path.dirname(resolved), await fs.realpath(fixtureRoot));
    assert.ok(path.basename(resolved).startsWith('case-'));
    await fs.rm(resolved, { recursive: true });
  });
  await fs.mkdir(path.join(dir, 'src/server/data'), { recursive: true });
  for (const file of [
    'peach-booking-checks.json',
    'peach-verification-progress.json',
  ])
    await fs.writeFile(path.join(dir, 'src/server/data', file), 'preserve-me');
  const target = path.join(dir, 'src/server/data/eva-flights.json');
  await fs.writeFile(
    target,
    JSON.stringify(
      snapshot([r, { ...r, number: 'BR198', operatingNumber: 'BR198' }]),
    ),
  );
  const candidate = path.join(dir, 'incoming.json');
  await fs.writeFile(
    candidate,
    JSON.stringify(
      snapshot([
        {
          ...r,
          departure: '2026-12-31T08:05:00+08:00',
          arrival: '2026-12-31T12:10:00+09:00',
        },
      ]),
    ),
  );
  return { dir, target, candidate };
}
test('Preparation backs up unchanged live bytes; reviewed application retains pending and is repeatable', async (t) => {
  const f = await fixture(t),
    before = await fs.readFile(f.target);
  const prepared = await prepareUpdate(f.dir, 'eva', f.candidate, '2026-10-12');
  assert.deepEqual(await fs.readFile(f.target), before);
  assert.deepEqual(
    await fs.readFile(path.join(prepared.run, 'before.json')),
    before,
  );
  assert.equal(
    (await inspectUpdate(f.dir, prepared.run)).originalDataStillPresent,
    true,
  );
  assert.ok(
    (await fs.readFile(path.join(prepared.run, 'review.md'), 'utf8')).includes(
      '保留待確認',
    ),
  );
  assert.ok(
    (
      await fs.readFile(path.join(prepared.run, 'changes.csv'), 'utf8')
    ).startsWith('\uFEFF'),
  );
  await assert.rejects(
    () => applyUpdate(f.dir, prepared.run, 'wrong'),
    /confirmation/,
  );
  assert.deepEqual(await fs.readFile(f.target), before);
  const applied = await applyUpdate(
    f.dir,
    prepared.run,
    prepared.candidateSha256,
  );
  assert.equal(applied.state, 'applied');
  assert.equal(
    (await inspectUpdate(f.dir, prepared.run)).candidateDataPresent,
    true,
  );
  const result = JSON.parse(await fs.readFile(f.target, 'utf8'));
  assert.equal(result.records.length, 2);
  assert.ok(result.records.some((x: SavedFlight) => x.number === 'BR198'));
  const bytes = await fs.readFile(f.target);
  assert.equal(
    (await applyUpdate(f.dir, prepared.run, prepared.candidateSha256))
      .repeatedApply,
    true,
  );
  assert.deepEqual(await fs.readFile(f.target), bytes);
  assert.equal(
    await fs.readFile(
      path.join(f.dir, 'src/server/data/peach-booking-checks.json'),
      'utf8',
    ),
    'preserve-me',
  );
});
test('An intervening edit to website data or preserved booking progress blocks the old update', async (t) => {
  const f = await fixture(t),
    prepared = await prepareUpdate(f.dir, 'eva', f.candidate, '2026-10-12');
  const altered = JSON.stringify({
    ...snapshot([r]),
    importedAt: '2026-10-12T00:00:00Z',
  });
  await fs.writeFile(f.target, altered);
  await assert.rejects(
    () => applyUpdate(f.dir, prepared.run, prepared.candidateSha256),
    /Current data changed/,
  );
  assert.equal(await fs.readFile(f.target, 'utf8'), altered);
  await fs.writeFile(
    f.target,
    await fs.readFile(path.join(prepared.run, 'before.json')),
  );
  await fs.writeFile(
    path.join(f.dir, 'src/server/data/peach-verification-progress.json'),
    'new progress',
  );
  await assert.rejects(
    () => applyUpdate(f.dir, prepared.run, prepared.candidateSha256),
    /progress changed/,
  );
});
test('Tampered staged files cannot be applied, and an interrupted post-rename commit can be recovered', async (t) => {
  const f = await fixture(t),
    prepared = await prepareUpdate(f.dir, 'eva', f.candidate, '2026-10-12');
  const file = path.join(prepared.run, 'candidate.json'),
    original = await fs.readFile(file);
  await fs.appendFile(file, ' ');
  await assert.rejects(
    () => applyUpdate(f.dir, prepared.run, prepared.candidateSha256),
    /Candidate changed/,
  );
  await fs.writeFile(file, original);
  await applyUpdate(f.dir, prepared.run, prepared.candidateSha256);
  const progressFile = path.join(prepared.run, 'progress.json'),
    state = JSON.parse(await fs.readFile(progressFile, 'utf8'));
  await fs.writeFile(
    progressFile,
    JSON.stringify({ ...state, state: 'applying' }),
  );
  const recovered = await applyUpdate(
    f.dir,
    prepared.run,
    prepared.candidateSha256,
  );
  assert.equal(recovered.recoveredAfterInterruption, true);
  assert.equal(recovered.state, 'applied');
});
test('An existing update lock stops concurrent writes without replacing that lock', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.dir, 'data/flight-updates'), { recursive: true });
  const lock = path.join(f.dir, 'data/flight-updates/eva.lock');
  await fs.writeFile(lock, 'active-owner');
  await assert.rejects(
    () => prepareUpdate(f.dir, 'eva', f.candidate, '2026-10-12'),
    /EEXIST/,
  );
  assert.equal(await fs.readFile(lock, 'utf8'), 'active-owner');
});

test('A one-cell refresh leaves unqueried dates and airports intact rather than marking them missing', () => {
  const missing = { ...r, number: 'BR198', operatingNumber: 'BR198' };
  const otherAirport = { ...r, airport: 'KIX' };
  const otherDay = {
    ...r,
    date: '2026-12-30',
    departure: r.departure.replace('12-31', '12-30'),
    arrival: r.arrival.replace('12-31', '12-30'),
  };
  const result = compareSchedules(
    snapshot([r, missing, otherAirport, otherDay]),
    snapshot([r]),
    'eva',
    '2026-10-13',
    '2026-10-13T03:00:00Z',
    { cells: [{ date: r.date, airport: 'NRT' }] },
  );
  assert.equal(result.summary.before, 2);
  assert.equal(result.summary.notRechecked, 2);
  assert.equal(result.summary.retainedPending, 1);
  assert.equal(result.staged.records.length, 4);
  assert.deepEqual(
    result.staged.records.find((x) => x.airport === 'KIX'),
    otherAirport,
  );
  assert.deepEqual(
    result.staged.records.find((x) => x.date === '2026-12-30'),
    otherDay,
  );
  assert.deepEqual(
    result.changes.pending.map((p) => p.record.number),
    ['BR198'],
  );
});
test('Observation scope cannot omit the candidate, exceed the date window or contain duplicate cells', () => {
  const scoped = (cells: any[]) =>
    compareSchedules(
      snapshot([r]),
      snapshot([r]),
      'eva',
      '2026-10-13',
      '2026-10-13T03:00:00Z',
      { cells },
    );
  assert.throws(() => scoped([]), /Empty/);
  assert.throws(
    () => scoped([{ date: r.date, airport: 'KIX' }]),
    /outside observed/,
  );
  assert.throws(
    () => scoped([{ date: '2027-01-01', airport: 'NRT' }]),
    /Invalid/,
  );
  assert.throws(
    () =>
      scoped([
        { date: r.date, airport: 'NRT' },
        { date: r.date, airport: 'NRT' },
      ]),
    /Duplicate/,
  );
});
test('Scoped packages bind the official replay proof and refuse changed source files before applying', async (t) => {
  const f = await fixture(t),
    scope = { cells: [{ date: r.date, airport: 'NRT' }] };
  const digest = (v: Buffer | string) =>
    createHash('sha256').update(v).digest('hex');
  const raw = path.join(f.dir, 'source.html'),
    proofFile = path.join(f.dir, 'proof.json');
  await fs.writeFile(raw, 'source-fixture');
  const proof = {
    version: 1,
    status: 'verified',
    airline: 'eva',
    scope,
    candidateSha256: digest(await fs.readFile(f.candidate)),
    fileSha256: { 'source.html': digest('source-fixture') },
  };
  await fs.writeFile(proofFile, JSON.stringify(proof));
  const prepared = await prepareUpdate(
    f.dir,
    'eva',
    f.candidate,
    '2026-10-13',
    { scope, evidenceFile: proofFile },
  );
  const before = await fs.readFile(f.target);
  await fs.writeFile(raw, 'changed');
  await assert.rejects(
    () => applyUpdate(f.dir, prepared.run, prepared.candidateSha256),
    /Source evidence changed/,
  );
  assert.deepEqual(await fs.readFile(f.target), before);
  await fs.writeFile(raw, 'source-fixture');
  await fs.appendFile(proofFile, ' ');
  await assert.rejects(
    () => applyUpdate(f.dir, prepared.run, prepared.candidateSha256),
    /Source audit changed/,
  );
  await fs.writeFile(proofFile, JSON.stringify(proof));
  assert.equal(
    (await applyUpdate(f.dir, prepared.run, prepared.candidateSha256)).state,
    'applied',
  );
});
test('A proof for another candidate is rejected before any update package is prepared', async (t) => {
  const f = await fixture(t),
    scope = { cells: [{ date: r.date, airport: 'NRT' }] };
  const proofFile = path.join(f.dir, 'proof.json');
  await fs.writeFile(
    proofFile,
    JSON.stringify({
      status: 'verified',
      airline: 'eva',
      scope,
      candidateSha256: 'wrong',
      fileSha256: {},
    }),
  );
  const before = await fs.readFile(f.target);
  await assert.rejects(
    () =>
      prepareUpdate(f.dir, 'eva', f.candidate, '2026-10-13', {
        scope,
        evidenceFile: proofFile,
      }),
    /another candidate/,
  );
  assert.deepEqual(await fs.readFile(f.target), before);
});
test('Prepared and source-denied workflows resume without issuing another collection request', async (t) => {
  const f = await fixture(t),
    prepared = await prepareUpdate(f.dir, 'eva', f.candidate, '2026-10-13');
  const root = path.join(f.dir, 'data/source-samples/crawler/resume-fixture');
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, 'progress.json'),
    job = {
      version: 1,
      airline: 'eva',
      from: '2026-10-13',
      through: '2026-12-31',
      state: 'prepared',
      step: 'prepare',
      sourceDirectory: 'data/source-samples/crawler/source-fixture',
      updateRun: prepared.run,
    };
  await fs.writeFile(file, JSON.stringify(job));
  const result = await refreshSchedules(f.dir, {
    resume: root,
    python: 'must-not-be-executed',
  });
  assert.equal(result.job.state, 'prepared');
  assert.ok(result.update && 'originalDataStillPresent' in result.update);
  assert.equal(result.update.originalDataStillPresent, true);
  await fs.writeFile(
    file,
    JSON.stringify({
      ...job,
      state: 'pending_confirmation',
      error: 'HTTP 403',
    }),
  );
  const pending = await refreshSchedules(f.dir, {
    resume: root,
    python: 'must-not-be-executed',
  });
  assert.equal(pending.job.state, 'pending_confirmation');
  assert.equal(pending.job.error, 'HTTP 403');
  assert.equal(pending.update, undefined);
});
