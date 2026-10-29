/** Secret patterns scrubbed before anything is written to the ledger (ARCHITECTURE §13.2). */
const RULES: { name: string; re: RegExp }[] = [
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g },
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'connection-string', re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi },
  { name: 'secret-assignment', re: /\b(password|passwd|secret|api[_-]?key|token|access[_-]?key)\s*[:=]\s*["']?(?!\[REDACTED)[^\s"']{8,}/gi },
];

export interface Redaction {
  text: string;
  hits: string[];
}

export function redact(text: string): Redaction {
  const hits: string[] = [];
  let out = text;
  for (const { name, re } of RULES) {
    out = out.replace(re, (m, label?: string) => {
      hits.push(name);
      return name === 'secret-assignment' && typeof label === 'string' ? `${label}=[REDACTED:${name}]` : `[REDACTED:${name}]`;
    });
  }
  return { text: out, hits };
}
