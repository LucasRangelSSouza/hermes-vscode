import { normalizeBaseUrl } from './profile';
import type { ProviderProfile } from './profile';

export interface StepResult {
  name: 'reach' | 'auth' | 'model' | 'inference';
  ok: boolean;
  detail: string;
}

export interface ConnectionResult {
  ok: boolean;
  steps: StepResult[];
  hint?: string;
}

export interface ConnectionOptions {
  fetchImpl?: typeof fetch;
}

function redact(text: string, secret: string | undefined): string {
  let out = text;
  if (secret) out = out.split(secret).join('***');
  return out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***').replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***');
}

function classifyNetworkError(err: unknown): { detail: string; hint?: string } {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = e?.cause?.code ?? '';
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return { detail: 'The request timed out.', hint: 'Check the base URL and your network, or raise the timeout in the profile.' };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { detail: 'The host name could not be resolved (DNS).', hint: 'Check the base URL for typos and that this machine can reach it.' };
  }
  if (code === 'ECONNREFUSED') {
    return { detail: 'The connection was refused.', hint: 'Nothing is listening at that address and port.' };
  }
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ISSUER/i.test(code) || /certificate/i.test(e?.cause?.message ?? e?.message ?? '')) {
    return {
      detail: 'The TLS certificate was not trusted.',
      hint: 'A corporate network that inspects HTTPS can cause this. Ask IT for the root certificate, or use a URL your machine trusts.',
    };
  }
  return { detail: `The request failed: ${e?.cause?.message ?? e?.message ?? String(err)}` };
}

async function errorBody(res: Response, apiKey: string | undefined): Promise<string> {
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
      const m = typeof j.error === 'string' ? j.error : j.error?.message ?? j.message;
      if (m) return redact(String(m), apiKey).slice(0, 240);
    } catch { /* not JSON */ }
    return redact(text, apiKey).slice(0, 240);
  } catch {
    return '';
  }
}

/**
 * Runs in the extension host, not through Hermes, so a failure can be explained precisely:
 * reach, auth, model, then one small inference.
 */
export async function testConnection(
  profile: ProviderProfile,
  apiKey: string | undefined,
  opts: ConnectionOptions = {},
): Promise<ConnectionResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = normalizeBaseUrl(profile.baseUrl);
  const timeoutMs = Math.max(5, profile.timeoutSeconds || 60) * 1000;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const steps: StepResult[] = [];

  let models: string[] | null = null;
  try {
    const res = await fetchImpl(`${base}/models`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 401 || res.status === 403) {
      steps.push({ name: 'reach', ok: true, detail: `Reached ${new URL(base).host}.` });
      steps.push({ name: 'auth', ok: false, detail: `The provider returned HTTP ${res.status}.` });
      return { ok: false, steps, hint: `Check the API key configured for "${profile.name}".` };
    }
    if (res.status === 404 || res.status === 405) {
      steps.push({ name: 'reach', ok: true, detail: `Reached ${new URL(base).host} (no /models listing).` });
      steps.push({ name: 'auth', ok: true, detail: 'Authentication is checked by the inference request.' });
    } else if (res.ok) {
      steps.push({ name: 'reach', ok: true, detail: `Reached ${new URL(base).host}.` });
      steps.push({ name: 'auth', ok: true, detail: 'The API key was accepted.' });
      try {
        const body = await res.json() as { data?: Array<{ id?: string }> };
        models = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
      } catch { models = null; }
    } else {
      steps.push({ name: 'reach', ok: false, detail: `The provider returned HTTP ${res.status}. ${await errorBody(res, apiKey)}`.trim() });
      return { ok: false, steps };
    }
  } catch (err) {
    const c = classifyNetworkError(err);
    steps.push({ name: 'reach', ok: false, detail: c.detail });
    return { ok: false, steps, hint: c.hint };
  }

  if (models && models.length > 0) {
    if (models.includes(profile.model)) {
      steps.push({ name: 'model', ok: true, detail: `Model ${profile.model} is available.` });
    } else {
      steps.push({ name: 'model', ok: false, detail: `Model ${profile.model} is not in the provider's list.` });
      return { ok: false, steps, hint: `Available models include: ${models.slice(0, 8).join(', ')}.` };
    }
  } else {
    steps.push({ name: 'model', ok: true, detail: 'The provider does not list models; checked by inference.' });
  }

  try {
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ model: profile.model, messages: [{ role: 'user', content: 'Reply with the single word OK.' }], max_tokens: 8, stream: false }),
    });
    if (!res.ok) {
      const detail = await errorBody(res, apiKey);
      steps.push({ name: 'inference', ok: false, detail: `HTTP ${res.status}${detail ? `: ${detail}` : ''}` });
      return {
        ok: false,
        steps,
        hint: res.status === 401 || res.status === 403 ? `Check the API key configured for "${profile.name}".` : res.status === 429 ? 'The provider is rate limiting requests. Try again shortly.' : undefined,
      };
    }
    const body = await res.json() as { choices?: unknown[] };
    if (!Array.isArray(body.choices) || body.choices.length === 0) {
      steps.push({ name: 'inference', ok: false, detail: 'The response had no completion.' });
      return { ok: false, steps };
    }
    steps.push({ name: 'inference', ok: true, detail: 'A test completion succeeded.' });
    return { ok: true, steps };
  } catch (err) {
    const c = classifyNetworkError(err);
    steps.push({ name: 'inference', ok: false, detail: c.detail });
    return { ok: false, steps, hint: c.hint };
  }
}

export function summarize(result: ConnectionResult): string {
  return result.steps.map((s) => `${s.ok ? 'OK ' : 'FAIL'}  ${s.name}: ${s.detail}`).join('\n') + (result.hint ? `\n${result.hint}` : '');
}
