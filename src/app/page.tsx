import { FlightDashboard } from '@/features/flights/flight-dashboard';
import { taipeiDate } from '@/lib/time';
import { destinationCountry } from '@/features/flights/destinations';
import evaSnapshot from '@/server/data/eva-flights.json';
import peachSnapshot from '@/server/data/peach-flights.json';
import tigerairSnapshot from '@/server/data/tigerair-flights.json';
import starluxSnapshot from '@/server/data/starlux-flights.json';
import jejuSnapshot from '@/server/data/jeju-flights.json';
import vietnamSnapshot from '@/server/data/vietnam-flights.json';
import jtaSnapshot from '@/server/data/jta-flights.json';
import jetstarSnapshot from '@/server/data/jetstar-flights.json';
import philippineSnapshot from '@/server/data/philippine-flights.json';
import kaohsiungSnapshot from '@/server/data/kaohsiung-flights.json';
import khhPeach from '@/server/data/kaohsiung-peach-flights.json';
import khhJetstar from '@/server/data/kaohsiung-jetstar-flights.json';
import khhJeju from '@/server/data/kaohsiung-jeju-flights.json';
import khhEva from '@/server/data/kaohsiung-eva-flights.json';
import khhVietnam from '@/server/data/kaohsiung-vietnam-flights.json';
import lionSnapshot from '@/server/data/thai-lion-flights.json';
import khhLion from '@/server/data/kaohsiung-thai-lion-flights.json';
import khhExpanded from '@/server/data/kaohsiung-expanded-flights.json';
export const dynamic = 'force-dynamic';
export default function Page() {
  const countries = [
    ...new Set(
      [
        ...lionSnapshot.records,
        ...evaSnapshot.records,
        ...peachSnapshot.records,
        ...tigerairSnapshot.records,
        ...starluxSnapshot.records,
        ...jejuSnapshot.records,
        ...vietnamSnapshot.records,
        ...jtaSnapshot.records,
        ...jetstarSnapshot.records,
        ...philippineSnapshot.records,
      ].map((r: { countryCode: string | null }) => r.countryCode),
    ),
  ]
    .flatMap((code) => {
      const country = destinationCountry(code || "");
      return country
        ? [
            {
              code: country.code,
              name:
                code === 'HK' ? '香港' : code === 'MO' ? '澳門' : country.name,
            },
          ]
        : [];
    })
    .sort((a, b) => {
      const first = ['CN', 'HK', 'MO'];
      const rank = (code: string) => {
        const index = first.indexOf(code);
        return index < 0 ? first.length : index;
      };
      return (
        rank(a.code) - rank(b.code) || a.name.localeCompare(b.name, 'zh-TW')
      );
    });
  const khhCountries = [
    ...new Set(
      [
        kaohsiungSnapshot,
        khhPeach,
        khhJetstar,
        khhJeju,
        khhEva,
        khhVietnam,
        khhLion,
        khhExpanded,
      ].flatMap((s) => s.records.map((r: { countryCode: string | null }) => r.countryCode)),
    ),
  ]
    .flatMap((code) => {
      const c = destinationCountry(code || "");
      return c ? [{ code: c.code, name: c.name }] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-TW'));
  return (
    <FlightDashboard
      today={taipeiDate()}
      countries={countries}
      khhCountries={khhCountries}
    />
  );
}
