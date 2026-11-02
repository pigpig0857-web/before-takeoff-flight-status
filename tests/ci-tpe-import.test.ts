import {test} from 'node:test';
import assert from 'node:assert/strict';
import outbound from '../src/server/data/ci-tpe-flights.json';
import inbound from '../src/server/data/ci-tpe-returns.json';
import {normalizeCollected,type SavedFlight} from '../src/server/providers/collected';
import {isActiveAirline} from '../src/features/flights/airline-scope';
import {filterFlights,parseFilters} from '../src/features/flights/filter';
import {findReturnFlights} from '../src/server/services/return-flights';
test('all imported CI outbound records normalize and remain in public scope',()=>{
 assert.equal(outbound.records.length,5099);
 for(const row of outbound.records){const f=normalizeCollected(row as SavedFlight);assert(isActiveAirline(f));}
});
test('Brunei codeshares can be searched and paired with their published return',()=>{
 const flights=outbound.records.filter(r=>r.date==='2026-11-03').map(r=>normalizeCollected(r as SavedFlight));
 const found=filterFlights(flights,parseFilters(new URLSearchParams({origin:'TPE',date:'2026-11-03',q:'汶萊'}),'2026-10-27'));
 assert.equal(found.length,1);assert.equal(found[0].number,'CI9504');
 assert.equal(found[0].scheduledDeparture,'2026-11-03T14:15:00+08:00');
 const returns=findReturnFlights(new URLSearchParams({origin:'BWN',destination:'TPE',date:'2026-11-10',notBefore:found[0].scheduledArrival!}));
 assert.equal(returns.flights[0].number,'CI9503');assert.equal(returns.flights[0].departure,'2026-11-10T09:40:00+08:00');
});
test('all incoming return identities stay unique, preserve zones and exclude clock conflicts',()=>{
 assert.equal(inbound.records.length,5103);
 assert.equal(new Set(inbound.records.map(r=>[r.date,r.number,r.departureAirport,r.arrivalAirport].join('|'))).size,5103);
 for(const r of inbound.records){
  assert.equal((Date.parse(r.arrival)-Date.parse(r.departure))/60000,r.minutes);
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:r.departureTimeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(r.departure)).map(p=>[p.type,p.value]));
  assert.equal(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`,r.departure.slice(0,16));
  assert(!(r.date>='2026-10-25'&&['CI8541','CI8542'].includes(r.number)));
 }
});
