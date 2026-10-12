/**
 * Tabela de preços versionada (stack.md §2: usage × pricing.ts → llm_calls.cost_cents).
 * ÚNICO lugar com preço de modelo no repo.
 *
 * Fontes: https://platform.claude.com/docs/en/about-claude/pricing (Anthropic) e
 * https://developers.openai.com/api/docs/pricing (OpenAI, tabela Standard, conferida em
 * 23/09/2026). Google: entrada/saída do `ai_pricing` do catálogo curado; leitura de cache de
 * https://ai.google.dev/gemini-api/docs/pricing, conferida em 02/10/2026 (ver o bloco Gemini).
 * Cache da Anthropic: leitura = 0.1× a entrada; gravação = 1.25× no TTL de 5 minutos e 2× no de
 * 1 hora — os dois TTLs que o knob `LLM_CACHE_TTL` aceita (`lib/agent-engine/env.ts`),
 * e é por isso que `costCents` recebe o TTL em vigor em vez de supor a doutrina.
 *
 * Modelo fora da tabela → custo NULL (desconhecido): mais honesto que inventar 0 —
 * o budget soma coalesce(cost_cents, 0), então modelo sem preço não consome teto;
 * quem habilitar um modelo novo para uma org adiciona a linha de preço aqui.
 *
 * TRÊS armadilhas já pagas, e as três são do MESMO defeito — a tabela ficou na
 * geração 4 enquanto o catálogo (`ai_models`, migration 0101) andou:
 *
 *   1. A geração 5 (`claude-sonnet-5`, o padrão de atendimento, e `claude-opus-5`)
 *      não tinha linha. Custo NULL numa instalação real: a tela Uso e orçamento
 *      mostrava gasto zero e o teto mensal nunca disparava — medido numa VPS com
 *      28 chamadas reais, todas com `cost_cents` nulo.
 *   2. O antigo match por `startsWith` fazia `claude-opus-4` casar com
 *      `claude-opus-4-5` em diante e cobrar o preço do Opus 4/4.1 (aposentados,
 *      US$ 15/75) por um modelo que custa US$ 5/25 — 3× a mais, com o sinal
 *      invertido do defeito 1: aqui o teto disparava cedo demais.
 *   3. O mesmo `startsWith` daria preço a um id FUTURO que apenas começasse igual
 *      (`claude-sonnet-50`, `claude-opus-4-9`) — e custo errado não-nulo é pior
 *      que custo desconhecido, porque não acende o sinal de gasto incompleto.
 *
 * Por isso o match é EXATO, com duas tolerâncias: o sufixo de data do vendor
 * (`claude-opus-4-1-20250805`) e o prefixo `provider/` do OpenRouter
 * (`anthropic/claude-sonnet-5`) — este último recortado até a primeira barra,
 * na mesma ordem da tolerância do sufixo, para um id com prefixo+sufixo também
 * casar (issue #1880). Id que a tabela não conhece volta NULL, que é o
 * contrato escrito acima.
 */

import type { CacheTtl } from './stable-prefix';

interface Preco {
  input: number;
  output: number;
  cacheRead: number;
  /** 1.25× a entrada — TTL de 5 minutos. */
  cacheWrite5m: number;
  /** 2× a entrada — TTL de 1 hora, a doutrina de caching (CLAUDE.md regra 15). */
  cacheWrite1h: number;
}

