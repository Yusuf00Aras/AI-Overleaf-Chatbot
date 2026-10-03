export const HOSTED_URL = 'https://www.overleaf.com';

/** Accepts a bare 24-hex project ID or an Overleaf project link. */
export function parseProjectId(value: string): string | undefined {
  const trimmed = value.trim();
  if (/^[a-f0-9]{24}$/i.test(trimmed)) return trimmed.toLowerCase();
  return /\/project\/([a-f0-9]{24})(?:[/?#]|$)/i.exec(trimmed)?.[1]?.toLowerCase();
}
