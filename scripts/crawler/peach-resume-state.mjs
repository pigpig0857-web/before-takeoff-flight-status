const key = (r) => `${r.date}|${r.airport}|${r.number}`;
export function restorePeachProgress(schedule, completed, savedProgress) {
  const previousStatuses = new Map(savedProgress.map((r) => [key(r), r]));
  if (
    previousStatuses.size !== savedProgress.length ||
    previousStatuses.size !== schedule.length ||
    schedule.some((r) => !previousStatuses.has(key(r)))
  )
    throw new Error('Saved progress does not cover the schedule exactly');
  const compiled = new Map(completed.map((r) => [key(r), r]));
  if (compiled.size !== completed.length)
    throw new Error('Duplicate existing booking checks');
  const status = new Map(
    schedule.map((r) => [key(r), { ...previousStatuses.get(key(r)) }]),
  );
  if (
    savedProgress.filter((r) => r.state === 'verified').length !==
      compiled.size ||
    completed.some((r) => status.get(key(r))?.state !== 'verified')
  )
    throw new Error('Completed check and saved progress disagree');
  return { compiled, status };
}
export function addPeachVerifiedCheck(compiled, status, check, evidenceSha256) {
  if (compiled.has(key(check))) return false;
  if (!status.has(key(check)))
    throw new Error('Verified check outside saved schedule');
  compiled.set(key(check), { ...check, evidenceSha256 });
  status.set(key(check), {
    date: check.date,
    airport: check.airport,
    number: check.number,
    state: 'verified',
    checkedAt: check.fetchedAt,
  });
  return true;
}
