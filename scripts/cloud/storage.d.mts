export class Storage {
  constructor(bucket: string);
  headers(): Promise<{ Authorization: string }>;
  put(name: string, body: BodyInit, type?: string): Promise<{ generation: string }>;
  release(name: string, generation: string): Promise<void>;
}
