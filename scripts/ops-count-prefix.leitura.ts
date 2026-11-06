/**
 * O NÚCLEO de `scripts/ops-count-prefix.ts` — puro: sem banco, sem
 * `process.exit`. Recebe os blocos do sistema e as ferramentas candidatas e
 * devolve, por item, caracteres e tokens o200k. Só NOMES e NÚMEROS saem daqui:
 * o texto dos blocos (prompt, memória da organização) nunca é impresso.
 */
import type { ToolSet } from "ai";
import { countTokens } from "gpt-tokenizer";

import { serializeStablePrefix } from "@/lib/agent-engine/edge/llm/stable-prefix";

/**
 * Ferramentas que entram no turno só sob canal, opção, módulo ou estado do
 * turno — a lista de candidatas as mostra, mas o turno pode não as enviar.
 * ponytail: lista à mão, e a diferença contra `chars_ferramentas` da produção
 * denuncia quando ela envelhecer; a exatidão é da frente que reescrever as
 * regras de inclusão do turno (inbound-turn.ts).
 */
export const FERRAMENTAS_CONDICIONAIS: ReadonlySet<string> = new Set([
  "send_template",
  "schedule_followup",
  "read_skill_reference",
  "request_human_handoff",
  "open_human_case",
  "provide_case_update",
  "search_knowledge",
  "crm_draft_proposal",
  "crm_preparar_proposta",
]);

export interface LinhaMedida {
  nome: string;
  chars: number;
  tokens: number;
  condicional: boolean;
}

export interface MedidaDoPrefixo {
  blocos: LinhaMedida[];
  /** Do maior para o menor, cada uma serializada como o provedor a recebe. */
  ferramentas: LinhaMedida[];
  totalBlocos: { chars: number; tokens: number };
  /** Soma das linhas + os separadores `\n\n` da serialização canônica. */
  totalFerramentas: { chars: number; tokens: number };
}

function medir(nome: string, texto: string, condicional = false): LinhaMedida {
  return { nome, chars: texto.length, tokens: countTokens(texto), condicional };
}

export async function medirPrefixo(input: {
  blocos: ReadonlyArray<readonly [string, string]>;
  ferramentas: ToolSet;
  /** O knob LLM_TOOL_SCHEMA_SEM_PADRAO como o worker o lê: o peso é o do fio. */
  esquemaSemPadrao?: boolean | undefined;
}): Promise<MedidaDoPrefixo> {
  const blocos = input.blocos.filter(([, texto]) => texto !== "").map(([nome, texto]) => medir(nome, texto));
  const ferramentas: LinhaMedida[] = [];
  for (const [nome, t] of Object.entries(input.ferramentas)) {
    const texto = await serializeStablePrefix({ tools: { [nome]: t }, esquemaSemPadrao: input.esquemaSemPadrao });
    ferramentas.push(medir(nome, texto, FERRAMENTAS_CONDICIONAIS.has(nome)));
  }
  ferramentas.sort((a, b) => b.chars - a.chars || a.nome.localeCompare(b.nome));
  const soma = (ls: LinhaMedida[], sep: number) => ({
    chars: ls.reduce((n, l) => n + l.chars, 0) + Math.max(0, ls.length - 1) * sep,
    tokens: ls.reduce((n, l) => n + l.tokens, 0),
  });
  return {
    blocos,
    ferramentas,
    // `\n\n` entre blocos (inbound-turn.ts junta o sistema assim) e entre ferramentas
    // (serializeStablePrefix).
    totalBlocos: soma(blocos, 2),
    totalFerramentas: soma(ferramentas, 2),
  };
}

/** Uma linha por item: nome, caracteres, tokens e a marca `condicional`. Nunca conteúdo. */
export function formatarMedida(m: MedidaDoPrefixo): string {
  const linha = (l: LinhaMedida) =>
    `  ${l.nome.padEnd(36)} ${String(l.chars).padStart(8)} chars ${String(l.tokens).padStart(7)} tok${l.condicional ? "  condicional" : ""}`;
  return [
    "SISTEMA POR BLOCO",
    ...m.blocos.map(linha),
    `  ${"TOTAL".padEnd(36)} ${String(m.totalBlocos.chars).padStart(8)} chars ${String(m.totalBlocos.tokens).padStart(7)} tok`,
    "",
    "FERRAMENTAS CANDIDATAS (maior primeiro)",
    ...m.ferramentas.map(linha),
    `  ${"TOTAL".padEnd(36)} ${String(m.totalFerramentas.chars).padStart(8)} chars ${String(m.totalFerramentas.tokens).padStart(7)} tok`,
  ].join("\n");
}
