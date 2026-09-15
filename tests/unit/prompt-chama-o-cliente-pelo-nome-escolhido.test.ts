import { describe, expect, it } from "vitest";

import { renderSystemPrompt } from "@/lib/ai/render-system-prompt";
import type { BotContext } from "@/lib/ai/types";

/**
 * O `{{contact_name}}` do prompt lia só `display_name` — o nome do perfil do
 * WhatsApp. O operador corrigia o nome na ficha e o agente continuava chamando
 * o cliente pelo apelido (ou emoji) do perfil (issue #906).
 */
function contexto(contact: BotContext["contact"]): BotContext {
  return {
    organization_id: "org-1",
    conversation_id: "conv-1",
    contact_id: contact.id,
    channel_session_id: "sess-1",
    message_id: "msg-1",
    inbound_body: "oi",
    recent_messages: [],
    agent: {
      paused_at: null,
      id: "agent-1",
      model: "m",
      system_prompt: "",
      config: {},
      guardrails: {},
      active_kb_version_id: null,
    },
    contact,
    retrieved_chunks: [],
  };
}

describe("{{contact_name}} no prompt do agente", () => {
  it("usa o nome escolhido, não o do perfil do WhatsApp", () => {
    const ctx = contexto({ id: "c-1", name: "Kaio Gomes", display_name: "🌸 Kaio", locale: null });
    expect(renderSystemPrompt("Fale com {{contact_name}}.", ctx)).toBe("Fale com Kaio Gomes.");
  });

  it("sem nome escolhido, usa o do perfil", () => {
    const ctx = contexto({ id: "c-1", name: null, display_name: "Kaio", locale: null });
    expect(renderSystemPrompt("Fale com {{contact_name}}.", ctx)).toBe("Fale com Kaio.");
  });

  it("sem nome de gente, continua 'cliente'", () => {
    const ctx = contexto({ id: "c-1", name: null, display_name: "Contato 543134@lid", locale: null });
    expect(renderSystemPrompt("Fale com {{contact_name}}.", ctx)).toBe("Fale com cliente.");
  });
});
