import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCiNetwork,
  ciNetworkFlightsOnDate,
  type CiNetworkExtraction,
} from '../src/server/providers/experimental/ci-network';

// Factual excerpts of the locally reviewed 2026 Jul–Oct booklet (Issue 2).
function sample(text: string): CiNetworkExtraction {
  return {
    coverText: '2026.07.01 2026.10.24\nIssue 2',
    pages: 29,
    columns: Array.from({ length: 29 }, (_, i) => ({
      page: i + 1,
      text: i === 8 ? text : '',
    })),
  };
}
test('CI network preserves marketing and operating identities without treating shares as additional planes', () => {
  const t = parseCiNetwork(
    sample(
      [
        'TAIPEI SONGSHAN TOKYO HANEDA 3h10m',
        'CI 220 1234567 09:00-13:10 333 -',
        'TAIPEI TAOYUAN TOKYO NARITA 3h20m ~ 3h25m',
        'CI 100 1234567 08:50-13:15 EQV -',
        'CI 9902 (JL 802) 1234567 10:25-14:55 73H -',
        'CI 8340/8341/9220-9223/9902/9909/9958/9959 (JL)',
        'KAOHSIUNG TOKYO NARITA 3h40m',
        'CI 102 1234567 07:55-12:35 32Q -',
      ].join('\n'),
    ),
  );
  const records = ciNetworkFlightsOnDate(t, '2026-10-06');
  assert.deepEqual(
    records.map((r) => r.number),
    ['CI100', 'CI9902'],
  );
  assert.equal(records[0].operatingNumber, null);
  assert.equal(records[1].operatingNumber, 'JL802');
  assert.equal(records[1].durationMinutes, 210);
  assert.equal(records[1].arrivalAirport, 'NRT');
});
test('CI network applies cancellations including slash-separated dates and preserves leading zeros', () => {
  const t = parseCiNetwork(
    sample(
      [
        'TAIPEI TAOYUAN LOS ANGELES 11h55m ~ 12h45m',
        'CI 008 1234567 23:50-21:35 77W/359 01Jul26-15Sep26',
        'CI 008 1234567 23:50-20:45 359/77W 16Sep26-24Oct26',
        'CI 008 - 12Jul26 07/09Sep26',
        'CI 008 TAIPEI TAOYUAN-LOS ANGELES flight cancelled on 12Jul26',
      ].join('\n'),
    ),
  );
  for (const date of ['2026-07-12', '2026-09-07', '2026-09-09'])
    assert.equal(ciNetworkFlightsOnDate(t, date).length, 0);
  const f = ciNetworkFlightsOnDate(t, '2026-10-06')[0];
  assert.equal(f.number, 'CI008');
  assert.equal(f.durationMinutes, 715);
  assert.equal(f.arrivalAirport, null);
  assert.equal(f.candidateArrivalAirport, 'LAX');
  assert.equal(f.airportResolution, 'city_candidate');
});
test('CI network extracts only Taoyuan first leg of CI053 and does not apply second-leg cancellations', () => {
  const t = parseCiNetwork(
    sample(
      [
        'TAIPEI TAOYUAN BRISBANE 8h40m',
        'AUCKLAND 3h05m',
        'CI 053 1 3456 23:55-10:35+1 359 01Jul26-25Sep26',
        '2 4567 12:55-18:00 359 02Jul26-26Sep26',
        'CI 053 1 3456 23:55-10:35+1 359 26Sep26-24Oct26',
        '2 4567 12:55-19:00 359 27Sep26-24Oct26',
        'CI 053 - 25/31Jul26 14/21/28Aug26',
        'CI 053 BRISBANE-AUCKLAND flight cancelled on 25/31Jul26',
      ].join('\n'),
    ),
  );
  assert.equal(t.sections[0].continuationRowsExcluded, 2);
  const f = ciNetworkFlightsOnDate(t, '2026-07-25')[0];
  assert.equal(f.destinationLabel, 'BRISBANE');
  assert.equal(f.durationMinutes, 520);
  assert.equal(f.firstLegOfContinuation, true);
  assert.equal(f.arrivalDate, '2026-07-26');
});
test('CI network resolves Australian DST and European arrival on DST ending day', () => {
  const t = parseCiNetwork(
    sample(
      [
        'TAIPEI TAOYUAN SYDNEY 9h15m',
        'CI 051 234 67 23:30-10:45+1 359/77W 01Jul26-01Oct26',
        'CI 051 234 67 23:30-11:45+1 77W 03Oct26-24Oct26',
        'TAIPEI TAOYUAN FRANKFURT 14h ~ 14h20m',
        'CI 061 1234567 22:30-06:50+1 77W 16Sep26-23Oct26',
        'CI 061 6 22:30-05:50+1 77W 24Oct26',
      ].join('\n'),
    ),
  );
  assert.equal(
    ciNetworkFlightsOnDate(t, '2026-10-03')[0].arrivalLocal,
    '2026-10-04T11:45:00+11:00',
  );
  const f = ciNetworkFlightsOnDate(t, '2026-10-24').find(
    (r) => r.number === 'CI061',
  )!;
  assert.equal(f.arrivalLocal, '2026-10-25T05:50:00+01:00');
  assert.equal(f.durationMinutes, 860);
});
test('CI network does not fill gaps between individually published dates or extend validity', () => {
  const t = parseCiNetwork(
    sample(
      [
        'TAIPEI TAOYUAN AMSTERDAM 14h30m ~ 14h50m',
        'CI 2073 2 4 02:30-11:00 77W 08Sep26 / 10Sep26',
      ].join('\n'),
    ),
  );
  assert.equal(ciNetworkFlightsOnDate(t, '2026-09-08').length, 1);
  assert.equal(ciNetworkFlightsOnDate(t, '2026-09-10').length, 1);
  assert.equal(ciNetworkFlightsOnDate(t, '2026-09-15').length, 0);
  assert.equal(ciNetworkFlightsOnDate(t, '2026-12-30').length, 0);
});
test('CI network leaves ambiguous city airports empty and preserves missing terminal information', () => {
  const t = parseCiNetwork(
    sample('TAIPEI TAOYUAN CHENGDU 3h35m\nCI 551 2 7 08:25-12:00 333/32Q -'),
  );
  const f = ciNetworkFlightsOnDate(t, '2026-10-06')[0];
  assert.equal(f.arrivalAirport, null);
  assert.equal(f.candidateArrivalAirport, null);
  assert.equal(f.airportResolution, 'unresolved');
  assert.equal(f.durationMinutes, 215);
  assert.equal(f.arrivalTerminal, null);
  assert.equal(f.gate, null);
});
test('CI network rejects new destinations, malformed rows, overlapping active rules and incorrect duration', () => {
  assert.throws(
    () => parseCiNetwork({ ...sample(''), columns: [] }),
    /Incomplete/,
  );
  assert.throws(
    () =>
      parseCiNetwork(
        sample('TAIPEI TAOYUAN UNKNOWN 3h\nCI 1 1234567 01:00-04:00 333 -'),
      ),
    /Unknown/,
  );
  assert.throws(
    () =>
      parseCiNetwork(
        sample('TAIPEI TAOYUAN TOKYO NARITA 3h20m\nCI 100 invalid'),
      ),
    /Unsupported/,
  );
  const t = parseCiNetwork(
    sample(
      'TAIPEI TAOYUAN TOKYO NARITA 3h20m ~ 3h25m\nCI 100 1234567 08:50-13:15 EQV -',
    ),
  );
  assert.throws(
    () =>
      ciNetworkFlightsOnDate(
        { ...t, rules: [...t.rules, t.rules[0]] },
        '2026-10-06',
      ),
    /Conflicting/,
  );
  assert.throws(
    () =>
      ciNetworkFlightsOnDate(
        { ...t, rules: t.rules.map((r) => ({ ...r, arrivalTime: '14:15' })) },
        '2026-10-06',
      ),
    /duration/,
  );
  assert.throws(() => ciNetworkFlightsOnDate(t, '2026-02-30'), /Invalid query/);
});
