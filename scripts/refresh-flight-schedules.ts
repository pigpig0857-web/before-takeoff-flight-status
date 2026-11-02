import assert from 'node:assert/strict';
import { refreshSchedules } from './flight-updates/refresh';
import { taipeiDate } from '../src/lib/time';
async function main() {
  const args = process.argv.slice(2);
  const value = (name: string) =>
    args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const python = value('--python');
  assert.ok(python, '--python PATH required for official evidence replay');
  const airline = value('--airline');
  assert.ok(
    value('--resume') || ['eva', 'peach'].includes(airline || ''),
    '--airline eva|peach or --resume required',
  );
  const result = await refreshSchedules(process.cwd(), {
    python,
    airline: airline as 'eva' | 'peach' | undefined,
    from: value('--from') || taipeiDate(),
    sourceDirectory: value('--source-dir'),
    resume: value('--resume'),
    queryDate: value('--date') || '2026-12-31',
    arrival: value('--arrival') || 'NRT',
  });
  console.log(
    JSON.stringify(
      {
        workflow: result.root,
        state: result.job.state,
        step: result.job.step,
        sourceDirectory: result.job.sourceDirectory,
        updateRun: result.job.updateRun,
        originalDataUnchanged:
          result.update && 'originalDataStillPresent' in result.update
            ? result.update.originalDataStillPresent
            : result.job.filesUnchanged,
        summary: result.update?.summary,
        error: result.job.error,
      },
      null,
      2,
    ),
  );
  if (result.job.state === 'pending_confirmation') process.exitCode = 1;
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
