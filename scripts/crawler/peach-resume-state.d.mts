export interface PeachIdentity {
  date: string;
  airport: string;
  number: string;
}
export interface PeachVerifiedCheck extends PeachIdentity {
  aircraft: string;
  fetchedAt: string;
  evidenceSha256?: string;
  [field: string]: unknown;
}
export interface PeachProgressRecord extends PeachIdentity {
  state: string;
  checkedAt?: string;
  reason?: string;
  [field: string]: unknown;
}
export function restorePeachProgress(
  schedule: PeachIdentity[],
  completed: PeachVerifiedCheck[],
  savedProgress: PeachProgressRecord[],
): {
  compiled: Map<string, PeachVerifiedCheck>;
  status: Map<string, PeachProgressRecord>;
};
export function addPeachVerifiedCheck(
  compiled: Map<string, PeachVerifiedCheck>,
  status: Map<string, PeachProgressRecord>,
  check: PeachVerifiedCheck,
  evidenceSha256: string,
): boolean;
