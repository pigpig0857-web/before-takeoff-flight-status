import path from 'node:path';
import assert from 'node:assert/strict';
import {
  prepareUpdate,
  applyUpdate,
  inspectUpdate,
} from './flight-updates/store';
import { taipeiDate } from '../src/lib/time';
async function main() {
  const args = process.argv.slice(2),
    value = (key: string) => args[args.indexOf(key) + 1];
  if (args.includes('--status')) {
    console.log(
      JSON.stringify(
        await inspectUpdate(path.resolve('.'), value('--status')),
        null,
        2,
      ),
    );
    return;
  }
  if (args.includes('--apply')) {
    assert.ok(
      args.includes('--confirm') && value('--confirm'),
      '--confirm must contain the reviewed candidate SHA-256',
    );
    console.log(
      JSON.stringify(
        await applyUpdate(
          path.resolve('.'),
          value('--apply'),
          value('--confirm'),
        ),
        null,
        2,
      ),
    );
    return;
  }
  const airline = value('--airline');
  assert.ok(
    args.includes('--airline') && ['eva', 'peach'].includes(airline),
    '--airline eva|peach required',
  );
  assert.ok(
    args.includes('--candidate') && value('--candidate'),
    '--candidate required (server-ready snapshot JSON)',
  );
  console.log(
    JSON.stringify(
      await prepareUpdate(
        path.resolve('.'),
        airline as 'eva' | 'peach',
        value('--candidate'),
        args.includes('--from') ? value('--from') : taipeiDate(),
      ),
      null,
      2,
    ),
  );
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
