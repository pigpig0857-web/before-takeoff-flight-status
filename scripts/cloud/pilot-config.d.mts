export function pilotConfig(env?: Record<string, string | undefined>, now?: Date): {
  date: string;
  airports: string[];
  bucket: string;
  id: string;
  prefix: string;
  directory: string;
};
export function verifyPilotResult(receipt: unknown, analysis: unknown, airport: string, date: string): number;
