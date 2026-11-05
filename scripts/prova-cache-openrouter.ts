/**
 * PROVA PAGA do cache dos Claude pela OpenRouter — a condição para ligar
 * OPENROUTER_PROMPT_CACHE=on por padrão (virou o padrão depois desta prova).
 *
 * O knob nasce DESLIGADO porque a doc da OpenRouter só garante o TTL de 1 h em
 * Anthropic, Bedrock e Vertex, e um Claude dela tem de 8 a 11 provedores de
 * origem (Azure e Claude Platform on AWS inclusive). Um provedor que recuse o
 * campo com 400 deixaria o agente mudo. Esta prova manda o corpo EXATO do embrulho
 * da fábrica (`comCacheDaAnthropicNoOpenRouter`) a CADA provedor de origem que a
 * OpenRouter lista para o modelo, fixado por `provider.only`, e diz por tag:
 *
 *   - status HTTP das 2 chamadas. A tag passa com as duas em 200, a 1ª gravando
 *     cache e a 2ª lendo; a tag com região que o `only` recusa (404) é repetida
 *     pela família (`amazon-bedrock/us` → `amazon-bedrock`), e a linha diz;
 *   - `provider` da resposta, contra o `provider_name` do endpoint;
 *   - `prompt_tokens`, `cached_tokens`, `cache_write_tokens`, `cost`, `is_byok`
 *     (presente ou ausente) e `cost_details` crus;
 *   - a razão cost₁ / (prompt₁ × preço de entrada): ≈ 2 com o TTL de 1 h honrado,
 *     ≈ 1,25 com ele ignorado (gravou a 5 min).
 *
 * Sem banco e sem o seam: o seam não deixa fixar o endpoint, e o caminho inteiro
 * (seam → embrulho → custo gravado) é o trecho SMOKE_OPENROUTER de smoke-llm.ts.
 *
 * Uso (gasta dinheiro de verdade; medido em 03/11/2026: US$ 0,95 por 29 tags de
 * três modelos, PROVA_MODELOS=anthropic/claude-haiku-5.5,anthropic/claude-sonnet-4.6,
 * anthropic/claude-sonnet-5):
 *   OPENROUTER_API_KEY=sk-or-... pnpm tsx scripts/prova-cache-openrouter.ts
 *   PROVA_MODELOS=anthropic/claude-haiku-4.5,anthropic/claude-sonnet-5   (padrão)
 * Sai com 0 se toda tag passou e 1 se alguma falhou. Também sai com 1, SEM
 * veredito, quando a conta da OpenRouter responde 402 (sem saldo): isso não é o
 * provedor recusando o cache, e a prova para em vez de reprovar a tag.
 */
import { randomUUID } from 'node:crypto';

import { createOpenAI } from '@ai-sdk/openai';
import { APICallError, generateText } from 'ai';

import { comCacheDaAnthropicNoOpenRouter } from '@/lib/agent-engine/edge/llm/cache-da-openrouter';
import { buildStablePrefix } from '@/lib/agent-engine/edge/llm/stable-prefix';

/** A prova é sobre o host oficial: OPENROUTER_BASE_URL não a desvia para um gateway. */
const OPENROUTER_OFICIAL = 'https://openrouter.ai/api/v1';
const MODELOS_PADRAO = 'anthropic/claude-haiku-4.5,anthropic/claude-sonnet-5';

export interface EndpointDoModelo {
  tag: string;
  providerName: string;
  /** USD por token de entrada (o `pricing.prompt` da listagem). */
  precoDeEntrada: number;
}

export interface ResultadoDaChamada {
  status: number;
  provider?: string;
  promptTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
  isByok: 'ausente' | boolean;
  costDetails?: unknown;
  erro?: string;
}

export interface LinhaDaProva {
  modelo: string;
  tag: string;
  /** A tag que de fato foi pedida: a família, quando o `only` recusou a tag. */
  tagUsada: string;
  chamadas: ResultadoDaChamada[];
  razaoDeCusto?: number;
  passou: boolean;
  motivos: string[];
}

/** Acrescenta ao corpo o pedido de UM provedor de origem, sem queda para outro. */
export function fixarEndpoint(inner: typeof fetch, tag: string): typeof fetch {
  return (input, init) => {
    const json = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return inner(input, {
      ...init,
      body: JSON.stringify({ ...json, provider: { only: [tag], allow_fallbacks: false } }),
    });
  };
}

export async function listarEndpoints(f: typeof fetch, modelo: string): Promise<EndpointDoModelo[]> {
  const res = await f(`${OPENROUTER_OFICIAL}/models/${modelo}/endpoints`);
  if (!res.ok) throw new Error(`listagem de endpoints de ${modelo}: HTTP ${res.status}`);
  const json = (await res.json()) as {
    data?: { endpoints?: Array<{ tag?: string; provider_name?: string; pricing?: { prompt?: string } }> };
  };
  return (json.data?.endpoints ?? [])
    .filter((e): e is { tag: string; provider_name?: string; pricing?: { prompt?: string } } => typeof e.tag === 'string')
    .map((e) => ({ tag: e.tag, providerName: e.provider_name ?? '', precoDeEntrada: Number(e.pricing?.prompt ?? NaN) }));
}

