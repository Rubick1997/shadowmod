/** Error thrown by provider adapters for non-2xx responses. */
export class ProviderError extends Error {
  constructor(
    message: string,
    public status?: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  if (!res.ok) {
    const msg = json?.error?.message ?? (typeof json === 'string' ? json : res.statusText);
    throw new ProviderError(`${res.status} ${String(msg).slice(0, 300)}`, res.status, json);
  }
  return json;
}

export function clamp01(x: unknown): number | undefined {
  if (typeof x !== 'number' || !Number.isFinite(x)) return undefined;
  return Math.min(1, Math.max(0, x));
}
