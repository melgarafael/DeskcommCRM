import { describe, expect, it } from "vitest";

import {
  SYSTEM_DO_OPERADOR,
  renderBriefingDoOperador,
} from "@/lib/agent-engine/agent/operator-turn";
import { AGENT_TOOL_DEFS } from "@/lib/agent-engine/agent/inbound-turn";
import { TOOL_CATALOG } from "@/lib/mcp/tools/catalog";
import { BLOCKED_TOOL_IDS } from "@/lib/agent-engine/edge/crm/mcp-tools";
import type { DeclaracaoDoTurno } from "@/lib/agent-engine/agent/declaracao";

/**
 * O papel Operador **não fala com o cliente** (spec 16 §3.2).
 *
 * A garantia é por AUSÊNCIA, não por instrução: o toolset dele é montado a partir
 * de `operator_tool_ids`, e nem `send_message` (nativa do engine) nem
 * `crm_send_whatsapp_message` (catálogo) podem entrar por lá. Um teste que só
 * checasse o texto do prompt estaria medindo a boa vontade do modelo.
 */
describe("o Operador não tem canal", () => {
  it("send_message é uma tool NATIVA do engine — não existe id de catálogo que a ligue", () => {
    // Esta é a asserção estrutural: as tools nativas (entre elas `send_message`)
    // são montadas à mão no turno do Conversador e NÃO vêm do catálogo. Como o
    // Operador monta o toolset dele exclusivamente pelo catálogo, `send_message`
    // não tem por onde chegar até ele.
    expect(Object.keys(AGENT_TOOL_DEFS)).toContain("send_message");
    expect(TOOL_CATALOG.map((t) => t.name)).not.toContain("send_message");
  });

  it("a tool de envio do catálogo é BLOQUEADA pela ponte, para qualquer papel", () => {
    // Controle positivo primeiro: a tool existe mesmo (o MCP externo a usa).
    // Sem ele, um typo no nome faria o teste passar medindo nada.
    expect(
      TOOL_CATALOG.map((t) => t.name),
      "controle: a tool de envio existe no catálogo",
    ).toContain("crm_send_whatsapp_message");

    // A asserção real: mesmo que alguém a marque em `operator_tool_ids`, a ponte
    // a recusa. É isto que faz "sem canal" ser estrutural em vez de confiança.
    expect(BLOCKED_TOOL_IDS.has("crm_send_whatsapp_message")).toBe(true);
  });

  it("o system do Operador é explícito sobre não falar — cinto, além da ausência", () => {
    expect(SYSTEM_DO_OPERADOR).toContain("NÃO FALA COM O CLIENTE");
  });

  it("o system do Operador PODE usar vocabulário de sistema — é o inverso do Conversador", () => {
    // A assimetria é o desenho inteiro da spec: no Conversador, "CRM" no prompt
    // é defeito medido (30%); aqui é vocabulário de trabalho, porque este texto
    // não tem como alcançar um cliente.
    expect(SYSTEM_DO_OPERADOR).toContain("CRM");
  });
});

describe("briefing do Operador", () => {
  it("declaração AUSENTE gera instrução diferente de declaração vazia", () => {
    // De novo a distinção do passo 2, agora virando texto: dizer "não houve
    // declaração" é diferente de deixar o modelo achar que o turno foi vazio.
    const ausente = renderBriefingDoOperador(null, []);
    expect(ausente).toContain("NÃO deixou declaração");
    expect(ausente).toContain("Na dúvida, não faça nada");
  });

  it("promessa com prazo chega com o prazo — é o que decide a ação", () => {
    const d: DeclaracaoDoTurno = {
      intencoes: [{ o_que: "quer remarcar", evidencia: "não posso terça" }],
      promessas: [{ o_que: "confirmar o horário", prazo: "2026-08-08T12:00:00Z" }],
      nada_a_declarar: false,
    };
    const texto = renderBriefingDoOperador(d, d.promessas);
    expect(texto).toContain("quer remarcar");
    expect(texto).toContain("confirmar o horário — até 2026-08-08T12:00:00Z");
  });

  it("a evidência viaja junto da intenção — sem ela o Operador agiria sobre afirmação sem lastro", () => {
    const d: DeclaracaoDoTurno = {
      intencoes: [{ o_que: "desistiu por preço", evidencia: "tá caro demais pra mim" }],
      promessas: [],
      nada_a_declarar: false,
    };
    expect(renderBriefingDoOperador(d, [])).toContain("tá caro demais pra mim");
  });

  it("manda não repetir o que já está registrado — o Conversador pode ter agido no mesmo turno", () => {
    // Enquanto os dois papéis convivem (spec 16, passo 4 roda em paralelo), esta
    // linha é o que evita ação em dobro.
    const d: DeclaracaoDoTurno = { intencoes: [], promessas: [], nada_a_declarar: false };
    expect(renderBriefingDoOperador(d, [])).toContain("não repita");
  });

  it("leva os identificadores REAIS do atendimento (o modelo não inventa UUID)", () => {
    const texto = renderBriefingDoOperador(null, [], "", {
      leadId: "11111111-1111-4111-8111-111111111111",
      contactId: "33333333-3333-4333-8333-333333333333",
      conversationId: "22222222-2222-4222-8222-222222222222",
    });
    // `lead_id` é o CARD do funil — diferente do contato.
    expect(texto).toContain("lead_id=11111111-1111-4111-8111-111111111111");
    expect(texto).toContain("contact_id=33333333-3333-4333-8333-333333333333");
    expect(texto).toContain("conversation_id=22222222-2222-4222-8222-222222222222");
    expect(texto).toContain("nunca invente");
    // Sem ids, nada é injetado (chamadores antigos não quebram).
    expect(renderBriefingDoOperador(null, [])).not.toContain("lead_id=");
  });

  it("sem card de funil: diz explicitamente para não chamar ferramenta de lead", () => {
    const texto = renderBriefingDoOperador(null, [], "", {
      leadId: null,
      contactId: "33333333-3333-4333-8333-333333333333",
      conversationId: "22222222-2222-4222-8222-222222222222",
    });
    expect(texto).toContain("lead_id=(sem card)");
    expect(texto).toContain("não chame ferramentas de lead");
  });
});