/**
 * ~5,6 mil tokens: acima do mínimo cacheável do Haiku (4.096). O SALT é por
 * execução, para a 1ª chamada de cada tag GRAVAR em vez de ler o cache de ontem.
 */
export function prefixoDaProva(salt: string): string {
  const bloco =
    'Você é o assistente de vendas da organização da prova de cache. Responda em português do Brasil, ' +
    'com no máximo duas frases. Nunca prometa prazo, desconto ou condição fora do catálogo. Catálogo: ' +
    'parafuso M3 (R$ 1), porca M3 (R$ 0,50), arruela lisa (R$ 0,25).';
  return [`[prova ${salt}]`, ...Array.from({ length: 80 }, (_, i) => `[secao ${i + 1}] ${bloco}`)].join('\n');
}

async function umaChamada(f: typeof fetch, chave: string, modelo: string, system: string): Promise<ResultadoDaChamada> {
  const prefixo = buildStablePrefix({ system, cacheTtl: '1h' });
  try {
    const r = await generateText({
      model: createOpenAI({ apiKey: chave, baseURL: OPENROUTER_OFICIAL, fetch: f }).chat(modelo),
      system: prefixo.system,
      prompt: 'diga ok',
      maxOutputTokens: 5,
      maxRetries: 0,
      include: { responseBody: true },
    });
    const corpo = r.response.body as {
      provider?: string;
      usage?: {
        prompt_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
        cost?: number;
        is_byok?: boolean;
        cost_details?: unknown;
      };
    };
    const u = corpo.usage;
    return {
      status: 200,
      ...(corpo.provider !== undefined ? { provider: corpo.provider } : {}),
      ...(u?.prompt_tokens !== undefined ? { promptTokens: u.prompt_tokens } : {}),
      ...(u?.prompt_tokens_details?.cached_tokens !== undefined ? { cachedTokens: u.prompt_tokens_details.cached_tokens } : {}),
      ...(u?.prompt_tokens_details?.cache_write_tokens !== undefined
        ? { cacheWriteTokens: u.prompt_tokens_details.cache_write_tokens }
        : {}),
      ...(u?.cost !== undefined ? { cost: u.cost } : {}),
      isByok: typeof u?.is_byok === 'boolean' ? u.is_byok : 'ausente',
      ...(u?.cost_details !== undefined ? { costDetails: u.cost_details } : {}),
    };
  } catch (erro) {
    // A falha É o dado da prova: status e mensagem vão para a linha da tag.
    return {
      status: APICallError.isInstance(erro) ? (erro.statusCode ?? 0) : 0,
      isByok: 'ausente',
      erro: erro instanceof Error ? erro.message : String(erro),
    };
  }
}

export async function provarTag(opts: {
  fetch: typeof fetch;
  chave: string;
  modelo: string;
  endpoint: EndpointDoModelo;
  salt: string;
}): Promise<LinhaDaProva> {
  const system = prefixoDaProva(`${opts.salt}|${opts.endpoint.tag}`);
  const tentar = async (tag: string): Promise<ResultadoDaChamada[]> => {
    // Uma sessão por tag: a fixação de provedor da OpenRouter não pode misturar as tags.
    const f = comCacheDaAnthropicNoOpenRouter(fixarEndpoint(opts.fetch, tag), {
      ttl: '1h',
      cauda: true,
      sessao: randomUUID().replace(/-/g, ''),
    });
    const primeira = await umaChamada(f, opts.chave, opts.modelo, system);
    if (primeira.status !== 200) return [primeira];
    return [primeira, await umaChamada(f, opts.chave, opts.modelo, system)];
  };

  let tagUsada = opts.endpoint.tag;
  let chamadas = await tentar(tagUsada);
  const motivos: string[] = [];
  // O `only` pode não aceitar a tag com região (`amazon-bedrock/us`): repete pela família.
  if (chamadas[0]?.status === 404 && tagUsada.includes('/')) {
    motivos.push(`tag ${tagUsada} recusada pelo only (404); repetida como ${tagUsada.split('/')[0]}`);
    tagUsada = tagUsada.split('/')[0]!;
    chamadas = await tentar(tagUsada);
  }

  const [c1, c2] = chamadas;
  for (const [i, c] of chamadas.entries()) {
    if (c.status !== 200) motivos.push(`chamada ${i + 1}: HTTP ${c.status} ${c.erro ?? ''}`.trim());
  }
  if (c1?.status === 200 && !((c1.cacheWriteTokens ?? 0) > 0)) motivos.push('chamada 1 não gravou cache');
  if (c2?.status === 200 && !((c2.cachedTokens ?? 0) > 0)) motivos.push('chamada 2 não leu cache');
  if (c1?.provider !== undefined && opts.endpoint.providerName && c1.provider !== opts.endpoint.providerName) {
    motivos.push(`atendeu ${c1.provider}, pedido ${opts.endpoint.providerName}`);
  }
  const razaoDeCusto =
    c1?.cost !== undefined && c1.promptTokens && Number.isFinite(opts.endpoint.precoDeEntrada)
      ? c1.cost / (c1.promptTokens * opts.endpoint.precoDeEntrada)
      : undefined;
  return {
    modelo: opts.modelo,
    tag: opts.endpoint.tag,
    tagUsada,
    chamadas,
    ...(razaoDeCusto !== undefined ? { razaoDeCusto } : {}),
    passou: chamadas.length === 2 && chamadas.every((c) => c.status === 200) &&
      (c1?.cacheWriteTokens ?? 0) > 0 && (c2?.cachedTokens ?? 0) > 0,
    motivos,
  };
}

