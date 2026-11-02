/** Bounded public PDF collector and complete Taoyuan-column research parser. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CI_PDF_SOURCE } from '../../src/server/providers/experimental/ci-timetable';
import {
  parseCiNetwork,
  ciNetworkFlightsOnDate,
  type CiNetworkExtraction,
} from '../../src/server/providers/experimental/ci-network';
import { taipeiDate, validDate } from '../../src/lib/time';

const run = promisify(execFile);
const root = path.resolve('data/source-samples/crawler');
const output = path.resolve('data/cache/ci-network');
const limit = 10_000_000;
async function download() {
  const response = await fetch(CI_PDF_SOURCE, {
    headers: {
      'User-Agent':
        'FlightStatusResearch/0.1 (local schedule feasibility test)',
      Accept: 'application/pdf',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (
    !response.ok ||
    !response.headers.get('content-type')?.includes('application/pdf')
  ) {
    await response.body?.cancel();
    throw new Error(`Public PDF rejected: HTTP ${response.status}`);
  }
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('Oversized PDF');
  }
  if (!response.body) throw new Error('Empty PDF');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > limit) {
        await reader.cancel();
        throw new Error('Oversized PDF');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const pdf = Buffer.concat(chunks);
  if (pdf.subarray(0, 5).toString() !== '%PDF-')
    throw new Error('Invalid PDF signature');
  return pdf;
}
async function main() {
  const args = process.argv.slice(2),
    option = (name: string) => {
      const i = args.indexOf(name);
      return i < 0 ? undefined : args[i + 1];
    };
  const offline = args.includes('--offline'),
    from = option('--from') || taipeiDate();
  if (!validDate(from)) throw new Error('Use --from YYYY-MM-DD');
  const python = option('--python') || process.env.PYTHON_BINARY || 'python';
  const observedAt = new Date().toISOString();
  await fs.mkdir(root, { recursive: true });
  const buffer = offline
    ? await fs.readFile(path.join(root, 'ci-timetable.pdf'))
    : await download();
  if (buffer.length > limit || buffer.subarray(0, 5).toString() !== '%PDF-')
    throw new Error('Invalid PDF input');
  const candidate = path.join(root, 'ci-network-candidate.pdf');
  await fs.writeFile(candidate, buffer);
  let extraction: CiNetworkExtraction;
  try {
    const r = await run(
      python,
      [path.resolve('scripts/crawler/extract-ci-network.py'), candidate],
      { timeout: 30_000, maxBuffer: 2_000_000, windowsHide: true },
    );
    extraction = JSON.parse(r.stdout);
  } finally {
    await fs.unlink(candidate);
  }
  const timetable = parseCiNetwork(extraction);
  const failures: { date: string; error: string }[] = [];
  const collected: ReturnType<typeof ciNetworkFlightsOnDate> = [];
  // Check the entire published period, including historical cancellations and DST boundaries.
  for (
    let date = timetable.validFrom;
    date <= timetable.validUntil;
    date = new Date(Date.parse(date) + 86400_000).toISOString().slice(0, 10)
  ) {
    try {
      const daily = ciNetworkFlightsOnDate(timetable, date);
      if (date >= from) collected.push(...daily);
    } catch (e) {
      failures.push({
        date,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  if (failures.length) {
    await fs.writeFile(
      path.join(root, 'ci-network-rejected.json'),
      JSON.stringify({ observedAt, failures }, null, 2),
    );
    throw new Error(
      `Schedule validation failed on ${failures.length} dates: ${failures[0].error}; previous inventory preserved`,
    );
  }
  if (!offline)
    await fs.writeFile(path.join(root, 'ci-network-latest.pdf'), buffer);
  const sourceSha256 = createHash('sha256').update(buffer).digest('hex');
  let sourceRetrievedAt: string | null = offline ? null : observedAt;
  if (offline) {
    // An offline replay is not a fresh observation; keep an earlier matching
    // download receipt if one exists, rather than advancing its timestamp.
    try {
      const previous = JSON.parse(
        await fs.readFile(path.join(output, 'coverage.json'), 'utf8'),
      );
      const receipt = previous.sourceRetrievedAt ?? previous.downloadedAt;
      if (
        previous.sha256 === sourceSha256 &&
        previous.sourceUrl === CI_PDF_SOURCE &&
        typeof receipt === 'string' &&
        Number.isFinite(Date.parse(receipt))
      )
        sourceRetrievedAt = receipt;
    } catch {
      /* No verified receipt: leave source retrieval unknown. */
    }
  }
  const records = collected.map((record) => ({
    ...record,
    sourceUrl: CI_PDF_SOURCE,
    sourceSha256,
    sourceRetrievedAt,
    parsedAt: new Date().toISOString(),
  }));
  await fs.writeFile(
    path.join(root, 'ci-network-extraction.json'),
    JSON.stringify(extraction, null, 2),
  );
  const uniqueNumbers = new Set(records.map((r) => r.number));
  const coverage = {
    observedAt,
    mode: offline ? 'offline_replay' : 'live_pdf_download',
    downloadedAt: offline ? null : observedAt,
    sourceRetrievedAt,
    sourceUrl: CI_PDF_SOURCE,
    sha256: sourceSha256,
    pdfPages: extraction.pages,
    sourceValidFrom: timetable.validFrom,
    sourceValidUntil: timetable.validUntil,
    requestedFrom: from,
    actualFrom: from > timetable.validFrom ? from : timetable.validFrom,
    allTaoyuanFutureFlightsComplete: false,
    integratedIntoWebsite: false,
    unattendedCollector: false,
    permissionForPublicReuse: 'not_established',
    dataKind: 'published_schedule_not_live_status_or_seat_availability',
    sections: timetable.sections.length,
    rules: timetable.rules.length,
    destinationsWithRecords: new Set(records.map((r) => r.destinationLabel))
      .size,
    dailyMarketingRecords: records.length,
    uniqueMarketingFlightNumbers: uniqueNumbers.size,
    codeshareDailyRecords: records.filter((r) => r.operatingNumber).length,
    unresolvedAirportDailyRecords: records.filter((r) => !r.arrivalAirport)
      .length,
    noAirportCandidateDailyRecords: records.filter(
      (r) => !r.candidateArrivalAirport,
    ).length,
    directoryZoneDisagreements: [
      ...new Set(
        timetable.rules
          .filter((r) => r.directoryTimeZoneAgrees === false)
          .map((r) => r.destinationLabel),
      ),
    ],
    excludedContinuationRows: timetable.sections.reduce(
      (sum, s) => sum + s.continuationRowsExcluded,
      0,
    ),
    allPublishedDatesValidated: true,
    validationFailures: failures,
    destinations: timetable.sections.map((s) => ({
      ...s,
      records: records.filter((r) => r.destinationLabel === s.destination)
        .length,
      flightNumbers: [
        ...new Set(
          records
            .filter((r) => r.destinationLabel === s.destination)
            .map((r) => r.number),
        ),
      ],
    })),
  };
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(
    path.join(output, 'coverage.json'),
    JSON.stringify(coverage, null, 2),
  );
  await fs.writeFile(
    path.join(output, 'rules.json'),
    JSON.stringify(timetable, null, 2),
  );
  await fs.writeFile(
    path.join(output, 'flights.json'),
    JSON.stringify({ coverage, records }, null, 2),
  );
  const fields = [
    'number',
    'marketingCarrier',
    'operatingCarrier',
    'operatingNumber',
    'departureAirport',
    'destinationLabel',
    'arrivalAirport',
    'candidateArrivalAirport',
    'airportResolution',
    'departureLocal',
    'arrivalLocal',
    'arrivalTimeZone',
    'durationMinutes',
    'aircraft',
    'sourcePage',
    'status',
    'sourceUrl',
    'sourceSha256',
    'sourceRetrievedAt',
    'parsedAt',
  ] as const;
  const cell = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  await fs.writeFile(
    path.join(output, 'flights.csv'),
    '\uFEFF' +
      [
        fields.join(','),
        ...records.map((r) => fields.map((f) => cell(r[f])).join(',')),
      ].join('\n') +
      '\n',
  );
  const overview = [
    '# 華航公開班表收集結果',
    '',
    `來源有效期：${timetable.validFrom}～${timetable.validUntil}；本次記錄從 ${coverage.actualFrom} 起。`,
    `共 ${coverage.destinationsWithRecords} 個目的地、${uniqueNumbers.size} 個掛牌班號、${records.length} 筆逐日預定班表。`,
    '',
    '**不是全部桃園航班，也不是即時動態或仍可訂位的證明。** 空白機場欄代表原文只有城市；候選機場需再核對。',
    '',
    '| PDF 目的地 | 頁碼 | 班號 | 逐日記錄 |',
    '| --- | --- | --- | --- |',
    ...coverage.destinations.map(
      (s) =>
        `| ${s.destination} | ${s.page} | ${s.flightNumbers.join('、')} | ${s.records} |`,
    ),
    '',
    '詳情保存在 flights.json；CSV 起降時刻含當地 UTC 時差。印刷班表未提供航廈、登機門及即時延誤。',
    '共用班號保留括號中的承運班號，不能把掛牌筆數當作實際飛機數量。布里斯本只收桃園出發的第一航段。',
    '墨爾本的既有時區目錄為 Australia/Hobart，本次保留差異，採 Australia/Melbourne 並核對印刷航程時長。',
  ];
  await fs.writeFile(
    path.join(output, 'overview.md'),
    overview.join('\n') + '\n',
  );
  console.log(
    JSON.stringify(
      { ...coverage, destinations: undefined, outputDirectory: output },
      null,
      2,
    ),
  );
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
