import test from 'node:test';
import assert from 'node:assert/strict';
import { isActiveAirline } from '../src/features/flights/airline-scope';
import { getFlightDataset } from '../src/server/services/flights';
import { SOURCE_URLS } from '../src/server/providers/taoyuan';
import { taipeiDate } from '../src/lib/time';

test('Public catalogue admits integrated airline identities including CI', () => {
  assert.ok(isActiveAirline({ airlineCode: 'BR', number: 'BR0198' }));
  assert.ok(isActiveAirline({ airlineCode: 'CI', number: 'CI100' }));
  assert.equal(isActiveAirline({ airlineCode: 'BR', number: 'CI100' }), false);
  assert.ok(isActiveAirline({ airlineCode: 'MM', number: 'MM024' }));
  assert.equal(isActiveAirline({ airlineCode: 'MM', number: 'BR198' }), false);
  assert.ok(isActiveAirline({ airlineCode: 'IT', number: 'IT200' }));
  assert.ok(isActiveAirline({ airlineCode: 'JX', number: 'JX0800' }));
  assert.ok(isActiveAirline({ airlineCode: '7C', number: '7C6102' }));
  assert.ok(isActiveAirline({ airlineCode: 'VN', number: 'VN571' }));
  assert.ok(isActiveAirline({ airlineCode: 'NU', number: 'NU302' }));
  assert.ok(isActiveAirline({ airlineCode: 'GK', number: 'GK50' }));
  assert.equal(isActiveAirline({ airlineCode: '7C', number: 'VN571' }), false);
  assert.equal(isActiveAirline({ airlineCode: 'IT', number: 'JX800' }), false);
});

test('Published official and demo datasets exclude other airlines and their coverage dates', async (t) => {
  const mode = process.env.FLIGHT_DATA_MODE;
  t.after(() => {
    if (mode === undefined) delete process.env.FLIGHT_DATA_MODE;
    else process.env.FLIGHT_DATA_MODE = mode;
  });
  delete process.env.FLIGHT_DATA_MODE;
  const today = taipeiDate();
  t.mock.method(
    globalThis,
    'fetch',
    async (url: string) =>
      new Response(
        url === SOURCE_URLS.realtime
          ? `方向,航廈,航空公司代碼,班次,表訂日期,表訂時間,往來地點,航空公司中文\nD,T2,BR,9999,${today},08:00:00,NRT,長榮航空\nD,T1,CX,100,2030-01-15,10:00:00,NRT,國泰航空`
          : `飛行日期,航空公司,航班號,出發地,表訂起飛時間,目的地\n2030-01-15,CX,CX100,TPE,2030-01-15T10:00:00+08:00,NRT`,
      ),
  );
  const official = await getFlightDataset();
  assert.ok(
    official.flights.some(
      (f) => f.number === 'BR9999' && f.source === 'realtime',
    ),
  );
  assert.ok(official.flights.every(isActiveAirline));
  assert.ok(official.flights.some((f) => f.source === 'collected_tigerair'));
  assert.ok(official.flights.some((f) => f.source === 'collected_starlux'));
  assert.ok(official.flights.some((f) => f.source === 'collected_jeju'));
  assert.ok(official.flights.some((f) => f.source === 'collected_vietnam'));
  assert.ok(official.flights.some((f) => f.source === 'collected_jta'));
  assert.ok(official.flights.some((f) => f.source === 'collected_kix'));
  assert.ok(
    official.flights.some(
      (f) => f.airlineCode === 'MM' && f.source === 'collected_peach',
    ),
  );
  assert.ok(
    official.flights.every(
      (f) => f.source !== 'collected_trip',
    ),
  );
  assert.ok(
    official.feeds.every(
      (f) => f.kind !== 'collected_trip',
    ),
  );
  assert.ok(!official.dates.includes('2030-01-15'));
  assert.ok(!official.dates.includes('2027-01-15'));
  assert.ok(official.feeds.every((f) => !f.dates.includes('2030-01-15')));
  assert.deepEqual(
    official.dates,
    [...new Set(official.flights.map((f) => f.date))].sort(),
  );
  process.env.FLIGHT_DATA_MODE = 'demo';
  const demo = await getFlightDataset();
  assert.ok(demo.flights.length > 0);
  assert.ok(demo.flights.every(isActiveAirline));
  assert.equal(demo.mode, 'demo');
});