/** USD por MILHÃO de tokens, por id EXATO de modelo (o sufixo de data é tolerado). */
const USD_PER_MTOK: Record<string, Preco> = {
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  // Opus 4 e 4.1 são aposentados e custam 3× o Opus 4.5 — por isso id exato, e não
  // um prefixo `claude-opus-4` que engoliria toda a família.
  'claude-opus-4-1': { input: 15, output: 75, cacheRead: 1.5, cacheWrite5m: 18.75, cacheWrite1h: 30 },
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5, cacheWrite5m: 18.75, cacheWrite1h: 30 },

  // OpenAI — gpt-4o, gpt-4o-mini e linhas 5.x e 6 do catálogo (issue #1478). Valores da
  // tabela Standard de developers.openai.com/api/docs/pricing, conferida em 23/09/2026
  // (linha 6 em 11/10/2026).
  // Cache de leitura: 0.5× a entrada no gpt-4o; 0.1× nas linhas 5.x e 6, exceto o
  // gpt-6.1-sol (0.05×); os `-pro` e o snapshot gpt-4o-2024-05-13 não têm desconto
  // (cacheRead = entrada).
  // Gravação de cache: as linhas 5.6 e 6 cobram 1.25× a entrada; nas demais é 1×.
  // A OpenAI não distingue TTL na gravação, então 5m e 1h têm o mesmo valor.
  // Fora da tabela: a faixa de contexto longo (> 272K tokens, preço 2×) da 5.4/5.5/5.6,
  // e a da linha 6 (2× a entrada e o cache, 1.5× a saída).
  'gpt-6-astra': { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 12.5 },
  'gpt-6.1-sol': { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 2.5 },
  'gpt-6-luna': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.125 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite5m: 0.15, cacheWrite1h: 0.15 },
  'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite5m: 2.5, cacheWrite1h: 2.5 },
  // Snapshot com preço PRÓPRIO: sem esta linha a tolerância ao sufixo de data o
  // cobraria como `gpt-4o` (armadilha 2 acima, com o sinal do defeito 1).
  'gpt-4o-2024-05-13': { input: 5, output: 15, cacheRead: 5, cacheWrite5m: 5, cacheWrite1h: 5 },
  'gpt-5.6-terra': { input: 2, output: 12, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 2.5 },
  // Preço promocional, válido até pelo menos 21/11/2026; revisar depois.
  'gpt-5.6-sol': { input: 4, output: 20, cacheRead: 0.4, cacheWrite5m: 5, cacheWrite1h: 5 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite5m: 0.25, cacheWrite1h: 0.25 },
  'gpt-5.5': { input: 5, output: 30, cacheRead: 0.5, cacheWrite5m: 5, cacheWrite1h: 5 },
  'gpt-5.5-pro': { input: 30, output: 180, cacheRead: 30, cacheWrite5m: 30, cacheWrite1h: 30 },
  'gpt-5.4': { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite5m: 2.5, cacheWrite1h: 2.5 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite5m: 0.75, cacheWrite1h: 0.75 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite5m: 0.2, cacheWrite1h: 0.2 },
  'gpt-5.4-pro': { input: 30, output: 180, cacheRead: 30, cacheWrite5m: 30, cacheWrite1h: 30 },

  // Google — os seis Gemini do catálogo curado (migrations 0023 e 0101), com o
  // preço do `ai_pricing` em vigor (centavos/100). Sem estas linhas o custo de
  // toda org em Google saía NULL e o teto mensal não disparava.
  // Cache: o caching implícito liga sozinho do 2.5 em diante e o motor monta um
  // prefixo estável para reaproveitá-lo, então num turno típico a maior parte da
  // entrada chega como `cacheReadTokens` (o @ai-sdk/google mapeia
  // `cachedContentTokenCount` para lá). Cobrar essa parte pelo preço cheio
  // superfaturava ~10× e, com o teto em bloqueio, cortava o atendimento antes do
  // teto escolhido — a armadilha 2 com o sinal invertido. Leitura = 0.1× a
  // entrada, conforme "Context caching price" de ai.google.dev/gemini-api/docs/pricing
  // (faixa ≤200K, conferida em 02/10/2026). O implícito não cobra gravação, e o
  // motor não usa cache explícito (sem `cachedContent`), então gravação = entrada
  // fica sem efeito. O 2.0 Flash não tem cache implícito nem aparece mais na
  // página: leitura = entrada, que nunca é aplicada porque nunca vem leitura.
  // Fora da tabela: a faixa acima de 200K tokens de entrada do 2.5 Pro e do 3.1 Pro.
  // Gemini 3.x da migration 0600 (#2533). 3.6/3.7/3.8 Flash: tarifa Standard
  // DEPOIS da promo, conferida em 12/10/2026 em
  // ai.google.dev/gemini-api/docs/pricing (entrada 1.50, saída 7.50, leitura de
  // cache 0.15 a partir de January 1, 2027). A promo (0.75 / 3.75 / 0.075) vale
  // até o instante anterior a VIRADA_GEMINI_FLASH_36_38_MS — precoDoModelo troca.
  // Gravação = entrada, como o resto do Google: o implícito não cobra gravação.
  // O 3.7 saiu da página de preços (depreciado, roteado ao 3.8); a tarifa é a do 3.8.
  'gemini-3.8-flash': { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite5m: 1.5, cacheWrite1h: 1.5 },
  'gemini-3.7-flash': { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite5m: 1.5, cacheWrite1h: 1.5 },
  'gemini-3.6-flash': { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite5m: 1.5, cacheWrite1h: 1.5 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite5m: 0.25, cacheWrite1h: 0.25 },
  'gemini-3.5-flash': { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite5m: 1.5, cacheWrite1h: 1.5 },
  // 3.5 Flash-Lite: tarifa Standard de ai.google.dev/gemini-api/docs/pricing
  // (06/10/2026). O armazenamento de cache ($1/MTok/h) não é por chamada.
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite5m: 0.3, cacheWrite1h: 0.3 },
  'gemini-3.1-pro-preview': { input: 2, output: 12, cacheRead: 0.2, cacheWrite5m: 2, cacheWrite1h: 2 },
  'gemini-2.5-pro': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite5m: 1.25, cacheWrite1h: 1.25 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite5m: 0.3, cacheWrite1h: 0.3 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite5m: 0.1, cacheWrite1h: 0.1 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4, cacheRead: 0.1, cacheWrite5m: 0.1, cacheWrite1h: 0.1 },

  // Jev (TypeSafe AI), a versão FIXADA em lib/ai/decisao/cliente.ts. Fonte:
  // docs.typesafe.ai/models.md, conferida em 23/09/2026 — "Charged per input
  // token. Output tokens are free." A API devolve output_tokens > 0 mesmo assim:
  // grava-se o real e cobra-se zero. Sem cache no fornecedor: cache = entrada.
  // Id exato de propósito: quando a versão fixada subir, esta linha sobe junto,
  // e até lá a versão nova sai com custo NULL — nunca com o preço de outra.
  'jev-1.13.0': { input: 0.042, output: 0, cacheRead: 0.042, cacheWrite5m: 0.042, cacheWrite1h: 0.042 },
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * O preço de um id, tolerando o sufixo de data do vendor (`-20250805` ou `-2024-08-06`).
 *
 * Exportada para o teste poder provar o que a tabela recusa — é o caso que o
 * `startsWith` antigo deixava passar silenciosamente.
 *
 * `em` escolhe a tarifa quando o id tem preço com data. A promo Standard do
 * Gemini 3.6/3.7/3.8 Flash vale inclusive no último ms de 2026. UTC: a página
 * do Google diz "January 1, 2027" sem fuso; o repo grava instante em ISO-8601
 * UTC (CLAUDE.md). Neste instante a tarifa da tabela passa a valer.
 */
