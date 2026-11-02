import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const base = 'data/source-samples/crawler/ci-tpe-20261021';
const dir = `${base}/recheck-20261027`;
const read = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const identity = r => [r.date,r.number,r.origin,r.destination].join('|');
const report = read(`${dir}/dated-audit.json`);
assert.equal(hash(`${base}/consolidated-candidates.json`), report.baselineSha256);
const rows = read(`${dir}/confirmed-ci-extension.json`).records;
assert.equal(new Set(rows.map(identity)).size, rows.length);
for (const r of rows) {
  assert.equal(r.marketingCarrier, 'CI');
  assert.equal(r.requiresReview, false);
  assert(r.date >= '2026-10-21' && r.date <= '2026-12-31');
  assert([r.origin,r.destination].includes('TPE'));
  assert.equal((Date.parse(r.arrival)-Date.parse(r.departure))/60000, r.minutes);
  assert.equal(hash(r.evidence.file), r.evidence.sha256);
  if (r.codeshare) assert(r.operatingNumber.startsWith(r.operatingCarrier));
  if (r.confirmation) assert.equal(hash(r.confirmation.evidence), r.confirmation.evidenceSha256);
}
const conflicts = read(`${dir}/unresolved-clock-conflicts.json`);
assert.equal(conflicts.length,18);
assert(conflicts.every(r => r.status === 'official_sources_clock_conflict' && !r.overwriteExisting));
for (const r of conflicts) {
  assert.equal(identity(r.pdf),identity(r.datedOfficialTable));
  assert.notEqual(r.pdf.departure,r.datedOfficialTable.departure);
}
const receipts = fs.readdirSync(`${dir}/browser`).filter(n=>n.endsWith('.receipt.json'));
assert.equal(receipts.length,27);
for (const name of receipts) {
  const r=read(`${dir}/browser/${name}`);
  assert.equal(hash(`${dir}/browser/${name.replace('.receipt.json','.ax.txt')}`),r.sha256);
}
const result={passed:true,checkedAt:new Date().toISOString(),acceptedCIObservations:rows.length,
  weeklyEvidenceFiles:27,sourceClockConflicts:18,baselineUnchanged:true,websiteImportPerformed:false};
fs.writeFileSync(`${dir}/independent-audit.json`,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
