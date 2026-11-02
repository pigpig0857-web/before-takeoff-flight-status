/** Offline validation step for the bounded ordinary HTTP collector. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  planEvaHttpDetails,
  observedEvaDates,
  analyzeEvaWeek,
  type EvaWeek,
  type EvaDetail,
} from '../../src/server/providers/experimental/eva-schedule';

const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1];
async function main() {
  const root = path.resolve('data/source-samples/crawler');
  const directory = path.resolve(option('--sample-dir'));
  const relative = path.relative(root, directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Invalid sample directory');
  const week = JSON.parse(
    await fs.readFile(path.join(directory, 'week.json'), 'utf8'),
  ) as EvaWeek;
  const arrival = args.includes('--arrival')
    ? option('--arrival')
    : (week.query?.arrival ?? 'NRT');
  if (
    week.query &&
    (week.query.arrival !== arrival || week.query.date !== option('--date'))
  )
    throw new Error('EVA query metadata mismatch');
  if (option('--mode') === 'window') {
    console.log(JSON.stringify(observedEvaDates(week)));
    return;
  }
  const plan = planEvaHttpDetails(
    week,
    option('--date'),
    args.includes('--all-week'),
    args.includes('--from') || args.includes('--through')
      ? { from: option('--from'), through: option('--through') }
      : undefined,
  );
  if (plan.some((e) => e.arrival !== arrival))
    throw new Error('EVA response destination mismatch');
  if (option('--mode') === 'plan') {
    console.log(JSON.stringify(plan));
    return;
  }
  const manifest = JSON.parse(
    await fs.readFile(path.join(directory, 'details-manifest.json'), 'utf8'),
  ) as (Omit<EvaDetail, 'text'> & { htmlFile: string })[];
  if (
    manifest.length !== plan.length ||
    new Set(manifest.map((d) => d.detailLink)).size !== plan.length ||
    manifest.some((d) => !plan.some((e) => e.detailLink === d.detailLink))
  )
    throw new Error('Incomplete or unrequested HTTP details');
  const details = manifest.map((item) => {
    if (!/^detail-\d+\.html$/.test(item.htmlFile))
      throw new Error('Invalid detail file');
    const parsed = JSON.parse(
      execFileSync(
        option('--python'),
        [
          'scripts/crawler/fetch-eva-form.py',
          '--parse-detail-file',
          path.join(directory, item.htmlFile),
        ],
        { encoding: 'utf8', timeout: 10_000, maxBuffer: 2_000_000 },
      ),
    ) as { detailText: string };
    return { ...item, text: parsed.detailText };
  });
  const analysis = analyzeEvaWeek(week, details);
  const report = {
    analyzedAt: new Date().toISOString(),
    scope: args.includes('--from')
      ? 'requested_range'
      : args.includes('--all-week')
        ? 'observed_week'
        : 'requested_date',
    queryDate: option('--date'),
    requestedFrom: args.includes('--from') ? option('--from') : undefined,
    requestedThrough: args.includes('--through')
      ? option('--through')
      : undefined,
    departure: 'TPE',
    arrival,
    automaticNetworkCollector: true,
    integratedIntoWebsite: false,
    observedWeekEntries: analysis.observedEntries,
    scopeEntries: plan.length,
    verifiedDetails: analysis.verifiedDetails,
    completeRequestedScope: analysis.verifiedDetails === plan.length,
    completeObservedWeek: analysis.completeObservedWeek,
    missingWeekDetails: analysis.missingDetails,
    records: analysis.records,
  };
  await fs.writeFile(
    path.join(directory, 'details.json'),
    JSON.stringify(details, null, 2),
  );
  await fs.writeFile(
    path.join(directory, 'analysis.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      scope: report.scope,
      scopeEntries: report.scopeEntries,
      verifiedDetails: report.verifiedDetails,
      completeRequestedScope: report.completeRequestedScope,
      completeObservedWeek: report.completeObservedWeek,
    }),
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
