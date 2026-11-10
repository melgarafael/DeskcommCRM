/**
 * Disciplina de prompt cache — prefixo estável org-wide (F2-17; blueprint 8.2/8.3;
 * CLAUDE.md regra 15). A inversão 1:N da armadilha do cache: o prefixo compartilhado
 * entre TODOS os leads da org é [tools em ordem determinística + system do playbook],
 * byte-idêntico entre runs (mesmas versões ⇒ mesmo hash); tudo por-lead (checkpoint,
 * lead_state, contexto) entra DEPOIS, nas mensagens — nunca antes do breakpoint.
 *
 * Breakpoints (providerOptions.anthropic.cacheControl, AI SDK v6 instalado):
 *   - na ÚLTIMA tool da ordem determinística (tools vêm antes do system no request
 *     Anthropic — hit parcial quando o playbook muda mas as tools não);
 *   - no system message (fim do prefixo estável — cobre tools + system).
 *   Paths reais dos tipos: `cacheControl` em `anthropicLanguageModelOptions`
 *   (@ai-sdk/anthropic/dist/index.d.ts, `{ type: 'ephemeral', ttl?: '5m'|'1h' }`);
 *   `providerOptions` por SystemModelMessage e por Tool (BaseTool) em
 *   @ai-sdk/provider-utils/dist/index.d.ts — o provider converte em cache_control
 *   no bloco correspondente. Providers não-Anthropic ignoram o namespace; os Claude
 *   pela OpenRouter oficial, com OPENROUTER_PROMPT_CACHE=on, recebem os pontos
 *   equivalentes pelo corpo do pedido (cache-da-openrouter.ts, comCacheDaAnthropicNoOpenRouter):
 *   o system com o TTL deste knob e a cauda de 5 min, sem o ponto da última tool.
 *   Desligado (o padrão), a OpenRouter segue sem ponto nenhum.
 *
 * REGRA DURA deste módulo: NADA volátil (timestamp, random, lead, contador) entra
 * aqui — o teste de byte-identidade (tests/unit/prefixo-estavel-golden.test.ts)
 * quebra se a serialização mudar.
 */
import { createHash } from 'node:crypto';

import {
  asSchema,
  jsonSchema,
  type FlexibleSchema,
  type JSONSchema7,
  type SystemModelMessage,
  type ToolSet,
} from 'ai';

/** TTL do bloco compartilhado — knob LLM_CACHE_TTL; doutrina é '1h' (regra 15). */
export type CacheTtl = '5m' | '1h';

/**
 * O ÚNICO default do knob LLM_TOOL_SCHEMA_SEM_PADRAO. Lido pelo seam, pela
 * contagem de prefixo, por `llmEdgeConfigFromEnv` e pela cerca de peso
 * (tests/unit/peso-das-ferramentas.test.ts) — dois defaults é como um deles fica
 * para trás. Desligado até a avaliação off×on: o efeito de o modelo ler menos
 * regex não se prova pelo código.
 */
export const ESQUEMA_SEM_PADRAO_PADRAO = false;

/** Palavras-chave cujo valor é UM esquema (ou, em `items`, uma lista deles). */
const SUBESQUEMA = new Set([
  'items',
  'additionalItems',
  'additionalProperties',
  'propertyNames',
  'contains',
  'not',
  'if',
  'then',
  'else',
  'anyOf',
  'allOf',
  'oneOf',
]);
/** Palavras-chave cujo valor é um MAPA nome → esquema: a chave é nome de campo, nunca filtrada. */
const MAPA_DE_SUBESQUEMAS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);

/**
 * Cópia pura (sem mutar a entrada) do JSON Schema que o zod gera, sem o peso que
 * não muda a geração:
 *  - `$schema` sai sempre — é meta-anotação (~15 tokens por ferramenta);
 *  - `pattern` sai só com `semPadrao` E quando o mesmo nó tem `format` — o zod v4
 *    gera os dois para `.uuid()`/`.datetime()`/`.email()`, e o regex (95 a 190
 *    tokens) só repete o `format`. `pattern` sem `format` (um `.regex()` de
 *    verdade) fica.
 * Anda por palavra-chave: `default`, `enum`, `const`, `examples` são DADO e são
 * copiados como vieram. A validação continua sendo a do zod (ver `buildStablePrefix`).
 */
function enxugarEsquema(no: unknown, semPadrao: boolean): unknown {
  if (Array.isArray(no)) return no.map((n) => enxugarEsquema(n, semPadrao));
  if (typeof no !== 'object' || no === null) return no;
  const temFormat = 'format' in no;
  const saida: Record<string, unknown> = {};
  for (const [chave, valor] of Object.entries(no)) {
    if (chave === '$schema') continue;
    if (chave === 'pattern' && semPadrao && temFormat) continue;
    if (MAPA_DE_SUBESQUEMAS.has(chave) && typeof valor === 'object' && valor !== null) {
      saida[chave] = Object.fromEntries(
        Object.entries(valor).map(([nome, s]) => [nome, enxugarEsquema(s, semPadrao)]),
      );
    } else if (SUBESQUEMA.has(chave)) {
      saida[chave] = enxugarEsquema(valor, semPadrao);
    } else {
      saida[chave] = valor;
    }
  }
  return saida;
}

