import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export interface SourceStop {
  at: string;
  reason: string;
  file: string;
}
export async function readSourceStops(
  base: string,
  date: string,
): Promise<Record<string, SourceStop>> {
  try {
    return JSON.parse(
      await fs.readFile(
        path.join(base, 'source-stops', date + '.json'),
        'utf8',
      ),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
}
/** Call only while holding the existing global verification lock. Never clears an existing denial. */
export async function saveSourceStop(
  base: string,
  date: string,
  host: string,
  stop: SourceStop,
) {
  const stops = await readSourceStops(base, date);
  if (stops[host]) return;
  stops[host] = stop;
  const dir = path.join(base, 'source-stops');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, date + '.json'),
    tmp = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(stops, null, 2) + '\n', {
    flag: 'wx',
  });
  await fs.rename(tmp, file);
}
