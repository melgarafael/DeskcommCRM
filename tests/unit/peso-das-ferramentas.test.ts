import type { FlexibleSchema } from "ai";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import type { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  AGENT_TOOL_DEFS,
  SCHEDULE_FOLLOWUP_COM_NEGOCIO,
} from "@/lib/agent-engine/agent/inbound-turn";
import {
  ESQUEMA_SEM_PADRAO_PADRAO,
  esquemaParaOProvedor,
} from "@/lib/agent-engine/edge/llm/stable-prefix";
import { shapeToZodObject } from "@/lib/ai/runtime/tools";
import { allTools } from "@/lib/mcp/tools";

/**
 * CERCA DE PESO POR FERRAMENTA.
 *
 * Toda ferramenta do agente vai INTEIRA em todo passo do turno (nome, descrição e
 * esquema), e o peso cresce calado: uma frase a mais numa descrição, um `.uuid()`
 * que traz 100 tokens de regex. Medido em 2026-10-31: o catálogo pesava 30.518
 * tokens, e um terço era `pattern` e `$schema` gerados pelo zod.
 *
 * A régua é o que vai no fio: o esquema passa por `esquemaParaOProvedor` com o
 * default ÚNICO do knob (`ESQUEMA_SEM_PADRAO_PADRAO`, importado, nunca literal),
 * e conta com o tokenizer o200k_base (gpt-tokenizer, já dependência). Não é o
 * tokenizer de todo provedor — é uma régua estável para comparar consigo mesma.
 *
 * Reprova quando:
 *  - uma ferramenta não tem teto, ou um teto não tem ferramenta;
 *  - uma ferramenta passa do teto — suba o teto E reescreva o motivo;
 *  - uma ferramenta fica abaixo de 90% do teto — CATRACA: desça o teto no mesmo PR
 *    (é o que obriga a baixar os tetos no PR que virar o default do knob);
 *  - a soma passa de TETO_TOTAL.
 */

const BASE = "linha de base, medida quando a cerca nasceu (2026-10-31)";

