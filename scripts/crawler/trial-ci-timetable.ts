import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  CI_PDF_SOURCE,
  parseCiTimetable,
  ciFlightsOnDate,
  type CiExtraction,
} from '../../src/server/providers/experimental/ci-timetable';
import { taipeiDate, validDate } from '../../src/lib/time';

const run = promisify(execFile);
const folder = path.resolve('data/source-samples/crawler');
const pdfPath = path.join(folder, 'ci-timetable.pdf');
const userAgent = 'FlightStatusResearch/0.1 (local schedule feasibility test)';
const maximumBytes = 10_000_000;

async function download() {
  const response = await fetch(CI_PDF_SOURCE, {
    headers: { 'User-Agent': userAgent, Accept: 'application/pdf' },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(
      `Public PDF HTTP ${response.status}; stopped without bypass or retry`,
    );
  if (!response.headers.get('content-type')?.includes('application/pdf'))
    throw new Error('Not a PDF response');
  if (Number(response.headers.get('content-length')) > maximumBytes)
    throw new Error('PDF exceeds size limit');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (!response.body) throw new Error('Empty PDF body');
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new Error('PDF exceeds size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = Buffer.concat(chunks);
  if (buffer.subarray(0, 5).toString() !== '%PDF-')
    throw new Error('Invalid PDF signature');
  return buffer;
}

async function probe(url: string) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': userAgent },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok && url.includes('Flightschedule')) {
      const html = await response.text();
      if (html.length > 2_000_000)
        throw new Error('Source page exceeds size limit');
      await fs.writeFile(path.join(folder, 'schedule-page.html'), html);
      const pdfLinks = [
        ...new Set(
          html.match(
            /https?:\/\/[^"'<>\s]+(?:CI-timetable|timetable-[^"'<>\s]+)\.pdf[^"'<>\s]*/gi,
          ) || [],
        ),
      ];
      return {
        url,
        status: response.status,
        accessible: true,
        pdfLinks,
        selectedPdfLinkedFromPage: pdfLinks.some(
          (link) => decodeURI(link) === decodeURI(CI_PDF_SOURCE),
        ),
      };
    }
    await response.body?.cancel();
    return { url, status: response.status, accessible: response.ok };
  } catch (error) {
    return {
      url,
      accessible: false,
      error: error instanceof Error ? error.message : 'request_failed',
    };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const from = option('--from') || taipeiDate();
  const days = Number(option('--days') || 30);
  if (!validDate(from) || !Number.isInteger(days) || days < 1 || days > 90)
    throw new Error('Use --from YYYY-MM-DD and --days 1..90');
  const python = option('--python') || process.env.PYTHON_BINARY || 'python';
  const offline = args.includes('--offline');
  await fs.mkdir(folder, { recursive: true });
  const checkedAt = new Date().toISOString();
  const checks =
    !offline && args.includes('--probe-pages')
      ? await Promise.all([
          probe('https://www.china-airlines.com/robots.txt'),
          probe(
            'https://booking.china-airlines.com/Flightschedule/?country=cn&locale=zh',
          ),
        ])
      : [];
  const buffer = offline ? await fs.readFile(pdfPath) : await download();
  if (buffer.length > maximumBytes) throw new Error('PDF exceeds size limit');
  // Parse a candidate before replacing the last successful downloaded sample.
  const candidate = path.join(folder, 'ci-timetable-candidate.pdf');
  await fs.writeFile(candidate, buffer);
  let extraction: CiExtraction;
  try {
    const result = await run(
      python,
      [path.resolve('scripts/crawler/extract-ci-timetable.py'), candidate],
      { timeout: 30_000, maxBuffer: 1_000_000, windowsHide: true },
    );
    extraction = JSON.parse(result.stdout);
  } finally {
    await fs.unlink(candidate);
  }
  const timetable = parseCiTimetable(extraction);
  const dates = Array.from({ length: days }, (_, i) =>
    new Date(Date.parse(`${from}T00:00:00Z`) + i * 86400_000)
      .toISOString()
      .slice(0, 10),
  );
  // Validate every date in the source, not only the requested demonstration range.
  for (
    let date = timetable.validFrom;
    date <= timetable.validUntil;
    date = new Date(Date.parse(`${date}T00:00:00Z`) + 86400_000)
      .toISOString()
      .slice(0, 10)
  ) {
    ciFlightsOnDate(timetable, date);
  }
  const daily = dates.map((date) => ({
    date,
    coverage:
      date < timetable.validFrom || date > timetable.validUntil
        ? 'outside_source_validity'
        : 'within_trial_scope',
    flights: ciFlightsOnDate(timetable, date),
  }));
  const flights = daily.flatMap((day) => day.flights);
  const report = {
    technicalResult: 'download_and_parse_succeeded',
    mode: offline ? 'offline_replay' : 'live_download',
    checkedAt,
    downloadedAt: offline ? null : checkedAt,
    sourceUrl: CI_PDF_SOURCE,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    pdfBytes: buffer.length,
    pdfPages: extraction.pages,
    permissionForPublicReuse: 'not_established',
    integratedIntoWebsite: false,
    scope:
      'CI operating flights only, TPE → NRT; excludes TSA, inbound flights and codeshares',
    validFrom: timetable.validFrom,
    validUntil: timetable.validUntil,
    issue: timetable.issue,
    operatingRules: timetable.rules.length,
    skippedCodeshareRows: timetable.skippedCodeshares,
    from,
    until: dates.at(-1),
    datesInSource: daily.filter((day) => day.coverage === 'within_trial_scope')
      .length,
    totalFlightRecords: flights.length,
    sourceChecks: checks,
    daily,
    limitations: [
      'Published schedule, not real-time status or seat availability',
      'Missing/out-of-range data does not mean there is no flight',
      'Download feasibility does not establish automated/public reuse permission',
      'PDF URL discovery/update and layout changes require maintenance',
    ],
  };
  await fs.writeFile(
    path.join(folder, 'ci-extraction.json'),
    JSON.stringify(extraction, null, 2),
  );
  await fs.writeFile(
    path.join(folder, 'ci-rules.json'),
    JSON.stringify(timetable, null, 2),
  );
  await fs.writeFile(
    path.join(folder, 'latest-trial.json'),
    JSON.stringify(report, null, 2),
  );
  if (!offline) await fs.writeFile(pdfPath, buffer);
  console.log(
    JSON.stringify(
      {
        technicalResult: report.technicalResult,
        mode: report.mode,
        validUntil: report.validUntil,
        operatingRules: report.operatingRules,
        datesInSource: report.datesInSource,
        totalFlightRecords: report.totalFlightRecords,
        example:
          daily.find((day) => day.date === '2026-10-20') ||
          daily.find((day) => day.flights.length),
        sourceChecks: checks,
        reportPath: path.join(folder, 'latest-trial.json'),
        integratedIntoWebsite: false,
        permissionForPublicReuse: report.permissionForPublicReuse,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
