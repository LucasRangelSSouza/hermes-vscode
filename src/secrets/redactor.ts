const secrets = new Set<string>();

/** Anything registered here is masked in every log line the extension writes. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 6) secrets.add(value);
}

export function clearSecrets(): void {
  secrets.clear();
}

export function redact(line: string): string {
  let out = line;
  for (const s of secrets) out = out.split(s).join('***');
  return out
    .replace(/(authorization["']?\s*[:=]\s*["']?bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/g, '$1***')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '***')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, 'sk-***');
}