const TETO: Readonly<Record<string, { tokens: number; motivo: string }>> = {
  "crm_list_event_types": { tokens: 204, motivo: BASE },
  "crm_find_free_slots": { tokens: 859, motivo: BASE },
  "crm_list_appointments": { tokens: 1478, motivo: BASE },
  "crm_search_contacts": { tokens: 135, motivo: BASE },
  "crm_get_contact": { tokens: 188, motivo: BASE },
  "crm_propose_contact_field": { tokens: 438, motivo: BASE },
  "crm_list_conversations": { tokens: 283, motivo: BASE },
  "crm_get_conversation": { tokens: 228, motivo: BASE },
  "crm_get_conversation_history": { tokens: 203, motivo: BASE },
  "crm_get_queue_status": { tokens: 83, motivo: BASE },
  "crm_list_leads": { tokens: 500, motivo: BASE },
  "crm_get_lead": { tokens: 202, motivo: BASE },
  "crm_list_pipelines": { tokens: 63, motivo: BASE },
  "crm_get_pipeline_forecast": { tokens: 263, motivo: BASE },
  "crm_search_knowledge": { tokens: 250, motivo: BASE },
  "crm_list_knowledge_sources": { tokens: 86, motivo: BASE },
  "crm_list_improvement_proposals": { tokens: 85, motivo: BASE },
  "crm_get_org_memory": { tokens: 114, motivo: BASE },
  "crm_save_org_memory": { tokens: 285, motivo: BASE },
  "crm_list_contact_orders": { tokens: 234, motivo: BASE },
  "crm_search_products": { tokens: 362, motivo: BASE },
  "crm_get_honorarios_contrato": { tokens: 253, motivo: BASE },
  "crm_list_honorarios_parcelas": { tokens: 222, motivo: BASE },
  "crm_preparar_proposta": { tokens: 132, motivo: BASE },
  "crm_describe_external_data": { tokens: 300, motivo: BASE },
  "crm_query_external_data": { tokens: 641, motivo: BASE },
  "crm_consultar_receita": { tokens: 403, motivo: BASE },
  "crm_list_privacy_requests": { tokens: 248, motivo: BASE },
  "crm_get_prospecting_site_audit": { tokens: 220, motivo: BASE },
  "crm_list_stages": { tokens: 255, motivo: BASE },
  "crm_list_tags": { tokens: 111, motivo: BASE },
  "crm_list_message_templates": { tokens: 146, motivo: BASE },
  "crm_render_message_template": { tokens: 597, motivo: BASE },
  "crm_list_webhook_sources": { tokens: 82, motivo: BASE },
  "crm_list_webhook_source_events": { tokens: 229, motivo: BASE },
  "crm_list_automation_rules": { tokens: 99, motivo: BASE },
  "crm_list_automation_runs": { tokens: 229, motivo: BASE },
  "crm_list_team_members": { tokens: 154, motivo: BASE },
  "crm_list_followups": { tokens: 472, motivo: BASE },
  "crm_list_at_risk_leads": {
    tokens: 255,
    motivo:
      "+6 da dica do argumento (o contact_id do item), devolvida quando o nome da ferramenta de retorno saiu da descrição: o Operador e o MCP externo dependem dela",
  },
  "crm_list_available_attendants": { tokens: 179, motivo: BASE },
  "crm_list_human_cases": { tokens: 149, motivo: BASE },
  "crm_get_human_case": { tokens: 208, motivo: BASE },
  "crm_find_and_book_appointment": { tokens: 1028, motivo: BASE },
  "crm_book_appointment": { tokens: 1203, motivo: BASE },
  "crm_reschedule_appointment": { tokens: 572, motivo: BASE },
  "crm_cancel_appointment": { tokens: 275, motivo: BASE },
  "crm_confirm_appointment": { tokens: 318, motivo: BASE },
  "crm_set_appointment_outcome": { tokens: 263, motivo: BASE },
  "crm_create_lead": { tokens: 933, motivo: BASE },
  "crm_update_lead": { tokens: 817, motivo: BASE },
  "crm_move_lead_stage": { tokens: 380, motivo: BASE },
  "crm_retomar_lead": { tokens: 394, motivo: BASE },
  "crm_propose_lead_fields_from_document": { tokens: 583, motivo: BASE },
  "crm_send_whatsapp_message": { tokens: 281, motivo: BASE },
  "crm_publish_whatsapp_status": { tokens: 464, motivo: "ferramenta nova do módulo opcional status_whatsapp (#3463), medida na criação (2026-11-10); só é oferecida com o módulo ligado" },
  "crm_start_conversation_and_send": { tokens: 593, motivo: BASE },
  "crm_create_conversation_draft": { tokens: 411, motivo: BASE },
  "crm_set_conversation_sector": { tokens: 383, motivo: "capacidade nova (#3881): a triagem da IA escolhe a FILA da conversa; a descrição precisa nomear os setores de exemplo e as recusas, senão o modelo tenta resolver fila com crm_assign_conversation (que é dono, não setor)" },
  "crm_assign_conversation": { tokens: 380, motivo: "+26 da frase que diz ao modelo que atribuir não interrompe o próprio turno e pode ir junto com a passagem (#3926, veio da main)" },
  "crm_manage_tags": { tokens: 229, motivo: BASE },
  "crm_create_stage": { tokens: 212, motivo: BASE },
  "crm_update_stage": { tokens: 611, motivo: BASE },
  "crm_archive_stage": { tokens: 454, motivo: BASE },
  "crm_create_webhook_source": { tokens: 363, motivo: BASE },
  "crm_set_webhook_source_active": { tokens: 199, motivo: BASE },
  "crm_set_automation_rule_active": { tokens: 232, motivo: BASE },
  "crm_schedule_followup": { tokens: 539, motivo: BASE },
  "crm_enroll_followup_flow": { tokens: 365, motivo: BASE },
  "crm_cancel_followup": { tokens: 254, motivo: BASE },
  "crm_close_demand": { tokens: 244, motivo: BASE },
  "crm_propose_reactivation": { tokens: 204, motivo: BASE },
  "crm_add_case_note": { tokens: 216, motivo: BASE },
  "crm_close_human_case": { tokens: 246, motivo: BASE },
  "crm_resume_ai_attendance": { tokens: 228, motivo: BASE },
  "crm_draft_proposal": { tokens: 1059, motivo: BASE },
  "crm_request_human_handoff": { tokens: 583, motivo: BASE },
  "get_lead_context": { tokens: 46, motivo: BASE },
  "send_message": { tokens: 191, motivo: "imagem_url (Spec 25 R4): a foto por endereço, com a regra de procedência na descrição" },
  "update_lead_state": { tokens: 240, motivo: BASE },
  "schedule_followup": { tokens: 200, motivo: BASE },
  "save_lead_note": { tokens: 229, motivo: BASE },
  "get_lead_note": { tokens: 99, motivo: BASE },
  "search_knowledge": { tokens: 131, motivo: BASE },
  // #4133: nasceu com o modo `leitura_direta` (índice no contexto + leitura do
  // documento pelo id). Entra no lugar da busca quando o agente escolhe o modo;
  // o teto é o da primeira medição, sem gordura.
  "ler_documento": { tokens: 142, motivo: "ferramenta nova do modo leitura_direta (#4133), medida na criação (2026-11-06)" },
  "request_human_handoff": { tokens: 510, motivo: BASE },
  "read_skill_reference": { tokens: 154, motivo: BASE },
  "open_human_case": { tokens: 384, motivo: BASE },
  "provide_case_update": { tokens: 102, motivo: BASE },
  "send_template": { tokens: 227, motivo: BASE },
  "schedule_followup (com negócio)": { tokens: 314, motivo: BASE },
};

