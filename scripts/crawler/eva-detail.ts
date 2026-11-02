import assert from 'node:assert/strict';

export interface EvaDetailExpected {
  number: string;
  date: string;
  departureTime: string;
  arrivalTime: string;
  arrivalDayOffset: number;
  minutes: number;
  arrivalLabel: string;
}

/** Verify one published flight segment on its exact date; never copy to other dates. */
export function parseEvaDetail(text: string, expected: EvaDetailExpected) {
  assert.equal(
    (text.match(/Flight Time/g) || []).length,
    1,
    'Multiple or missing flight segments',
  );
  const match =
    /^Flight details (BR\d+)Operated By：(EVA AIR|EVA Airways)(?: View this flight status)? ([A-Z][a-z]{2}\. \d{1,2}, \d{4}) (\d{2}:\d{2}) TAIPEI TAIPEI \(TAOYUAN\)(?: Terminal (\d+))? (\d{2}:\d{2})([+-]\d+)? (.*?) Flight Time (\d+) Hours?(?: (\d+) Minutes?)? (.*?) seat maps(?: |$)/.exec(
      text,
    );
  assert.ok(match, 'Unrecognized EVA detail format');
  assert.equal(
    match[1].replace(/^BR0+(?=\d)/, 'BR'),
    expected.number,
    'Wrong flight number',
  );
  assert.equal(
    new Date(`${match[3]} UTC`).toISOString().slice(0, 10),
    expected.date,
    'Wrong departure date',
  );
  assert.equal(match[4], expected.departureTime, 'Changed departure time');
  assert.equal(match[6], expected.arrivalTime, 'Changed arrival time');
  assert.equal(
    Number(match[7] || 0),
    expected.arrivalDayOffset,
    'Changed arrival day',
  );
  assert.equal(
    Number(match[9]) * 60 + Number(match[10] || 0),
    expected.minutes,
    'Duration/UTC mismatch',
  );
  const airportName = match[8].replace(/ Terminal .+$/, '');
  assert.equal(
    airportName,
    expected.arrivalLabel.replace(/ Terminal .+$/, ''),
    'Wrong arrival airport label',
  );
  assert.ok(!match[5] || ['1', '2'].includes(match[5]), 'Unknown TPE terminal');
  const arrivalTerminal = / Terminal (.{1,30})$/.exec(match[8])?.[1] || null;
  assert.ok(
    /^(?:A|B)?\d{3}-\d{1,3}(?:ER)?$/.test(match[11]),
    'Unknown aircraft notation',
  );
  return {
    departureTerminal: match[5] ? `T${match[5]}` : null,
    arrivalTerminal,
    aircraft: match[11],
    operator: '長榮航空',
    minutes: expected.minutes,
    nonstop: true as const,
    scope: 'segment' as const,
  };
}
