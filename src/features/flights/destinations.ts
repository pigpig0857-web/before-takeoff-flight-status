import directory from './data/airport-directory.json';
import countries from './data/countries.json';
import served from './data/taoyuan-destinations.json';
import {
  airportAliases,
  airportNames,
  cityOverrides,
  countryAliases,
} from './destination-aliases';
import type { Flight } from './types';

export interface ArrivalAirport {
  code: string;
  name: string;
  countryCode: string;
  country: string;
  city: string;
  aliases: string[];
  cityAliases: string[];
  served: boolean;
}
export interface DestinationMatch {
  kind: 'country' | 'city' | 'airport';
  label: string;
  countryCode: string | null;
  country: string | null;
  cityQuery?: string;
  airports: ArrivalAirport[];
}

export function destinationKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s／/·・.,，．()（）'-]/g, '')
    .replace(/^(?:我想要去|我要去|我想去|想要去|想去|飛到|前往|去|到)/, '');
}
const countryRecords = countries.map((country) => ({
  ...country,
  name: country.code === 'KR' ? '韓國' : country.name,
  aliases: [
    ...new Set([
      country.name,
      ...country.aliases,
      ...(countryAliases[country.code] || []),
    ]),
  ],
}));
const countryByCode = new Map(countryRecords.map((c) => [c.code, c]));
export function destinationCountry(code: string) {
  return countryByCode.get(code);
}
const servedByCode = new Map(served.map((a) => [a.code, a]));
const airports: ArrivalAirport[] = directory.map((entry) => {
  const source = servedByCode.get(entry.code);
  const override = cityOverrides[entry.code];
  const city =
    override?.city ||
    source?.city.split(/[／/]/)[0] ||
    entry.municipality ||
    entry.name;
  const cityAliases = [
    city,
    ...(override?.aliases || []),
    entry.municipality,
    source?.city.split(/[／/]/)[0] || '',
    source?.english.split(/[／/]/)[0] || '',
  ].filter(Boolean);
  const country =
    countryByCode.get(entry.countryCode)?.name || entry.countryCode;
  return {
    code: entry.code,
    name: airportNames[entry.code] || entry.name,
    countryCode: entry.countryCode,
    country,
    city,
    cityAliases,
    served: Boolean(source),
    // A city's bare name must never narrow a multi-airport search to one airport.
    aliases: [
      entry.code,
      entry.name,
      airportNames[entry.code] || '',
      ...(airportAliases[entry.code] || []),
      ...(source && /[／/]/.test(source.city) ? [source.city] : []),
    ].filter(Boolean),
  };
});
const byCode = new Map(airports.map((airport) => [airport.code, airport]));
const airportKeys = new Map<string, ArrivalAirport>();
const cityKeys = new Map<string, ArrivalAirport[]>();
const countryKeys = new Map<string, (typeof countryRecords)[number]>();
for (const country of countryRecords)
  for (const alias of country.aliases)
    countryKeys.set(destinationKey(alias), country);
for (const airport of airports) {
  for (const alias of airport.aliases)
    airportKeys.set(destinationKey(alias), airport);
  for (const alias of airport.cityAliases) {
    const key = destinationKey(alias);
    const group = cityKeys.get(key) || [];
    if (!group.includes(airport)) group.push(airport);
    cityKeys.set(key, group);
  }
}
const countryPrefixes = [...countryKeys.keys()].sort(
  (a, b) => b.length - a.length,
);

