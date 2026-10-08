/**
 * O anonimizador de dado pessoal da conversa que vai para o RAG (S-06.07) —
 * agora dirigido pelo PERFIL DO PAÍS da organização (issue #1033).
 *
 * ─── o defeito, medido ─────────────────────────────────────────────────────
 *
 * O que existia aqui era um conjunto FIXO de quatro padrões, todos brasileiros.
 * Rodando aquelas regex em `origin/main` `491a726a3`:
 *
 *     "003862011LA042" -> "003862011LA042"   ← documento estrangeiro, INTACTO
 *     "541712345"      -> "541712345"        ← idem
 *     "52998224725"    -> "[cpf]"            ← controle: o CPF é pego
 *
 * Ou seja: fora do Brasil, o documento do titular ia inteiro para o modelo —
 * e a guarda de falso-negativo (`hits.length === 0` em
 * `lib/ai/rag/ingest/conversations.ts`) se calava justamente quando o telefone
 * dava um hit e o documento passava junto.
 *
 * ─── o que esta peça entrega, e o que NÃO entrega ──────────────────────────
 *
 * Entrega a COSTURA: os padrões do documento passam a vir do perfil
 * (`lib/legal/perfil-do-pais.ts`), com rótulo próprio por tipo, e a guarda de
 * vazamento passa a olhar o mesmo perfil (por isso `detectResidualPii` também
 * recebe os padrões). E-mail e telefone continuam aqui, porque não são de país
 * nenhum.
 *
 * NÃO entrega o padrão de nenhum país novo: cada padrão exige a sua régua
 * escrita (o que cobre, o que NÃO cobre, e a prova de que não redige número de
 * pedido à toa). O padrão do documento angolano, citado na issue, pertence ao
 * recorte do #928 — está escrito lá, e o que faltava para ele era exatamente
 * isto: um lugar declarativo por país e um consumidor que o respeite.
 *
 * ─── ordem das passadas ────────────────────────────────────────────────────
 *
 * Os padrões do PAÍS vêm antes dos universais, e a razão é a mesma anotada
 * antes: documento e código postal compartilham a forma de dígitos com hífen, e
 * quem tem que pegar primeiro é o documento (o CPF antes do CEP). O rótulo de
 * cada tipo vem do perfil — `[CPF]`, `[BI]`, o que o país declarar.
 */

import { perfilDoPais, type PadraoDePiiDoPais, type PerfilDoPais } from "@/lib/legal/perfil-do-pais";

import { FIRST_NAMES_PT_BR } from "./pt-br-first-names";

/**
 * Os padrões que não são de país nenhum: e-mail e telefone existem em qualquer
 * idioma e não dependem de lei local.
 */
const PADROES_UNIVERSAIS: readonly PadraoDePiiDoPais[] = [
  {
    tipo: "email",
    marcador: "[EMAIL]",
    fonte: "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}",
    naoCobre: "e-mail quebrado por espaço ou com o arroba escrito por extenso",
  },
  {
    tipo: "phone",
    marcador: "[TELEFONE]",
    fonte: "\\b\\(?\\d{2}\\)?\\s*9?\\d{4,5}-?\\d{4}\\b",
    naoCobre: "número em formato internacional com `+` e DDI, e fixo com mais de 8 dígitos após o DDD",
  },
];

/**
 * A lista efetiva de padrões: os do país primeiro, os universais depois.
 *
 * Sem `perfis`, vale o perfil PADRÃO (Brasil) — é o comportamento de antes
 * desta mudança, e é o que atende quem nunca escolheu país nenhum.
 */
export function padroesDePii(perfis?: readonly PerfilDoPais[]): PadraoDePiiDoPais[] {
  const lista = perfis && perfis.length > 0 ? perfis : [perfilDoPais(null)];
  const vistos = new Set<string>();
  const saida: PadraoDePiiDoPais[] = [];
  for (const padrao of [...lista.flatMap((p) => p.padroesDePii), ...PADROES_UNIVERSAIS]) {
    if (vistos.has(padrao.tipo)) continue;
    vistos.add(padrao.tipo);
    saida.push(padrao);
  }
  return saida;
}

/**
 * A máscara da INGESTÃO para o RAG: os padrões do país da organização e, por
 * baixo, os do Brasil. Uma organização que troca de BR para PT continua tendo
 * cliente brasileiro na conversa — sem o Brasil por baixo, CPF formatado e CEP
 * passariam intactos para o índice (medido no doc 88). Para o Brasil não muda
 * nada: `padroesDePii` deduplica por `tipo`.
 */
export function padroesDaIngestao(perfil: PerfilDoPais): PadraoDePiiDoPais[] {
  return padroesDePii([perfil, perfilDoPais(null)]);
}

/**
 * Build fresh regex instances per call. The `g` flag carries `lastIndex`
 * across `.test()` calls and would silently corrupt the leak guard.
 */
export function buildPiiPatterns(
  padroes: readonly PadraoDePiiDoPais[] = padroesDePii(),
): Record<string, RegExp> {
  const mapa: Record<string, RegExp> = {};
  for (const padrao of padroes) mapa[padrao.tipo] = new RegExp(padrao.fonte, "g");
  return mapa;
}

/** Os padrões brasileiros, como antes: quem os lê não precisa saber do perfil. */
export const PII_PATTERNS = buildPiiPatterns();

export interface AnonymizeHit {
  /**
   * O tipo do dado, pelo perfil do país: `cpf`, `cep`, `email`, `phone` — e o
   * que o país declarar (`bi`, `nif`, …). Deixou de ser união fechada porque a
   * lista de países não cabe no tipo de uma função pura.
   */
  type: string;
  original: string;
  replacement: string;
}

export interface AnonymizeResult {
  anonymized: string;
  hits: AnonymizeHit[];
}

export function anonymize(
  text: string,
  padroes: readonly PadraoDePiiDoPais[] = padroesDePii(),
): AnonymizeResult {
  const hits: AnonymizeHit[] = [];
  let out = text;

  for (const padrao of padroes) {
    out = out.replace(new RegExp(padrao.fonte, "g"), (match) => {
      hits.push({ type: padrao.tipo, original: match, replacement: padrao.marcador });
      return padrao.marcador;
    });
  }

  // Name pass: tokenize on Unicode letters; replace tokens whose lowercase
  // form is in the curated PT-BR set. (Lista de nomes: é o único padrão que
  // continua global e PT-BR de propósito — país não muda o que é nome próprio,
  // e ampliar a lista por país é trabalho de outra issue.)
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
 * and returns the first matching type, or null when clean. Recebe o MESMO
 * conjunto que anonimizou — uma guarda que olhasse uma lista fixa acusaria
 * conversa limpa (ou deixaria passar) no país cujo padrão ela não conhece.
 */
export function detectResidualPii(
  text: string,
  padroes: readonly PadraoDePiiDoPais[] = padroesDePii(),
): string | null {
  const patterns = buildPiiPatterns(padroes);
  for (const [type, pattern] of Object.entries(patterns)) {
    if (pattern.test(text)) return type;
  }
  return null;
}
