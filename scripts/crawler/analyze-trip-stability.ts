/** Offline analysis of bounded, real browser observations; does not start a crawler. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type Row = { summary: string; airlines: string[] };
type Run = {
  label: string;
  status: string;
  checkedAt: string;
  countText: string | null;
  rows: Row[];
};
type Evidence = {
  capturedAt: string;
  detailEvidence: string[];
  directAttemptLabels: string[];
  lateObservationLabel: string;
  transferListLabels: string[];
  sourceThroughBaggageClaim: boolean;
};
const directory = resolve('data/source-samples/crawler/trip-stability');
async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}
function key(row: Row) {
  return JSON.stringify([
    row.airlines.map((x) => x.trim()),
    row.summary.replace(/\s+/g, ' ').split('單程價格')[0].trim(),
  ]);
}
function minutes(text: string) {
  const match = /^(\d+) 小時(?: (\d+) 分)?$/.exec(text);
  if (!match) throw new Error('Unrecognized duration.');
  return Number(match[1]) * 60 + Number(match[2] ?? 0);
}
async function main() {
  const { runs } = await json<{ runs: Run[] }>(resolve(directory, 'runs.json'));
  const evidence = await json<Evidence>(resolve(directory, 'evidence.json'));
  const baseline = await json<{ rows: Row[] }>(
    resolve('data/source-samples/crawler/trip/browser-sample.json'),
  );
  const baselineKeys = baseline.rows.map(key).sort();
  function runFor(label: string) {
    const matches = runs.filter((x) => x.label === label);
    if (matches.length !== 1)
      throw new Error(`Missing or ambiguous observation: ${label}`);
    return matches[0];
  }
  const direct = evidence.directAttemptLabels.map((label) => {
    const initial = runFor(label);
    const final =
      label === 'direct-new-tab-3'
        ? runFor(evidence.lateObservationLabel)
        : initial;
    return {
      label,
      initialStatus: initial.status,
      finalStatus: final.status,
      observedCountText: final.countText,
      sampledRows: final.rows.length,
      sameSampleIgnoringPricesAndOrder:
        JSON.stringify(final.rows.map(key).sort()) ===
        JSON.stringify(baselineKeys),
      firstCheckedAt: initial.checkedAt,
      finalCheckedAt: final.checkedAt,
    };
  });
  const connections = evidence.transferListLabels.map((label) => {
    const run = runFor(label);
    return {
      label,
      status: run.status,
      countText: run.countText,
      sampledRows: run.rows.length,
    };
  });
  if (
    evidence.detailEvidence.length !== 3 ||
    evidence.detailEvidence.some((x) => !x)
  )
    throw new Error('Missing connection detail observations.');
  const matchingDetails = evidence.detailEvidence.every(
    (x) => x === evidence.detailEvidence[0],
  );
  const detail = evidence.detailEvidence[0];
  const matches = [
    ...detail.matchAll(
      /航班於 (\d{4}) 年 (\d+) 月 (\d+) 日 (\d{2}:\d{2}) 從 (.*?) 出發，並於 (\d{4}) 年 (\d+) 月 (\d+) 日 (\d{2}:\d{2}) 抵達 (.*?) 飛行時間為 (\d+ 小時(?: \d+ 分)?) 班機詳情：([^、]+)、([A-Z0-9]{2}\d+)、([^ ]+)/g,
    ),
  ];
  if (matches.length !== 2)
    throw new Error('Expected exactly two complete observed flight segments.');
  const route = [
    {
      departure: 'TPE',
      arrival: 'ICN',
      departureOffset: '+08:00',
      arrivalOffset: '+09:00',
      departureName: '臺灣桃園國際機場 T1',
      arrivalName: '仁川國際機場 T2',
    },
    {
      departure: 'ICN',
      arrival: 'NRT',
      departureOffset: '+09:00',
      arrivalOffset: '+09:00',
      departureName: '仁川國際機場 T2',
      arrivalName: '成田國際機場 T1',
    },
  ];
  const segments = matches.map((match, index) => {
    const scope = route[index];
    if (match[5] !== scope.departureName || match[10] !== scope.arrivalName)
      throw new Error('Different connection route; do not reuse offsets.');
    const local = (year: string, month: string, day: string, time: string) =>
      `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${time}:00`;
    const departureLocal = local(match[1], match[2], match[3], match[4]);
    const arrivalLocal = local(match[6], match[7], match[8], match[9]);
    const departureUtc = new Date(
      departureLocal + scope.departureOffset,
    ).toISOString();
    const arrivalUtc = new Date(
      arrivalLocal + scope.arrivalOffset,
    ).toISOString();
    const durationMinutes =
      (Date.parse(arrivalUtc) - Date.parse(departureUtc)) / 60000;
    if (durationMinutes <= 0 || durationMinutes !== minutes(match[11]))
      throw new Error('Segment time contradicts printed duration.');
    return {
      departureAirport: scope.departure,
      arrivalAirport: scope.arrival,
      airline: match[12],
      flightNumber: match[13],
      departureLocal,
      arrivalLocal,
      departureUtc,
      arrivalUtc,
      durationMinutes,
    };
  });
  const layoverMatch = /在首爾中轉時間 (\d+ 小時(?: \d+ 分)?)/.exec(detail);
  if (!layoverMatch) throw new Error('No observed layover duration.');
  const layoverMinutes =
    (Date.parse(segments[1].departureUtc) -
      Date.parse(segments[0].arrivalUtc)) /
    60000;
  const totalMinutes =
    (Date.parse(segments[1].arrivalUtc) -
      Date.parse(segments[0].departureUtc)) /
    60000;
  if (
    layoverMinutes < 0 ||
    layoverMinutes !== minutes(layoverMatch[1]) ||
    totalMinutes !==
      segments[0].durationMinutes + layoverMinutes + segments[1].durationMinutes
  )
    throw new Error('Connection chronology is inconsistent.');
  const htmlProbe = (
    await json<{ htmlProbe: unknown }>(resolve(directory, 'http-probe.json'))
  ).htmlProbe;
  const report = {
    generatedAt: new Date().toISOString(),
    observationsFinishedAt: evidence.capturedAt,
    verdict: 'short_session_repeatable_but_not_production_stability',
    query: {
      departure: 'TPE',
      arrival: 'NRT',
      date: '2026-12-30',
      adults: 1,
      oneWay: true,
    },
    direct,
    connections,
    matchingDetails,
    connectionSample: {
      segments,
      layoverMinutes,
      totalMinutes,
      sourceThroughBaggageClaim: evidence.sourceThroughBaggageClaim,
      selfTransfer: 'unknown',
      separateTickets: 'unknown',
    },
    htmlProbe,
    sourceQualityIssue:
      'Connection card aria label confuses layover duration with total duration and contains an unexpanded template placeholder. Use complete segment details and cross-check visible totals.',
    limitations: [
      'one route and date',
      'same browser session; cookies and caches may be reused',
      'only first loaded cards sampled',
      'no independent airline confirmation',
      'no cloud, browser process restart, multi-day or unattended stability test',
      'not integrated into the website',
    ],
  };
  await writeFile(
    resolve(directory, 'analysis.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    JSON.stringify(
      {
        verdict: report.verdict,
        directAttempts: direct.length,
        initialResults: direct.filter(
          (x) => x.initialStatus === 'results_observed',
        ).length,
        eventualResults: direct.filter(
          (x) => x.finalStatus === 'results_observed',
        ).length,
        consistentDirectSamples: direct.every(
          (x) => x.sameSampleIgnoringPricesAndOrder,
        ),
        connectionListObservations: connections.length,
        identicalDetailObservations: matchingDetails ? 3 : 0,
        layoverMinutes,
        totalMinutes,
        htmlProbe,
      },
      null,
      2,
    ),
  );
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