function resolvePlace(
  key: string,
  countryCode: string | null,
): DestinationMatch | null {
  const airport = airportKeys.get(key);
  if (airport && (!countryCode || airport.countryCode === countryCode)) {
    return {
      kind: 'airport',
      label: airport.city,
      countryCode: airport.countryCode,
      country: airport.country,
      airports: [airport],
    };
  }
  let group = (cityKeys.get(key) || []).filter(
    (a) => !countryCode || a.countryCode === countryCode,
  );
  if (group.length) {
    // Prefer the country served from TPE when a city name occurs in multiple countries.
    const tpeCountries = new Set(
      group.filter((a) => a.served).map((a) => a.countryCode),
    );
    if (!countryCode && tpeCountries.size === 1)
      group = group.filter((a) => tpeCountries.has(a.countryCode));
    const preferred = group.find((a) => a.served) || group[0];
    const countryCodes = new Set(group.map((a) => a.countryCode));
    return {
      kind: 'city',
      label: preferred.city,
      countryCode: countryCodes.size === 1 ? preferred.countryCode : null,
      country: countryCodes.size === 1 ? preferred.country : null,
      airports: group,
    };
  }
  // Recognize city + airport; never interpret multiple unrelated cities as OR.
  for (const [alias, candidate] of airportKeys) {
    if (
      !alias ||
      !key.endsWith(alias) ||
      (countryCode && candidate.countryCode !== countryCode)
    )
      continue;
    const cityPart = key.slice(0, -alias.length);
    if (
      cityPart &&
      candidate.cityAliases.some((city) => destinationKey(city) === cityPart)
    ) {
      return {
        kind: 'airport',
        label: candidate.city,
        countryCode: candidate.countryCode,
        country: candidate.country,
        airports: [candidate],
      };
    }
  }
  return null;
}

export function resolveDestination(query: string): DestinationMatch | null {
  const key = destinationKey(query);
  if (!key) return null;
  const country = countryKeys.get(key);
  if (country)
    return {
      kind: 'country',
      label: country.name,
      countryCode: country.code,
      country: country.name,
      airports: [],
    };
  const direct = resolvePlace(key, null);
  if (direct) return direct;
  for (const alias of countryPrefixes) {
    if (key.startsWith(alias) || key.endsWith(alias)) {
      const country = countryKeys.get(alias)!;
      const remainder = key.startsWith(alias)
        ? key.slice(alias.length)
        : key.slice(0, -alias.length);
      if (!remainder) continue;
      const place = resolvePlace(remainder, country.code);
      if (place) return place;
      // New routes can use local city names from the official feed immediately.
      return {
        kind: 'city',
        label: remainder,
        countryCode: country.code,
        country: country.name,
        cityQuery: remainder,
        airports: [],
      };
    }
  }
  return null;
}

export function matchesDestination(
  flight: Flight,
  match: DestinationMatch,
): boolean {
  const airport = arrivalAirport(flight.destinationCode);
  if (!airport && flight.collected) {
    const country = flight.collected.countryCode;
    if (match.kind === 'country') return country === match.countryCode;
    // A city-only PDF observation must never claim a specific airport match.
    if (match.kind === 'airport') return false;
    if (match.countryCode && country !== match.countryCode) return false;
    const names = [flight.destination, flight.destinationEnglish].map(
      destinationKey,
    );
    return (
      names.includes(destinationKey(match.label)) ||
      Boolean(
        match.cityQuery &&
        names.some((name) => name.includes(match.cityQuery!)),
      )
    );
  }
  if (match.kind === 'country')
    return airport?.countryCode === match.countryCode;
  if (match.airports.length)
    return match.airports.some(
      (a) => a.code === flight.destinationCode.toUpperCase(),
    );
  return Boolean(
    airport &&
    airport.countryCode === match.countryCode &&
    match.cityQuery &&
    [flight.destination, flight.destinationEnglish, airport.city].some(
      (value) => destinationKey(value).includes(match.cityQuery!),
    ),
  );
}
export function arrivalAirport(code: string): ArrivalAirport | undefined {
  return byCode.get(code.toUpperCase());
}
export function arrivalCity(code: string): string | undefined {
  const airport = arrivalAirport(code);
  return airport && (airport.served || cityOverrides[airport.code])
    ? airport.city
    : undefined;
}
export const taoyuanAirports = served.map((airport) =>
  byCode.get(airport.code)!,
);