// 29952 até 2026-11-05; +142 com `ler_documento` (#4133), que só é montada no
// modo `leitura_direta` — nunca junto de `search_knowledge`; +54 com `imagem_url`
// no `send_message` (Spec 25 R4, #3276); +464 com `crm_publish_whatsapp_status`
// (#3463), que só entra no catálogo com o módulo `status_whatsapp` ligado.
const TETO_TOTAL = 30612;

const VARIANTE = "schedule_followup (com negócio)";

const FERRAMENTAS: ReadonlyArray<{
  chave: string;
  nome: string;
  description: string;
  schema: FlexibleSchema<unknown>;
}> = [
  ...allTools.map((t) => ({
    chave: t.name,
    nome: t.name,
    description: t.description,
    schema: shapeToZodObject(t.inputSchema as Record<string, z.ZodTypeAny>),
  })),
  ...Object.entries(AGENT_TOOL_DEFS).map(([nome, d]) => ({
    chave: nome,
    nome,
    description: d.description,
    schema: d.inputSchema,
  })),
  {
    chave: VARIANTE,
    nome: "schedule_followup",
    description: SCHEDULE_FOLLOWUP_COM_NEGOCIO.description,
    schema: SCHEDULE_FOLLOWUP_COM_NEGOCIO.inputSchema,
  },
];

async function medir(): Promise<Map<string, number>> {
  const medidas = new Map<string, number>();
  for (const f of FERRAMENTAS) {
    const parameters = await esquemaParaOProvedor(f.schema, { semPadrao: ESQUEMA_SEM_PADRAO_PADRAO });
    medidas.set(f.chave, countTokens(JSON.stringify({ name: f.nome, description: f.description, parameters })));
  }
  return medidas;
}

/** A tabela como ela deveria estar — vai na mensagem de erro, pronta para colar. */
function tabelaSugerida(medidas: Map<string, number>): string {
  const linhas = [...medidas].map(([chave, n]) => {
    const motivo = TETO[chave]?.motivo;
    return `  ${JSON.stringify(chave)}: { tokens: ${n}, motivo: ${motivo === undefined || motivo === BASE ? "BASE" : JSON.stringify(motivo)} },`;
  });
  const total = [...medidas.values()].reduce((a, b) => a + b, 0);
  return `\nconst TETO = {\n${linhas.join("\n")}\n};\nconst TETO_TOTAL = ${total};\n`;
}

describe("o peso de cada ferramenta tem teto", () => {
  it("guarda de vacuidade: a cerca alcança o catálogo, as nativas e a variante", async () => {
    const medidas = await medir();
    expect(medidas.size).toBeGreaterThan(50);
    expect(medidas.has("crm_list_appointments")).toBe(true);
    expect(medidas.has("send_message")).toBe(true);
    expect(medidas.has(VARIANTE)).toBe(true);
  });

  it("⭐ cada ferramenta cabe no próprio teto, e a catraca não deixa o teto sobrar", async () => {
    const medidas = await medir();
    const problemas: string[] = [];
    for (const [chave, n] of medidas) {
      const teto = TETO[chave];
      if (teto === undefined) problemas.push(`${chave}: sem teto (mede ${n})`);
      else if (n > teto.tokens)
        problemas.push(`${chave}: cresceu ${n - teto.tokens} (mede ${n}, teto ${teto.tokens}) — suba o teto E reescreva o motivo`);
      else if (n < 0.9 * teto.tokens)
        problemas.push(`${chave}: mede ${n}, abaixo de 90% do teto ${teto.tokens} — desça o teto`);
    }
    for (const chave of Object.keys(TETO)) {
      if (!medidas.has(chave)) problemas.push(`${chave}: teto sem ferramenta — apague a linha`);
    }
    expect(problemas, tabelaSugerida(medidas)).toEqual([]);
  });

  it("a soma cabe em TETO_TOTAL", async () => {
    const medidas = await medir();
    const total = [...medidas.values()].reduce((a, b) => a + b, 0);
    expect(total, tabelaSugerida(medidas)).toBeLessThanOrEqual(TETO_TOTAL);
  });
});