const VIRADA_GEMINI_FLASH_36_38_MS = Date.parse('2027-01-01T00:00:00.000Z');

/** Leitura = 0.1× a entrada; gravação = entrada (sem efeito no cache implícito). */
const PROMO_GEMINI_FLASH_36_38: Preco = {
  input: 0.75,
  output: 3.75,
  cacheRead: 0.075,
  cacheWrite5m: 0.75,
  cacheWrite1h: 0.75,
};

const IDS_GEMINI_FLASH_36_38 = new Set([
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
]);

function chaveDoModelo(model: string): string | undefined {
  // O OpenRouter devolve o id com o prefixo `provider/` (`anthropic/claude-…`);
  // a tabela é indexada sem ele. Recorta até a primeira barra e tenta de novo,
  // na MESMA ordem da tolerância do sufixo de data, para um id com prefixo+sufixo
  // (`anthropic/claude-sonnet-5-20250929`) casar também. O id completo segue
  // tentado PRIMEIRO: um id que a tabela conheça com barra vence o recorte.
  const semPrefixo = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  const candidatos = [
    model,
    model.replace(/-\d{8}$/, ""),
    model.replace(/-\d{4}-\d{2}-\d{2}$/, ""),
    semPrefixo,
    semPrefixo.replace(/-\d{8}$/, ""),
    semPrefixo.replace(/-\d{4}-\d{2}-\d{2}$/, ""),
  ];
  return candidatos.find((id) => USD_PER_MTOK[id] !== undefined);
}

