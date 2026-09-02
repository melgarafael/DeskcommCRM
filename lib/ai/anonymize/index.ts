/**
 * PT-BR PII anonymizer for the conversations RAG ingestion pipeline (S-06.07).
 *
 * Replaces, in order:
 *   1. NUIT       -> [NUIT]
 *   2. Email     -> [EMAIL]
 *   3. Telefone  -> [TELEFONE]
 *   4. CEP       -> [CEP]
 *   5. Nomes PT-BR (lookup) -> [NOME]
 *
 * NUIT runs before CEP because both share the digit-dash shape.
 *
 * Returns the anonymized string AND the list of hits (used by the ingestor's
 * ">=10 messages, 0 hits -> flag for manual review" guard).
 */

import { FIRST_NAMES_PT_BR } from "./pt-br-first-names";

/**
 * Build fresh regex instances per call. The `g` flag carries `lastIndex`
 * across `.test()` calls and would silently corrupt the leak guard.
 */
export function buildPiiPatterns(): Record<string, RegExp> {
  return {
    nuit: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g,
    email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    phone: /\b\(?\d{2}\)?\s*9?\d{4,5}-?\d{4}\b/g,
    cep: /\b\d{5}-?\d{3}\b/g,
  };
}

export const PII_PATTERNS = buildPiiPatterns();

export interface AnonymizeHit {
  type: "nuit" | "email" | "phone" | "cep" | "name";
  original: string;
  replacement: string;
}

export interface AnonymizeResult {
  anonymized: string;
  hits: AnonymizeHit[];
}

const REPLACEMENT_BY_TYPE: Record<AnonymizeHit["type"], string> = {
  nuit: "[NUIT]",
  email: "[EMAIL]",
  phone: "[TELEFONE]",
  cep: "[CEP]",
  name: "[NOME]",
};

export function anonymize(text: string): AnonymizeResult {
  const hits: AnonymizeHit[] = [];
  let out = text;

  const passes: { type: AnonymizeHit["type"]; pattern: RegExp }[] = [
    { type: "nuit", pattern: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g },
    { type: "email", pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
    { type: "phone", pattern: /\b\(?\d{2}\)?\s*9?\d{4,5}-?\d{4}\b/g },
    { type: "cep", pattern: /\b\d{5}-?\d{3}\b/g },
  ];

  for (const { type, pattern } of passes) {
    const replacement = REPLACEMENT_BY_TYPE[type];
    out = out.replace(pattern, (match) => {
      hits.push({ type, original: match, replacement });
      return replacement;
    });
  }

  // Name pass: tokenize on Unicode letters; replace tokens whose lowercase
  // form is in the curated PT-BR set.
  const nameRe = /\b[\p{L}]+\b/gu;
  out = out.replace(nameRe, (match) => {
    const lower = match.toLowerCase();
    if (FIRST_NAMES_PT_BR.has(lower)) {
      hits.push({ type: "name", original: match, replacement: "[NOME]" });
      return "[NOME]";
    }
    return match;
  });

  return { anonymized: out, hits };
}

/**
 * Final guard: scans `text` with a fresh pattern instance for each PII type
 * and returns the first matching type, or null when clean.
 */
export function detectResidualPii(text: string): AnonymizeHit["type"] | null {
  const patterns = buildPiiPatterns();
  for (const [type, pattern] of Object.entries(patterns)) {
    if (pattern.test(text)) {
      return type as AnonymizeHit["type"];
    }
  }
  return null;
}
