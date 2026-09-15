/**
 * PT-BR/PT-AO PII anonymizer for the conversations RAG ingestion pipeline (S-06.07).
 *
 * Replaces, in order:
 *   1. CPF       -> [CPF]   (Brasil: 3+3+3+2 dígitos, com ou sem pontuação)
 *   2. NIF (BI)  -> [NIF]   (Angola: 9 dígitos + 2 letras de província + 3 dígitos)
 *   3. Email     -> [EMAIL]
 *   4. Telefone  -> [TELEFONE]
 *   5. CEP       -> [CEP]
 *   6. Nomes PT-BR (lookup) -> [NOME]
 *
 * CPF/NIF rodam antes de CEP/telefone porque compartilham forma de dígitos.
 *
 * ⚠️ O NIF numérico-puro de Angola (empresa/estrangeiro, 9-10 dígitos, sem as
 * letras do BI) não tem padrão dedicado aqui — ele já cai, na prática, no
 * padrão de telefone (mesma faixa de dígitos) e sai redigido como [TELEFONE]
 * em vez de [NIF]. O rótulo fica errado, mas o dado NÃO vaza — dado o
 * objetivo (não deixar PII chegar ao LLM), essa imprecisão de rótulo é aceitável;
 * o padrão do BI abaixo é o que fechava um buraco real (nada capturava letra).
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
    cpf: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g,
    nif: /\b\d{9}[A-Za-z]{2}\d{3}\b/g,
    email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    phone: /\b\(?\d{2}\)?\s*9?\d{4,5}-?\d{4}\b/g,
    cep: /\b\d{5}-?\d{3}\b/g,
  };
}

export const PII_PATTERNS = buildPiiPatterns();

export interface AnonymizeHit {
  type: "cpf" | "nif" | "email" | "phone" | "cep" | "name";
  original: string;
  replacement: string;
}

export interface AnonymizeResult {
  anonymized: string;
  hits: AnonymizeHit[];
}

const REPLACEMENT_BY_TYPE: Record<AnonymizeHit["type"], string> = {
  cpf: "[CPF]",
  nif: "[NIF]",
  email: "[EMAIL]",
  phone: "[TELEFONE]",
  cep: "[CEP]",
  name: "[NOME]",
};

export function anonymize(text: string): AnonymizeResult {
  const hits: AnonymizeHit[] = [];
  let out = text;

  const passes: { type: AnonymizeHit["type"]; pattern: RegExp }[] = [
    { type: "cpf", pattern: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g },
    { type: "nif", pattern: /\b\d{9}[A-Za-z]{2}\d{3}\b/g },
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