export function precoDoModelo(model: string, em: Date = new Date()): Preco | undefined {
  const id = chaveDoModelo(model);
  if (id === undefined) return undefined;
  if (IDS_GEMINI_FLASH_36_38.has(id) && em.getTime() < VIRADA_GEMINI_FLASH_36_38_MS) {
    return PROMO_GEMINI_FLASH_36_38;
  }
  return USD_PER_MTOK[id];
}

/** O motor sabe cobrar este modelo — sem isso o custo sai null e o teto não o vê. */
export function temPrecoNoMotor(model: string): boolean {
  return precoDoModelo(model) !== undefined;
}

/**
 * Custo em CENTS (fracionário; coluna numeric) ou null se o modelo não tem preço
 * conhecido. `inputTokens` aqui é o TOTAL do usage do SDK — a parcela cacheada é
 * descontada e cobrada pela tarifa de cache.
 *
 * `cacheTtl` é o TTL com que o prefixo estável foi gravado (knob `LLM_CACHE_TTL`);
 * o default repete a doutrina ('1h') para quem chama sem ele.
 *
 * `em` é o instante da chamada. Sem ele, vale agora — é o que grava
 * `llm_calls.cost_cents`. Os Gemini 3.6/3.7/3.8 Flash trocam de tarifa em
 * 2027-01-01T00:00:00Z; os outros ids ignoram o instante.
 */
export function costCents(
  model: string,
  usage: TokenUsage,
  cacheTtl: CacheTtl = '1h',
  em: Date = new Date(),
): number | null {
  const p = precoDoModelo(model, em);
  if (p === undefined) {
    return null;
  }
  const cacheWrite = cacheTtl === '5m' ? p.cacheWrite5m : p.cacheWrite1h;
  const noCacheInput = Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens);
  const usd =
    (noCacheInput * p.input +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * cacheWrite +
      usage.outputTokens * p.output) /
    1_000_000;
  return usd * 100;
}

/**
 * Custo dos Gemini 3.6/3.7/3.8 Flash pelo mesmo corte de `costCents`, ou null
 * se o id não é um deles. Prefixo `provider/` e sufixo de data do vendor entram
 * na chave de `chaveDoModelo` — não há um segundo instante de virada aqui.
 *
 * `computeCost` (`lib/ai/cost.ts`) desvia por aqui. A linha de `ai_pricing`
 * desses três ids já está na tarifa de 2027 (150/750). Sem o desvio, o
 * sentimento e o respondedor legado gravariam essa Standard em
 * `llm_calls.cost_cents` durante a promo, e Uso e orçamento somaria o dobro.
 * Só entrada e saída: este caminho não recebe token de cache. Quem tem cache
 * chama `costCents` direto (o seam do agente).
 */
export function costCentsDoGeminiFlashComVirada(
  model: string,
  usage: { inputTokens: number; outputTokens: number },
  em: Date = new Date(),
): number | null {
  const id = chaveDoModelo(model);
  if (id === undefined || !IDS_GEMINI_FLASH_36_38.has(id)) return null;
  return costCents(
    model,
    {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    '1h',
    em,
  );
}
