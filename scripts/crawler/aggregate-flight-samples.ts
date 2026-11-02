/** Build a local research inventory from saved public-page observations. No network. */
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  analyzeTripSample,
  type TripSample,
  type TripDetail,
} from '../../src/server/providers/experimental/trip-direct';

const root = resolve('data/source-samples/crawler');
const output = resolve('data/cache/research-flights');
async function main() {
  const folders = (await readdir(root, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const cases: Array<Record<string, unknown>> = [];
  const records: ReturnType<typeof analyzeTripSample>['records'] = [];
  for (const folder of folders) {
    const directory = resolve(root, folder);
    const files = await readdir(directory);
    // Other experiments (PDF, stability logs) have their own schemas.
    if (!files.includes('cards.json')) continue;
    let sample: TripSample | undefined;
    try {
      sample = JSON.parse(
        await readFile(resolve(directory, 'cards.json'), 'utf8'),
      ) as TripSample;
      const details = JSON.parse(
        await readFile(resolve(directory, 'details.json'), 'utf8'),
      ) as TripDetail[];
      const result = analyzeTripSample(sample, details);
      records.push(...result.records);
      cases.push({
        sampleDirectory: folder,
        query: sample.query,
        observedAt: sample.capturedAt,
        status: result.completeObservedResult
          ? 'complete_observed_result'
          : 'partial',
        expectedCards: result.expectedCards,
        capturedCards: result.capturedCards,
        validatedDetails: result.validatedDetails,
        codeshares: result.codeshares,
        missingDetailCount: result.missingDetailCount,
      });
    } catch (error) {
      cases.push({
        sampleDirectory: folder,
        query: sample?.query ?? null,
        status: 'rejected',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const byIdentity = new Map<string, (typeof records)[number]>();
  for (const record of records) {
    // Marketing identity only. Never infer actual operating flight equality from times.
    const key = JSON.stringify([
      record.departure,
      record.arrival,
      record.number,
      record.marketingAirline,
      record.departureUtc,
      record.arrivalUtc,
    ]);
    const old = byIdentity.get(key);
    if (!old || record.observedAt > old.observedAt) byIdentity.set(key, record);
  }
  const unique = [...byIdentity.values()].sort(
    (a, b) =>
      a.departureUtc.localeCompare(b.departureUtc) ||
      a.arrival.localeCompare(b.arrival) ||
      a.number.localeCompare(b.number),
  );
  const coverage = {
    generatedAt: new Date().toISOString(),
    source: 'Saved Trip.com public browser observations',
    allTaoyuanFutureFlightsComplete: false,
    continuousDateCoverage: false,
    sampleCases: cases.length,
    completeObservedCases: cases.filter(
      (c) => c.status === 'complete_observed_result',
    ).length,
    rejectedCases: cases.filter((c) => c.status === 'rejected').length,
    rawValidatedRecords: records.length,
    uniqueMarketingRecords: unique.length,
    codeshares: unique.filter((r) => r.codeshareExplicitlyShown).length,
    missingArrivalTerminals: unique.filter((r) => !r.arrivalTerminal).length,
    missingOperatingAirlineClaims: unique.filter((r) => !r.operatingAirline)
      .length,
    missingOperatingFlightNumbers: unique.filter(
      (r) => !r.operatingFlightNumber,
    ).length,
    cases,
  };
  await mkdir(output, { recursive: true });
  await writeFile(
    resolve(output, 'coverage.json'),
    JSON.stringify(coverage, null, 2),
  );
  await writeFile(
    resolve(output, 'inventory.json'),
    JSON.stringify(
      {
        generatedAt: coverage.generatedAt,
        researchOnly: true,
        coverageFile: 'coverage.json',
        records: unique,
      },
      null,
      2,
    ),
  );
  const columns = [
    'number',
    'marketingAirline',
    'operatingAirline',
    'operatingFlightNumber',
    'codeshareExplicitlyShown',
    'departure',
    'arrival',
    'departureLocal',
    'arrivalLocal',
    'departureTimeZone',
    'arrivalTimeZone',
    'departureUtc',
    'arrivalUtc',
    'arrivalDayOffset',
    'departureTerminal',
    'arrivalTerminal',
    'durationMinutes',
    'aircraftCode',
    'status',
    'observedAt',
    'sourceUrl',
  ] as const;
  const csvCell = (value: unknown) =>
    `"${String(value ?? '').replace(/"/g, '""')}"`;
  await writeFile(
    resolve(output, 'inventory.csv'),
    '\ufeff' +
      [
        columns.join(','),
        ...unique.map((r) => columns.map((c) => csvCell(r[c])).join(',')),
      ].join('\r\n'),
  );
  const mdCell = (value: unknown) =>
    String(value ?? '未提供')
      .replace(/\|/g, '\\|')
      .replace(/\r?\n/g, ' ');
  const summary = [
    '# 本機航班收集清單',
    '',
    `產生時間（UTC）：${coverage.generatedAt}。共 ${coverage.uniqueMarketingRecords} 筆班號記錄，${coverage.completeObservedCases} 組來源結果完整讀取。`,
    '',
    '**僅為研究樣本；不是全部桃園航班，也沒有連續日期涵蓋。共用班號分列，筆數不代表實際飛機架次。**',
    '',
    '起降時間各採機場當地時間，ISO 時間中的時差保留夏令時間與日期線資訊。登機門、櫃台、報到截止及即時動態不在訂票來源提供的資料中。',
    '',
    '## 已收集的查詢',
    '',
    '| 目的地 | 出發日期 | 來源顯示筆數 | 已核對詳情 | 狀態 |',
    '|---|---|---:|---:|---|',
    ...cases.map((c) => {
      const q = c.query as TripSample['query'] | null;
      return `| ${mdCell(q?.arrival)} | ${mdCell(q?.date)} | ${mdCell(c.expectedCards)} | ${mdCell(c.validatedDetails)} | ${mdCell(c.status)} |`;
    }),
    '',
    '## 班號明細',
    '',
    '| 班號 | 掛牌公司 | 明示承運公司 | 航段 | 當地起飛（含時差） | 當地抵達（含時差） | 起飛航廈 | 抵達航廈 | 分鐘 | 機型代碼 |',
    '|---|---|---|---|---|---|---|---|---:|---|',
    ...unique.map(
      (r) =>
        '| ' +
        [
          r.number,
          r.marketingAirline,
          r.operatingAirline,
          `${r.departure}→${r.arrival}`,
          r.departureLocal,
          r.arrivalLocal,
          r.departureTerminal,
          r.arrivalTerminal,
          r.durationMinutes,
          r.aircraftCode,
        ]
          .map(mdCell)
          .join(' | ') +
        ' |',
    ),
    '',
    '來源 URL、逐筆核對時間及 UTC 詳見 inventory.json／inventory.csv；完整性與拒絕原因見 coverage.json。',
  ];
  await writeFile(resolve(output, 'inventory.md'), summary.join('\n'));
  console.log(
    JSON.stringify({ ...coverage, outputDirectory: output }, null, 2),
  );
  if (coverage.rejectedCases) process.exitCode = 1;
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
