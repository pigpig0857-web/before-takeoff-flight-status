// Uses the job's service identity. No downloaded service-account keys.
export class Storage {
  constructor(bucket) {
    this.bucket = bucket;
  }
  async headers() {
    if (!this.token || Date.now() > this.expiresAt) {
      const response = await fetch(
        'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        {
          headers: { 'Metadata-Flavor': 'Google' },
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!response.ok)
        throw Error(`Service identity unavailable: HTTP ${response.status}`);
      const token = await response.json();
      if (!token.access_token) throw Error('Missing service identity token');
      this.token = token.access_token;
      this.expiresAt = Date.now() + (token.expires_in - 60) * 1000;
    }
    return { Authorization: `Bearer ${this.token}` };
  }
  async put(name, body, type = 'application/json') {
    const url = new URL(
      `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o`,
    );
    url.search = new URLSearchParams({
      uploadType: 'media',
      name,
      ifGenerationMatch: '0',
    }).toString();
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...(await this.headers()), 'Content-Type': type },
      body,
      signal: AbortSignal.timeout(90000),
    });
    if (!response.ok)
      throw Error(`Storage write failed: HTTP ${response.status}`);
    return response.json();
  }
  async release(name, generation) {
    const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(name)}?ifGenerationMatch=${generation}`;
    const response = await fetch(url, {
      method: 'DELETE',
      headers: await this.headers(),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok)
      throw Error(`Lock release failed: HTTP ${response.status}`);
  }
}