export function linhaLegivel(l: LinhaDaProva): string {
  const c = (r: ResultadoDaChamada | undefined) =>
    r === undefined
      ? '—'
      : `HTTP ${r.status} provider=${r.provider ?? '?'} prompt=${r.promptTokens ?? '?'} ` +
        `lido=${r.cachedTokens ?? '?'} gravado=${r.cacheWriteTokens ?? '?'} cost=${r.cost ?? '?'} ` +
        `is_byok=${String(r.isByok)} cost_details=${JSON.stringify(r.costDetails ?? null)}`;
  const razao =
    l.razaoDeCusto === undefined
      ? 'razão=?'
      : `razão=${l.razaoDeCusto.toFixed(2)} (${l.razaoDeCusto >= 1.6 ? '1 h honrado' : l.razaoDeCusto >= 1.1 ? 'gravou a 5 min?' : 'sem gravação?'})`;
  return [
    `${l.passou ? '✓' : '✗'} ${l.modelo} @ ${l.tag}${l.tagUsada !== l.tag ? ` (pedida como ${l.tagUsada})` : ''} — ${razao}`,
    `    1ª: ${c(l.chamadas[0])}`,
    `    2ª: ${c(l.chamadas[1])}`,
    ...l.motivos.map((m) => `    · ${m}`),
  ].join('\n');
}

export async function rodarProva(opts: {
  fetch: typeof fetch;
  chave: string;
  modelos: string[];
  salt: string;
  escrever: (linha: string) => void;
}): Promise<{ linhas: LinhaDaProva[]; aprovada: boolean }> {
  const linhas: LinhaDaProva[] = [];
  for (const modelo of opts.modelos) {
    const endpoints = await listarEndpoints(opts.fetch, modelo);
    opts.escrever(`→ ${modelo}: ${endpoints.length} provedores de origem (${endpoints.map((e) => e.tag).join(', ')})`);
    if (endpoints.length === 0) throw new Error(`${modelo}: a OpenRouter não listou nenhum endpoint`);
    for (const endpoint of endpoints) {
      const linha = await provarTag({ fetch: opts.fetch, chave: opts.chave, modelo, endpoint, salt: opts.salt });
      // 402 é a CONTA sem saldo, não o provedor recusando o cache: contá-lo como
      // tag reprovada daria "PROVA REPROVADA" e culparia o cache_control. O
      // `limit_remaining` de /api/v1/key é o teto da chave; saldo é /api/v1/credits.
      if (linha.chamadas.some((c) => c.status === 402)) {
        throw new Error(`${modelo} @ ${endpoint.tag}: HTTP 402, a conta da OpenRouter está sem saldo — a prova parou SEM veredito`);
      }
      linhas.push(linha);
      opts.escrever(linhaLegivel(linha));
    }
  }
  const aprovada = linhas.length > 0 && linhas.every((l) => l.passou);
  opts.escrever(
    aprovada
      ? `PROVA APROVADA — ${linhas.length} tags, zero recusa: OPENROUTER_PROMPT_CACHE pode virar on por padrão.`
      : `PROVA REPROVADA — ${linhas.filter((l) => !l.passou).length} de ${linhas.length} tags falharam: o padrão fica off.`,
  );
  return { linhas, aprovada };
}

async function main(): Promise<void> {
  const chave = process.env.OPENROUTER_API_KEY?.trim();
  if (!chave) {
    console.error('✗ OPENROUTER_API_KEY ausente — a prova exige a chave real');
    process.exit(1);
  }
  const modelos = (process.env.PROVA_MODELOS?.trim() || MODELOS_PADRAO)
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  const { aprovada } = await rodarProva({
    fetch,
    chave,
    modelos,
    salt: `prova-${Date.now()}`,
    escrever: (linha) => console.info(linha),
  });
  process.exit(aprovada ? 0 : 1);
}

if (require.main === module) {
  main().catch((erro) => {
    console.error('✗ PROVA (exceção):', erro);
    process.exit(1);
  });
}
