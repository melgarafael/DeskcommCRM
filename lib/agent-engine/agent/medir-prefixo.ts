/**
 * Mede o prefixo estável (system + schemas das tools) sem chamar provedor e
 * sem decifrar credencial. Usado por `scripts/ops-count-prefix.ts`.
 */
import type { ToolSet } from "ai";

import { AGENT_TOOL_DEFS } from "./agent-tool-defs";
import { nativasDoTurno, type CapacidadeDoTurno } from "./nativas-do-turno";
import { countPayloadTokens } from "../edge/crm/get-lead-context";
import { serializeStablePrefix } from "../edge/llm/stable-prefix";

/** Nativas que o ensaio pago da FAQ carregou (auditoria 2026-09-16). */
export const NATIVAS_ANTES = [
  "get_lead_context",
  "send_message",
  "update_lead_state",
  "save_lead_note",
  "get_lead_note",
  "request_human_handoff",
  "schedule_followup",
] as const;

export const FAQ_SIGILIUM: CapacidadeDoTurno = {
  contextoJaNaAbertura: true,
  compactacaoRodou: false,
  followupHabilitadoNoAgente: false,
  janelaDeFollowupConfigurada: true,
  handoffHabilitado: true,
  funilGravavel: false,
  notasUtilizaveis: false,
  conhecimentoDisponivel: false,
  casosHabilitados: false,
};

export const SYSTEM_STUB_FAQ =
  "## Identidade\nAssistente de FAQ. Responda só com o que está na abertura.\n";

export const ABERTURA_FAQ =
  "Novo turno de atendimento: o lead enviou uma mensagem (a última inbound do histórico abaixo).\n" +
  JSON.stringify({
    contact: { name: "Teste", phone: null },
    messages: [
      {
        direction: "inbound",
        body: "o que é o Sigilium?",
        sent_at: "2026-09-16T15:00:00-03:00",
      },
    ],
  }) +
  "\nResponda ao lead usando a tool send_message — NUNCA escreva a resposta como texto direto.";

export function toolsDeNomes(nomes: readonly string[]): ToolSet {
  const out: ToolSet = {};
  for (const nome of nomes) {
    const def = AGENT_TOOL_DEFS[nome as keyof typeof AGENT_TOOL_DEFS];
    if (def === undefined) continue;
    // serializeStablePrefix só lê description + inputSchema. Não instanciamos
    // `tool()` aqui: a união dos schemas das nativas não casa com o overload.
    out[nome] = {
      description: def.description,
      inputSchema: def.inputSchema,
    } as ToolSet[string];
  }
  return out;
}

export interface MedidaDePrefixo {
  tools: string[];
  system_chars: number;
  system_tokens: number;
  tools_chars: number;
  tools_tokens: number;
  opening_chars: number;
  opening_tokens: number;
  per_step_chars: number;
  per_step_tokens: number;
}

export async function medirPrefixo(input: {
  system: string;
  tools: readonly string[];
  opening: string;
}): Promise<MedidaDePrefixo> {
  const toolSet = toolsDeNomes(input.tools);
  const serialized = await serializeStablePrefix({ system: input.system, tools: toolSet });
  const toolsPart = serialized.replace(`=== system ===\n${input.system}`, "").trim();
  return {
    tools: [...input.tools],
    system_chars: input.system.length,
    system_tokens: countPayloadTokens(input.system),
    tools_chars: toolsPart.length,
    tools_tokens: countPayloadTokens(toolsPart),
    opening_chars: input.opening.length,
    opening_tokens: countPayloadTokens(input.opening),
    per_step_chars: serialized.length + input.opening.length,
    per_step_tokens: countPayloadTokens(serialized + input.opening),
  };
}

export async function compararFaqSigilium(): Promise<{
  antes: MedidaDePrefixo;
  depois: MedidaDePrefixo;
  reducao_tokens_por_passo: number;
  reducao_pct: number;
}> {
  const depoisTools = nativasDoTurno(FAQ_SIGILIUM);
  const [antes, depois] = await Promise.all([
    medirPrefixo({ system: SYSTEM_STUB_FAQ, tools: NATIVAS_ANTES, opening: ABERTURA_FAQ }),
    medirPrefixo({ system: SYSTEM_STUB_FAQ, tools: depoisTools, opening: ABERTURA_FAQ }),
  ]);
  const reducao_tokens_por_passo = antes.per_step_tokens - depois.per_step_tokens;
  return {
    antes,
    depois,
    reducao_tokens_por_passo,
    reducao_pct: antes.per_step_tokens === 0 ? 0 : reducao_tokens_por_passo / antes.per_step_tokens,
  };
}