/** O JSON Schema de uma ferramenta como ele vai no fio ao provedor. */
export async function esquemaParaOProvedor(
  schema: FlexibleSchema<unknown> | undefined,
  opcoes: { semPadrao: boolean },
): Promise<JSONSchema7> {
  return enxugarEsquema(await asSchema(schema).jsonSchema, opcoes.semPadrao) as JSONSchema7;
}

export interface StablePrefix {
  /** system do playbook com o breakpoint de cache no FIM do prefixo estável. */
  system: SystemModelMessage | undefined;
  /** tools reordenadas por nome (determinístico) com breakpoint na última. */
  tools: ToolSet | undefined;
}

type PrefixProviderOptions = NonNullable<SystemModelMessage['providerOptions']>;

function withAnthropicCache(
  existing: PrefixProviderOptions | undefined,
  ttl: CacheTtl,
): PrefixProviderOptions {
  return {
    ...existing,
    anthropic: {
      ...existing?.['anthropic'],
      cacheControl: { type: 'ephemeral', ttl },
    },
  };
}

/**
 * Monta o prefixo estável do request: mesmas entradas ⇒ mesmos bytes ⇒ mesmo
 * prefixo no provider. Chamada no seam (runModelCall), nunca em call site.
 */
export function buildStablePrefix(input: {
  system?: string | undefined;
  tools?: ToolSet | undefined;
  cacheTtl: CacheTtl;
  /** knob LLM_TOOL_SCHEMA_SEM_PADRAO; ausente = ESQUEMA_SEM_PADRAO_PADRAO. */
  esquemaSemPadrao?: boolean | undefined;
}): StablePrefix {
  const semPadrao = input.esquemaSemPadrao ?? ESQUEMA_SEM_PADRAO_PADRAO;
  let tools: ToolSet | undefined;
  if (input.tools !== undefined && Object.keys(input.tools).length > 0) {
    const names = Object.keys(input.tools).sort();
    tools = {};
    for (const name of names) {
      const t = input.tools[name]!;
      // O provedor recebe o esquema enxuto; quem valida a chamada continua sendo o
      // esquema ORIGINAL (o zod), resolvido só quando há o que validar.
      tools[name] =
        t.type === 'provider'
          ? t
          : {
              ...t,
              inputSchema: jsonSchema(() => esquemaParaOProvedor(t.inputSchema, { semPadrao }), {
                validate: async (value) => {
                  const validar = asSchema(t.inputSchema).validate;
                  return validar ? validar(value) : { success: true, value };
                },
              }),
            };
    }
    const last = names[names.length - 1]!;
    const lastTool = tools[last]!;
    tools[last] = {
      ...lastTool,
      providerOptions: withAnthropicCache(lastTool.providerOptions, input.cacheTtl),
    };
  }
  return {
    system:
      input.system === undefined
        ? undefined
        : {
            role: 'system',
            content: input.system,
            providerOptions: withAnthropicCache(undefined, input.cacheTtl),
          },
    tools,
  };
}

/**
 * Serialização canônica do prefixo (a MESMA visão que o provider recebe: tools em
 * ordem determinística, depois o system) — base do hash de byte-identidade e da
 * estimativa/medição de orçamento (ops:count-prefix). Async porque o JSON Schema
 * de uma tool pode ser lazy no SDK (asSchema(...).jsonSchema é PromiseLike).
 */
export async function serializeStablePrefix(input: {
  system?: string | undefined;
  tools?: ToolSet | undefined;
  esquemaSemPadrao?: boolean | undefined;
}): Promise<string> {
  const semPadrao = input.esquemaSemPadrao ?? ESQUEMA_SEM_PADRAO_PADRAO;
  const parts: string[] = [];
  if (input.tools !== undefined) {
    for (const name of Object.keys(input.tools).sort()) {
      const t = input.tools[name]!;
      const esquema = await esquemaParaOProvedor(t.inputSchema, { semPadrao });
      parts.push(
        `=== tool:${name} ===\n${JSON.stringify({ description: t.description ?? null, inputSchema: esquema })}`,
      );
    }
  }
  if (input.system !== undefined) {
    parts.push(`=== system ===\n${input.system}`);
  }
  return parts.join('\n\n');
}

/** sha256 hex do prefixo canônico — 2 builds do mesmo playbook ⇒ hash igual. */
export async function stablePrefixHash(input: {
  system?: string | undefined;
  tools?: ToolSet | undefined;
  esquemaSemPadrao?: boolean | undefined;
}): Promise<string> {
  return createHash('sha256').update(await serializeStablePrefix(input), 'utf8').digest('hex');
}
