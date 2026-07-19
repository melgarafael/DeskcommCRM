/**
 * Medição REAL do prefixo estável (F2-17 acceptance 4; stack.md §2 smoke item 6):
 * chama o endpoint count-tokens do provider Anthropic com a MESMA visão do request
 * do agente — tools (JSON Schema, ordem determinística) + system — e devolve o
 * total em tokens do MODELO real. Lacuna declarada do blueprint: tokenizer novo
 * pode divergir ~+30% da heurística local; por isso o orçamento só é fixado após
 * ESTA medição, nunca pela estimativa chars/3,5.
 *
 * Egress mora em edge/ (regra dura nº 5). A chave só entra no header — nunca em
 * erro/log. Duas chamadas (com e sem o prefixo) e subtração: o resultado é o
 * custo do prefixo em si, sem o overhead da mensagem mínima.
 */
import { asSchema, type ToolSet } from 'ai';

import { allowlistedFetch, buildAllowlist } from '../egress';
import type { Logger } from '../../obs/logger';

// Versão do PROTOCOLO da API Anthropic (header obrigatório), não de modelo —
// mesma pinada pelo @ai-sdk/anthropic; re-validar em upgrade de major (regra 16).
const ANTHROPIC_API_VERSION = '2023-06-01';

export interface CountPrefixTokensInput {
  apiKey: string;
  /** id do modelo da ORG (config, nunca constante) — o tokenizer é por modelo. */
  model: string;
  system: string;
  tools?: ToolSet | undefined;
  /** default: API pública da Anthropic; override para gateway compatível. */
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
  /** logger do evento de segurança de egress bloqueado (F4-03; opcional). */
  log?: Logger | undefined;
}

export interface CountPrefixTokensResult {
  /** tokens do prefixo estável em si (total com prefixo − baseline sem prefixo) */
  prefixTokens: number;
  /** input_tokens da chamada com tools+system+mensagem mínima */
  totalWithPrefix: number;
  /** input_tokens da mensagem mínima sozinha (overhead descontado) */
  baseline: number;
}

async function countTokens(
  input: CountPrefixTokensInput,
  body: Record<string, unknown>,
): Promise<number> {
  const base = input.baseUrl ?? 'https://api.anthropic.com';
  // Egress só pelo cliente único com allowlist (F4-03): o único destino legítimo é o
  // endpoint do provedor configurado (base) — qualquer outro host falha closed.
  const res = await allowlistedFetch(
    `${base}/v1/messages/count_tokens`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': input.apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify({ model: input.model, ...body }),
      signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
    },
    { allowlist: buildAllowlist([base]), ...(input.log ? { log: input.log } : {}) },
  );
  if (!res.ok) {
    // corpo de erro da API não carrega credencial; o header (com a chave) nunca ecoa
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`count_tokens falhou (HTTP ${res.status}): ${detail}`);
  }
  const parsed = (await res.json()) as { input_tokens?: number };
  if (typeof parsed.input_tokens !== 'number') {
    throw new Error('count_tokens sem input_tokens na resposta — shape da API mudou, re-validar');
  }
  return parsed.input_tokens;
}

/** Serializa a ToolSet no formato da API Anthropic (name/description/input_schema). */
async function toAnthropicTools(tools: ToolSet): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const name of Object.keys(tools).sort()) {
    const t = tools[name]!;
    out.push({
      name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      input_schema: await asSchema(t.inputSchema).jsonSchema,
    });
  }
  return out;
}

export async function countPrefixTokens(input: CountPrefixTokensInput): Promise<CountPrefixTokensResult> {
  const minimalMessage = { role: 'user', content: '.' };
  const baseline = await countTokens(input, { messages: [minimalMessage] });
  const totalWithPrefix = await countTokens(input, {
    system: input.system,
    ...(input.tools !== undefined && Object.keys(input.tools).length > 0
      ? { tools: await toAnthropicTools(input.tools) }
      : {}),
    messages: [minimalMessage],
  });
  return { prefixTokens: totalWithPrefix - baseline, totalWithPrefix, baseline };
}
