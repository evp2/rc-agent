export interface MemoryLimits {
  maxIndexLines: number;
  maxMemoryBytes: number;
}

export const MEMORY_LIMITS: MemoryLimits = { maxIndexLines: 200, maxMemoryBytes: 4096 };

export const MAX_DESCRIPTION_BYTES = 200;

const CREDENTIAL_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\b(?:password|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*["']?(?=[^\s"']*[A-Za-z])(?=[^\s"']*\d)[^\s"']{8,}/i,
  /\b(?:password|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*["']?(?=[^\s"']*[a-z])(?=[^\s"']*[A-Z])(?=[^\s"']*[^A-Za-z0-9\s"'-])[^\s"']{8,}/,
];

export function looksLikeCredential(text: string): boolean {
  return CREDENTIAL_PATTERNS.some((p) => p.test(text));
}
