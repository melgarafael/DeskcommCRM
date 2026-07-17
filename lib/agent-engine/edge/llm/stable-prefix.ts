/**
 * Disciplina de prompt cache — prefixo estável org-wide (F2-17; blueprint 8.2/8.3;
 * CLAUDE.md regra 15). A inversão 1:N da armadilha do cache: o prefixo compartilhado
 * entre TODOS os leads da org é [tools em ordem determinística + system do playbook],
 * byte-idêntico entre runs (mesmas versões ⇒ mesmo hash); tudo por-lead (checkpoint,
 * lead_state, contexto) entra DEPOIS, nas mensagens — nunca antes do breakpoint.
 *
 * Breakpoints (providerOptions.anthropic.cacheControl, AI SDK v7):
 *   - na ÚLTIMA tool da ordem determinística (tools vêm antes do system no request
 *     Anthropic — hit parcial quando o playbook muda mas as tools não);
 *   - no system message (fim do prefixo estável — cobre tools + system).
 *   Paths reais dos tipos: `cacheControl` em `anthropicLanguageModelOptions`
 *   (@ai-sdk/anthropic/dist/index.d.ts, `{ type: 'ephemeral', ttl?: '5m'|'1h' }`);
 *   `providerOptions` por SystemModelMessage e por Tool (BaseTool) em
 *   @ai-sdk/provider-utils/dist/index.d.ts — o provider converte em cache_control
 *   no bloco correspondente. Providers não-Anthropic ignoram o namespace.
 *
 * REGRA DURA deste módulo: NADA volátil (timestamp, random, lead, contador) entra
 * aqui — o teste de byte-identidade (llm-cache.test.ts) quebra se entrar.
 */
import { createHash } from 'node:crypto';

import { asSchema, type SystemModelMessage, type ToolSet } from 'ai';

/** TTL do bloco compartilhado — knob LLM_CACHE_TTL; doutrina é '1h' (regra 15). */
export type CacheTtl = '5m' | '1h';

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
}): StablePrefix {
  let tools: ToolSet | undefined;
  if (input.tools !== undefined && Object.keys(input.tools).length > 0) {
    const names = Object.keys(input.tools).sort();
    tools = {};
    for (const name of names) {
      tools[name] = input.tools[name]!;
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
}): Promise<string> {
  const parts: string[] = [];
  if (input.tools !== undefined) {
    for (const name of Object.keys(input.tools).sort()) {
      const t = input.tools[name]!;
      const jsonSchema = await asSchema(t.inputSchema).jsonSchema;
      parts.push(
        `=== tool:${name} ===\n${JSON.stringify({ description: t.description ?? null, inputSchema: jsonSchema })}`,
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
}): Promise<string> {
  return createHash('sha256').update(await serializeStablePrefix(input), 'utf8').digest('hex');
}
