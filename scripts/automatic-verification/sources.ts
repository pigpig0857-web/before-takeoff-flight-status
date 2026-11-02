import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SavedFlight } from '../../src/server/providers/collected';
import { expandTigerSnapshot } from '../../src/server/providers/experimental/tigerair-schedule';
import { parseStarluxWeek } from '../../src/server/providers/experimental/starlux-timetable';
import { parseEvaDetail } from '../../src/server/providers/experimental/eva-schedule';
import type { Observation } from './compare';
import { utcOffset } from '../../src/features/flights/journey-time';
import { evaScheduleURL, evaTableObservations } from './eva-public-table';
import { vietnamPublicSegments } from './vietnam-public-segments';
import {
  philippinePublication,
  philippinePDFs,
} from '../../src/server/providers/philippine-source';

export interface Group {
  id: string;
  kind: string;
  url: string;
  records: SavedFlight[];
  queryDate?: string;
  airport?: string;
}
export interface ResponseEvidence {
  body: Buffer;
  at: string;
  file: string;
  url: string;
}
export type Download = (
  url: string,
  id: string,
  options?: {
    method?: string;
    body?: URLSearchParams;
    headers?: Record<string, string>;
  },
) => Promise<ResponseEvidence>;
const execute = promisify(execFile);
export const sha = (b: Buffer | string) =>
  createHash('sha256').update(b).digest('hex');
const read = async (file: string) =>
  JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const plain = (r: SavedFlight): Observation => ({
  ...(r.origin === 'KHH' && { origin: r.origin }),
  number: r.number,
  date: r.date,
  airport: r.airport!,
  departure: r.departure,
  arrival: r.arrival,
  minutes: r.minutes,
});
const wall = (instant: string, zone: string) => {
  const offset = utcOffset(instant, zone).replace('UTC', '');
  const sign = offset[0] === '-' ? -1 : 1;
  const minutes =
    sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  return (
    new Date(Date.parse(instant) + minutes * 60000).toISOString().slice(0, 19) +
    offset
  );
};

