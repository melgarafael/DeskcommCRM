import { describe, expect, it } from "vitest";

import { aplicarConfiguracoes } from "./configuracao-do-rascunho";
import type { LinhaDaVersao } from "./linha-da-versao";

const BASE = {
  system_prompt: "Você é o atendente da loja.",
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  credential_id: null,
  tool_ids: ["crm_search_contacts", "crm_get_contact"],
  trigger_config: null,
  channel_session_id: null,
  max_steps: 8,
  token_budget: 20000,
  cost_budget_cents: 50,
  history_message_window: 20,
  history_token_window: 8000,
  handoff_keywords: ["humano"],
  handoff_tool_enabled: true,
  handoff_legal_enabled: true,
  image_vision_enabled: true,
  proposal_ai_draft_enabled: false,
  cases_enabled: false,
  operator_enabled: false,
  operator_model: null,
  operator_tool_ids: [],
  pipeline_ids: [],
  knowledge_source_ids: [],
  skill_names: null,
  split_messages: false,
  split_max_chars: 600,
  inbound_debounce_ms: null,
  reply_min_interval_ms: null,
  followup: null,
  voz_enabled: false,
  voz_quando: "espelhar",
} as unknown as LinhaDaVersao;

describe("aplicarConfiguracoes", () => {
  it("liga a voz e diz o que mudou, sem tocar no resto", () => {
    const r = aplicarConfiguracoes(BASE, { voz_ligada: true, voz_quando: "sempre" });
    expect(r).toMatchObject({ ok: true, mudancas: ["voz_ligada", "voz_quando"] });
    if (r.ok) {
      expect(r.linha.voz_enabled).toBe(true);
      expect(r.linha.model).toBe("claude-sonnet-5-5");
      expect(r.linha.tool_ids).toEqual(BASE.tool_ids);
    }
  });

  it("adiciona e remove ferramentas na mesma mudança", () => {
    const r = aplicarConfiguracoes(BASE, { ferramentas_adicionar: ["crm_list_leads"], ferramentas_remover: ["crm_get_contact"] });
    expect(r.ok && r.linha.tool_ids).toEqual(["crm_search_contacts", "crm_list_leads"]);
  });

  it("recusa dar ao assistente uma ferramenta que é só do administrador", () => {
    const r = aplicarConfiguracoes(BASE, { ferramentas_adicionar: ["crm_publish_ai_agent_version"] });
    expect(r).toMatchObject({ ok: false, motivo: "ferramenta_so_do_administrador" });
  });

  it("recusa ferramenta que não existe", () => {
    expect(aplicarConfiguracoes(BASE, { ferramentas_adicionar: ["crm_inventada"] })).toMatchObject({
      ok: false,
      motivo: "ferramenta_desconhecida",
    });
  });

  it("recusa modelo que não é do provedor", () => {
    expect(aplicarConfiguracoes(BASE, { provedor: "anthropic", modelo: "gpt-5" })).toMatchObject({
      ok: false,
      motivo: "modelo_invalido",
    });
  });

  it("o que já está assim não conta como mudança", () => {
    expect(aplicarConfiguracoes(BASE, { voz_ligada: false, ver_imagens: true })).toMatchObject({ ok: true, mudancas: [] });
  });
});
