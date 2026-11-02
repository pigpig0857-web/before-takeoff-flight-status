/** Local feasibility trial: visible browser sample first, optional single public HTML GET. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

async function main() {
  const directory = resolve('data/source-samples/crawler/trip');
  const sample = JSON.parse(
    await readFile(resolve(directory, 'browser-sample.json'), 'utf8'),
  );
  const url = new URL(sample.sourceUrl);
  if (
    url.origin !== 'https://tw.trip.com' ||
    url.pathname !== '/flights/showfarefirst' ||
    url.searchParams.get('dairport') !== 'tpe' ||
    url.searchParams.get('aairport') !== 'nrt' ||
    url.searchParams.get('ddate') !== sample.query.date ||
    url.searchParams.get('triptype') !== 'ow' ||
    url.searchParams.get('quantity') !== '1' ||
    url.searchParams.get('nonstoponly') !== 'on' ||
    url.searchParams.get('class') !== 'y' ||
    sample.query.date !== '2026-12-30' ||
    sample.query.adults !== 1 ||
    sample.query.directOnly !== true ||
    sample.query.departure !== 'TPE' ||
    sample.query.arrival !== 'NRT' ||
    sample.coverage !== 'partial_browser_sample'
  )
    throw new Error(
      'Unexpected source or query; this trial only supports the observed TPE–NRT sample.',
    );

  const records = sample.rows.map(
    (row: { summary: string; text: string; airlines: string[] }) => {
      const summary = row.summary.replace(/\s+/g, ' ').trim();
      const match =
        /^航班於 (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) 從 臺灣桃園國際機場 (T\d+) 出發，並於 (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) 抵達 成田國際機場 (T\d+)。 此為飛行時間 (\d+) 小時(?: (\d+) 分)? 的直飛航班 單程價格：TWD[\d,]+$/.exec(
          summary,
        );
      if (
        !match ||
        match[1] !== sample.query.date ||
        row.airlines.length !== 1 ||
        !row.text.includes('TPE') ||
        !row.text.includes('NRT')
      ) {
        throw new Error(
          'Changed layout, date, airport or carrier; stop instead of guessing.',
        );
      }
      const departureLocal = `${match[1]}T${match[2]}`;
      const arrivalLocal = `${match[4]}T${match[5]}`;
      // Explicit offsets are valid for this limited Taiwan/Japan trial; not a worldwide converter.
      const departureInstant = new Date(`${departureLocal}+08:00`);
      const arrivalInstant = new Date(`${arrivalLocal}+09:00`);
      const durationMinutes =
        (arrivalInstant.getTime() - departureInstant.getTime()) / 60_000;
      const printedMinutes = Number(match[7]) * 60 + Number(match[8] ?? 0);
      if (
        !Number.isFinite(durationMinutes) ||
        durationMinutes <= 0 ||
        durationMinutes !== printedMinutes
      ) {
        throw new Error(
          'Local dates/time zones conflict with the printed flight duration.',
        );
      }
      const airline = row.airlines[0].trim();
      const details = sample.confirmedDetails.filter(
        (detail: {
          airline: string;
          departureLocal: string;
          arrivalLocal: string;
        }) =>
          detail.airline === airline &&
          detail.departureLocal === departureLocal &&
          detail.arrivalLocal === arrivalLocal,
      );
      if (details.length > 1) throw new Error('Ambiguous flight identity.');
      return {
        airline,
        flightNumber: details[0]?.flightNumber ?? null,
        departureAirport: 'TPE',
        departureTerminal: match[3],
        departureLocal,
        departureTimeZone: 'Asia/Taipei',
        departureUtc: departureInstant.toISOString(),
        arrivalAirport: 'NRT',
        arrivalTerminal: match[6],
        arrivalLocal,
        arrivalTimeZone: 'Asia/Tokyo',
        arrivalUtc: arrivalInstant.toISOString(),
        durationMinutes,
        source: 'Trip.com booking search',
        status: 'booking_search_observation',
      };
    },
  );
  if (records.length === 0)
    throw new Error('No captured sample; this is not proof of no flights.');

  let htmlProbe: Record<string, unknown> = { status: 'not_requested' };
  if (process.argv.includes('--probe')) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent':
            'FlightStatusResearch/0.1 (local schedule feasibility test)',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
      });
      const location = response.headers.get('location');
      const redirectTarget = location ? new URL(location, url) : null;
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (reader) {
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 2_000_000)
              throw new Error('HTML exceeds the 2 MB trial limit.');
            chunks.push(chunk.value);
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      }
      const body = Buffer.concat(chunks);
      const html = body.toString('utf8');
      await writeFile(resolve(directory, 'http-response.html'), body);
      htmlProbe = {
        checkedAt: new Date().toISOString(),
        httpStatus: response.status,
        redirectTarget: redirectTarget
          ? { origin: redirectTarget.origin, pathname: redirectTarget.pathname }
          : null,
        contentType: response.headers.get('content-type'),
        bytes,
        sha256: createHash('sha256').update(body).digest('hex'),
        hasObservedFlightGroupLabel: /aria-label=["']航班於 2026-12-30/.test(
          html,
        ),
        hasConfirmedFlightNumberText: html.includes('TR866'),
        status: response.ok
          ? 'html_received_not_a_browser_search'
          : 'source_refused_or_redirected',
      };
    } catch (error) {
      htmlProbe = {
        checkedAt: new Date().toISOString(),
        status: 'request_failed',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  } else {
    // Keep a previous real probe when replaying the browser sample offline.
    try {
      htmlProbe = JSON.parse(
        await readFile(resolve(directory, 'latest-trial.json'), 'utf8'),
      ).htmlProbe;
    } catch {
      /* first offline run */
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    browserCapturedAt: sample.capturedAt,
    sourceUrl: sample.sourceUrl,
    query: sample.query,
    coverage: 'partial_browser_sample',
    observedCountText: sample.visibleResultCountText,
    extractedRecordCount: records.length,
    confirmedFlightNumberCount: records.filter(
      (record: { flightNumber: string | null }) => record.flightNumber,
    ).length,
    independentlyConfirmedByAirline: false,
    repeatabilityEstablished: false,
    integratedIntoWebsite: false,
    htmlProbe,
    records,
  };
  await writeFile(
    resolve(directory, 'latest-trial.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify(
      {
        records: records.length,
        confirmedFlightNumbers: report.confirmedFlightNumberCount,
        coverage: report.coverage,
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