export function buildGroups(
  records: SavedFlight[],
  options: { evaPublicForm?: boolean; from?: string } = {},
): Group[] {
  if (options.evaPublicForm)
    assert.ok(
      options.from && /^2026-\d{2}-\d{2}$/.test(options.from),
      'An explicit saved-date scope is required',
    );
  const groups = new Map<string, Group>();
  for (const row of records) {
    const kind = row.kind;
    const evaForm = kind === 'collected_eva' && options.evaPublicForm;
    const url = evaForm
      ? evaScheduleURL
      : kind === 'collected_eva'
        ? row.detail?.url || row.url
        : row.evidence?.sourceUrl || row.url;
    const bucket = evaForm
      ? Math.floor(
          (Date.parse(row.date) - Date.parse(options.from!)) / (7 * 86400_000),
        )
      : 0;
    const queryDate = evaForm
      ? new Date(
          Math.min(
            Date.parse(options.from!) +
              (bucket === 0 ? 0 : bucket * 7 + 3) * 86400_000,
            Date.parse('2026-12-31'),
          ),
        )
          .toISOString()
          .slice(0, 10)
      : row.evidence?.query?.date;
    const airport = row.evidence?.query?.airport || row.airport!;
    const key = `${kind}|${url}|${evaForm || ['collected_jeju', 'collected_kix', 'collected_khh_oag'].includes(kind) ? `${queryDate}|${airport}` : ''}${row.origin === 'KHH' ? '|KHH' : ''}`;
    const group = groups.get(key) || {
      id: sha(key).slice(0, 24),
      kind,
      url,
      records: [],
      queryDate,
      airport,
    };
    group.records.push(row);
    groups.set(key, group);
  }
  // Interleave airlines so one large catalogue cannot monopolise the batch.
  const buckets = new Map<string, Group[]>();
  for (const g of groups.values())
    buckets.set(g.kind, [...(buckets.get(g.kind) || []), g]);
  const out: Group[] = [];
  while ([...buckets.values()].some((v) => v.length))
    for (const bucket of buckets.values())
      if (bucket.length) out.push(bucket.shift()!);
  return out;
}
export function assertSourceURL(value: string) {
  const url = new URL(value);
  assert.ok(
    url.protocol === 'https:' && !url.username && !url.password && !url.hash,
    'Invalid source URL',
  );
  const paths: Record<string, RegExp> = {
    'www.naha-airport.co.jp':
      /^\/common\/json\/(arrival|depart)_flight_schedule\.json$/,
    'www.hokkaido-airports.com':
      /^\/api\/v1\/new-chitose\/static\/schedule\/international\.json$/,
    'www.kia.gov.tw': /^\/data\/flightplan\.json$/,
    'www.flypeach.com':
      /^\/(en\/lm\/st\/routemap|application\/files\/\d+\/\d+\/\d+\/\d{8}_[SW]\d{2}_\d{8}-\d{8}_int_EN\.pdf)$/,
    'files.jetstar.com': /^\/api\/public\/content\/gk_jq_timetable_26n[sw]int$/,
    'www.jetstar.com': /^\/jp\/ja\/help\/flight-schedules$/,
    'www.jal.co.jp': /^\/tw\/en\/offers\/okinawa-jta\/$/,
    'booking.evaair.com':
      /^\/flyeva\/(eva\/b2c\/flight-(schedules|details)\.aspx|handler\/getairportcache\.ashx)$/i,
    'api-cms.tigerairtw.com': /^\/api\/flight-schedules\/merge$/,
    'ecapi.starlux-airlines.com': /^\/flightSchedule\/v2\/timetable$/,
    'www.jejuair.net':
      /^\/en\/prepare\/flight\/(viewScheduleInfo\.do|getFlightSchedule\.json)$/,
    'integration-middleware-website.vietnamairlines.com':
      /^\/api\/v1\/public\/flight\/schedule-table$/,
    'www.kansai-airport.or.jp': /^\/tw\/flight\/schedule$/,
    'www.philippineairlines.com':
      /^\/(ph\/en\/flight-timetable-page\.(html|model\.json)|content\/dam\/palportal\/migration\/feature\/timetable\/261009-INTL-(SUMMER-TIMETABLE-of-Oct-09-2026|WINTER-TIMETABLE-as-of-Oct-9-2026)\.pdf)$/,
  };
  assert.ok(paths[url.host]?.test(url.pathname), 'Unreviewed source endpoint');
  return url;
}
export function sourceVerifier(
  python: string,
  download: Download,
  from: string,
  initialKixBuild = '',
) {
  let kixBuild = initialKixBuild;
  const indexes = new Map<string, string>();
  const sharedDownloads = new Map<string, ResponseEvidence>();
  let evaAirports: any[] | undefined;
  async function index(url: string, id: string) {
    if (!indexes.has(url))
      indexes.set(url, (await download(url, id)).body.toString('utf8'));
    return indexes.get(url)!;
  }
  async function parse(
    mode: string,
    file: string,
    date?: string,
    airport?: string,
  ) {
    const result = await execute(
      python,
      [
        '-X',
        'utf8',
        'scripts/automatic-verification/parse-html-evidence.py',
        mode,
        file,
        ...(date ? [date] : []),
        ...(airport ? [airport] : []),
      ],
      {
        encoding: 'utf8',
        maxBuffer: 8_000_000,
        timeout: 30000,
        windowsHide: true,
      },
    );
    return JSON.parse(result.stdout);
  }
  return async function verify(group: Group): Promise<{
    rows: Observation[];
    evidence: ResponseEvidence;
    scope: 'queried' | 'saved_rows_only';
  }> {
    const r = group.records[0];
    if (group.kind === 'collected_khh_airport') {
      const evidence = await download(group.url, group.id);
      const publication = JSON.parse(evidence.body.toString('utf8'));
      assert.ok(Array.isArray(publication));
      const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
      for (const saved of group.records) {
        assert.equal(saved.origin, 'KHH');
        const matches = publication.filter(
          (row: any) =>
            row.airLineNum === saved.number &&
            row.upAirportCode === 'KHH' &&
            row.goalAirportCode === saved.airport &&
            row.weekstart <= saved.date &&
            row.weekend >= saved.date &&
            row.ScheduleStartDate <= saved.date &&
            row.ScheduleEndDate >= saved.date &&
            row[days[new Date(saved.date + 'T00:00:00Z').getUTCDay()]] ===
              'Y' &&
            row.expectDepartureTime ===
              saved.departure.slice(11, 16).replace(':', '') &&
            row.expectArrivalTime ===
              saved.arrival.slice(11, 16).replace(':', ''),
        );
        assert.ok(
          matches.length,
          'KHH official row changed or is outside the currently published weekly range; preserve selected source',
        );
      }
      return {
        rows: group.records.map(plain),
        evidence,
        scope: 'saved_rows_only',
      };
    }
    if (group.kind === 'collected_khh_oag') {
      assert.ok(group.records.every((row) => row.origin === 'KHH'));
      assert.ok(
        group.queryDate &&
          group.airport &&
          ['NRT', 'KIX', 'ICN', 'HKG', 'BKK', 'MNL', 'KUL'].includes(
            group.airport,
          ),
      );
      if (!kixBuild) {
        const html = await index(
          'https://www.kansai-airport.or.jp/tw/flight/schedule',
          'kix-index',
        );
        kixBuild =
          /name="form_build_id"[^>]*value="([^"]+)"/.exec(html)?.[1] ||
          /value="([^"]+)"[^>]*name="form_build_id"/.exec(html)?.[1] ||
          '';
        assert.ok(kixBuild, 'No public timetable form');
      }
      const evidence = await download(group.url, group.id, {
        method: 'POST',
        body: new URLSearchParams({
          from: 'KHH',
          to: group.airport,
          date: group.queryDate,
          form_id: 'schedule_flight_search_form',
          form_build_id: kixBuild,
          op: '搜尋',
        }),
      });
      const commands = JSON.parse(evidence.body.toString('utf8'));
      kixBuild =
        commands.find((c: any) => c.command === 'update_build_id')?.new ||
        kixBuild;
      const rows = await parse(
        'khh_oag',
        evidence.file,
        group.queryDate,
        group.airport,
      );
      return { rows, evidence, scope: 'queried' };
    }
    if (group.kind === 'collected_lion') {
      const evidence = await download(group.url, group.id);
      assert.ok(
        group.records.every(
          (row) =>
            row.evidence?.sourceUrl === group.url &&
            row.evidence.sha256 === sha(evidence.body),
        ),
        'Thai Lion airport publication changed; preserve records and review new dates/times before confirming',
      );
      return { rows: group.records.map(plain), evidence, scope: 'queried' };
    }
    const departureOrigin = r.origin || 'TPE';
    assert.ok(
      group.records.every((row) => (row.origin || 'TPE') === departureOrigin),
    );
    let evidence: ResponseEvidence;
    if (group.kind === 'collected_eva' && group.queryDate) {
      if (!evaAirports) {
        const catalog = await download(
          'https://booking.evaair.com/FLYEVA/handler/getAirportCache.ashx?action=01',
          'eva-airports',
        );
        const output = await execute(
          python,
          [
            '-X',
            'utf8',
            'scripts/crawler/fetch-eva-form.py',
            '--parse-airports-file',
            catalog.file,
          ],
          { encoding: 'utf8', maxBuffer: 4_000_000, windowsHide: true },
        );
        evaAirports = JSON.parse(output.stdout).airports;
      }
      const route = evaAirports!.find(
        (a) => a.value.slice(-3) === group.airport,
      );
      assert.ok(route, 'Airport not in current official public form');
      const parseForm = async (file: string) =>
        JSON.parse(
          (
            await execute(
              python,
              [
                '-X',
                'utf8',
                'scripts/crawler/fetch-eva-form.py',
                '--parse-file',
                file,
              ],
              {
                encoding: 'utf8',
                maxBuffer: 4_000_000,
                windowsHide: true,
                timeout: 20000,
              },
            )
          ).stdout,
        );
      const form = await download(
          evaScheduleURL,
          `${group.id}-form-${randomUUID()}`,
        ),
        page = await parseForm(form.file),
        bounds = page.inputs.content_txt_tbGo2YYYYMM;
      assert.ok(
        bounds?.min <= group.queryDate && bounds?.max >= group.queryDate,
        'Dates outside published source bounds',
      );
      const changes = {
        ctl00$__MasterEVENTTARGET: 'ctl00$content$btn_ok',
        ctl00$__MasterEVENTARGUMENT: '',
        ctl00$content$rbn_Segment1: 'ONE_WAY',
        ctl00$content$hid_Dep: departureOrigin + departureOrigin,
        ctl00$content$hid_Arr: route.value,
        ctl00$content$txt_formcity: departureOrigin + departureOrigin,
        ctl00$content$txt_tocity: route.value,
        ctl00$content$txt_tbGoYYYYMM: group.queryDate,
        ctl00$content$txt_tbGo2YYYYMM: group.queryDate,
      };
      assert.ok(
        page.action &&
          Object.keys(changes).every((k) => Object.hasOwn(page.fields, k)),
        'Unreviewed public form structure',
      );
      const action = new URL(page.action, evaScheduleURL).href;
      assertSourceURL(action);
      evidence = await download(action, group.id, {
        method: 'POST',
        body: new URLSearchParams({ ...page.fields, ...changes }),
        headers: { referer: evaScheduleURL },
      });
      const html = evidence.body.toString('utf8');
      assert.ok(
        /<img[^>]+src="https:\/\/booking\.evaair\.com\/flyeva\/content\/images\/b2c\/icon_rwd\/BR\.png"[^>]+alt="EVA AIR"/.test(
          html,
        ),
        'Missing current official operator legend',
      );
      const parsed = await parseForm(evidence.file),
        result = evaTableObservations(
          parsed.rows,
          group.airport!,
          from,
          '2026-12-31',
          departureOrigin,
        );
      assert.ok(
        group.records.every((r) => result.dates.includes(r.date)),
        'Returned table does not cover this group; do not infer missing flights',
      );
      return { rows: result.observations, evidence, scope: 'queried' };
    }
    if (group.kind === 'collected_philippine') {
      assert.ok(philippinePDFs.some((p) => p.url === group.url));
      const page = await index(philippinePublication, 'philippine-index');
      const model = JSON.parse(page);
      assert.equal(
        model[':path'],
        '/content/palportal/ph/en/home/flight-timetable-page',
        'Unexpected Philippine publication model',
      );
      const fragments: string[] = [];
      const collect = (node: unknown) => {
        if (typeof node === 'string') fragments.push(node);
        else if (node && typeof node === 'object')
          Object.values(node).forEach(collect);
      };
      collect(model[':items']);
      assert.ok(
        fragments.some((text) =>
          text.includes(`href="${new URL(group.url).pathname}"`),
        ),
        'Current Philippine index no longer lists the reviewed PDF; needs review',
      );
      evidence = await download(group.url, group.id);
      const proof = r.evidence!;
      assert.ok(
        group.records.every((row) => row.evidence?.sha256 === proof.sha256),
      );
      assert.equal(
        sha(await readFile(proof.file)),
        proof.sha256,
        'Saved Philippine source evidence changed',
      );
      assert.equal(
        sha(evidence.body),
        proof.sha256,
        'Philippine PDF changed; preserve schedule and review new evidence before refreshing success',
      );
      return {
        rows: group.records.map(plain),
        evidence,
        scope: 'saved_rows_only',
      };
    }
    if (['collected_peach', 'collected_jetstar'].includes(group.kind)) {
      const peach = group.kind === 'collected_peach';
      const indexUrl = peach
        ? 'https://www.flypeach.com/en/lm/st/routemap'
        : 'https://www.jetstar.com/jp/ja/help/flight-schedules';
      const page = await index(
        indexUrl,
        peach ? 'peach-index' : 'jetstar-index',
      );
      assert.ok(
        page.includes(new URL(group.url).pathname),
        'Currently published index no longer lists the saved timetable; needs source review',
      );
      evidence =
        sharedDownloads.get(group.url) || (await download(group.url, group.id));
      sharedDownloads.set(group.url, evidence);
      let expected: string;
      if (peach) {
        const receipt = await read(
          'data/source-samples/crawler/refresh-peach-1791858531093-127d3bac/sources/receipt.json',
        );
        const source = receipt.sources.find((s: any) => s.url === group.url);
        assert.ok(source, 'No verified baseline PDF');
        assert.equal(
          sha(
            await readFile(
              path.join(
                'data/source-samples/crawler/refresh-peach-1791858531093-127d3bac/sources',
                source.file,
              ),
            ),
          ),
          source.sha256,
        );
        expected = source.sha256;
      } else expected = r.evidence!.sha256;
      if (r.origin === 'KHH')
        for (const row of group.records)
          assert.equal(
            row.evidence?.sha256,
            expected,
            'Reviewed KHH PDF baseline must agree',
          );
      assert.equal(
        sha(evidence.body),
        expected,
        'Published PDF changed; replay and compare before changing verification time',
      );
      return {
        rows: group.records.map(plain),
        evidence,
        scope: 'saved_rows_only',
      };
    }
    if (group.kind === 'collected_jta') {
      evidence = await download(group.url, group.id);
      const tables = await parse('jta', evidence.file);
      const old = await read(r.evidence!.file);
      const clean = (s: string) => s.normalize('NFKC').replace(/\s+/g, '');
      const rows = tables
        .flat()
        .map((row: string[]) => row.map(clean).join('|'));
      // Both seasonal tables and their footnotes must still be present.
      for (const table of old.tables)
        for (const row of table.rows)
          assert.ok(
            rows.includes(row.map(clean).join('|')),
            'JTA published table changed or could not be parsed',
          );
      return {
        rows: group.records.map(plain),
        evidence,
        scope: 'saved_rows_only',
      };
    }
    if (group.kind === 'collected_kix') {
      if (!kixBuild) {
        const html = await index(
          'https://www.kansai-airport.or.jp/tw/flight/schedule',
          'kix-index',
        );
        kixBuild =
          /name="form_build_id"[^>]*value="([^"]+)"/.exec(html)?.[1] ||
          /value="([^"]+)"[^>]*name="form_build_id"/.exec(html)?.[1] ||
          '';
        assert.ok(kixBuild, 'No public timetable form');
      }
      assert.ok(group.queryDate && group.airport === 'KIX');
      evidence = await download(group.url, group.id, {
        method: 'POST',
        body: new URLSearchParams({
          from: 'TPE',
          to: 'KIX',
          date: group.queryDate,
          form_id: 'schedule_flight_search_form',
          form_build_id: kixBuild,
          op: '搜尋',
        }),
      });
      const commands = JSON.parse(evidence.body.toString('utf8'));
      kixBuild =
        commands.find((c: any) => c.command === 'update_build_id')?.new ||
        kixBuild;
      const parsed = await parse('kix', evidence.file, group.queryDate);
      // This source group verifies only GK50. GK54 has separate airline proof.
      return {
        rows: parsed.filter((f: any) => f.number === 'GK50'),
        evidence,
        scope: 'queried',
      };
    }
    if (group.kind === 'collected_jeju') {
      const origin = group.records[0].origin || 'TPE';
      assert.ok(
        group.records.every((r) => (r.origin || 'TPE') === origin),
        'Mixed departure airports',
      );
      if (!indexes.has('jeju-session')) {
        const bootstrap = await download(
          'https://www.jejuair.net/en/prepare/flight/viewScheduleInfo.do',
          'jeju-index',
        );
        indexes.set('jeju-session', bootstrap.file);
        // No credentials or persisted browser cookies are used.
      }
      assert.ok(group.queryDate && group.airport);
      evidence = await download(group.url, group.id, {
        method: 'POST',
        body: new URLSearchParams({
          startDate: group.queryDate.replaceAll('-', ''),
          endDate: '',
          depStn: origin,
          arrStn: group.airport,
          cultureCode: 'en-US',
        }),
        headers: { tcode: '0000000466', cname: 'PC' },
      });
      const raw = JSON.parse(evidence.body.toString('utf8'));
      assert.equal(raw.code, '0000');
      assert.ok(Array.isArray(raw.data?.dep));
      const rows: Observation[] = raw.data.dep
        .map((item: any) => {
          const d = item.designator,
            leg = item.legDetails;
          assert.equal(d.origin, origin);
          assert.equal(d.destination, group.airport);
          assert.equal(item.identifier.carrierCode, '7C');
          assert.equal(leg.codeShareIndicator, 'NonCodeShare');
          const departure = d.departure + '+08:00',
            arrival = d.arrival + '+09:00';
          assert.equal(Date.parse(departure), Date.parse(leg.departureTimeUtc));
          assert.equal(Date.parse(arrival), Date.parse(leg.arrivalTimeUtc));
          const date = departure.slice(0, 10);
          assert.ok(
            Math.abs(Date.parse(date) - Date.parse(group.queryDate!)) <=
              3 * 86400_000,
          );
          return {
            ...(origin === 'KHH' && { origin }),
            number: '7C' + item.identifier.identifier,
            date,
            airport: group.airport!,
            departure,
            arrival,
            minutes: (Date.parse(arrival) - Date.parse(departure)) / 60000,
          };
        })
        .filter((f: Observation) => f.date >= from && f.date <= '2026-12-31');
      return { rows, evidence, scope: 'queried' };
    }
    evidence =
      sharedDownloads.get(group.url) ||
      (await download(group.url, group.id, {
        headers: { 'x-language': 'zh-TW' },
      }));
    if (group.kind === 'collected_tigerair')
      sharedDownloads.set(group.url, evidence);
    if (group.kind === 'collected_tigerair') {
      const parsed = expandTigerSnapshot(
        JSON.parse(evidence.body.toString('utf8')),
        from,
        '2026-12-31',
        {},
        r.origin || 'TPE',
      );
      assert.equal(parsed.conflicts.length, 0);
      assert.equal(parsed.pending.length, 0);
      return {
        rows: parsed.flights.map((f) => ({
          ...(f.origin === 'KHH' && { origin: f.origin }),
          number: f.flightNumber,
          date: f.date,
          airport: f.destination,
          departure: wall(f.scheduledDeparture, 'Asia/Taipei'),
          arrival: wall(f.scheduledArrival, f.arrivalTimeZone),
          minutes: f.durationMinutes,
        })),
        evidence,
        scope: 'queried',
      };
    }
    if (group.kind === 'collected_starlux') {
      const url = new URL(group.url),
        date = url.searchParams.get('date')!,
        destination = url.searchParams.get('arrAirport')!;
      const parsed = parseStarluxWeek(
        JSON.parse(evidence.body.toString('utf8')),
        { date, destination, from, through: '2026-12-31' },
      );
      assert.equal(parsed.pending.length, 0);
      assert.equal(parsed.conflicts.length, 0);
      return {
        rows: parsed.flights.map((f) => ({
          number: f.publishedFlightNumber,
          date: f.date,
          airport: f.destination,
          departure: wall(f.scheduledDeparture, 'Asia/Taipei'),
          arrival: wall(f.scheduledArrival, f.arrivalTimeZone),
          minutes: f.durationMinutes,
        })),
        evidence,
        scope: 'queried',
      };
    }
    if (group.kind === 'collected_vietnam') {
      const raw = JSON.parse(evidence.body.toString('utf8'));
      const date = new URL(group.url).searchParams.get('departureDate')!;
      const rows = vietnamPublicSegments(
        raw,
        group.airport!,
        date,
        departureOrigin,
      );
      return { rows, evidence, scope: 'queried' };
    }
    if (group.kind === 'collected_eva') {
      assert.ok(
        r.detail &&
          ['NRT', 'KIX', 'BKK', 'ICN', 'SFO', 'LAX'].includes(r.airport!),
        'EVA route requires the existing expanded parser; not confirmed by this adapter',
      );
      const parsed = await parse('eva', evidence.file);
      const day = new Date(r.date),
        months = [
          'Jan',
          'Feb',
          'Mar',
          'Apr',
          'May',
          'Jun',
          'Jul',
          'Aug',
          'Sep',
          'Oct',
          'Nov',
          'Dec',
        ];
      const label = `${months[day.getUTCMonth()]}. ${day.getUTCDate()}, ${day.getUTCFullYear()}${day.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })}`;
      const entry = {
        number: r.number,
        date: r.date,
        departureTime: r.departure.slice(11, 16),
        arrival: r.airport!,
        arrivalTime: r.arrival.slice(11, 16),
        arrivalDayOffset:
          (Date.parse(r.arrival.slice(0, 10)) - Date.parse(r.date)) / 86400_000,
        marketingAirline: 'BR',
        serviceIcon: 'BR.png',
        detailLink: r.detail.url,
      };
      const checked = parseEvaDetail(
        {
          capturedAt: evidence.at,
          number: r.number,
          dateLabel: label,
          text: parsed.text,
          detailLink: r.detail.url,
        },
        entry,
      );
      return {
        rows: [
          {
            number: checked.number,
            date: r.date,
            airport: checked.arrival,
            departure: checked.departureLocal,
            arrival: checked.arrivalLocal,
            minutes: checked.durationMinutes,
          },
        ],
        evidence,
        scope: 'saved_rows_only',
      };
    }
    throw new Error('Unsupported source; preserve existing schedule');
  };
}
