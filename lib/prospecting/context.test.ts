import { describe, expect, it } from "vitest";

import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { prospectingConversationContext } from "@/lib/prospecting/context";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "99999999-9999-4999-8999-999999999999";
const CONVERSA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** Configuração de campanha válida; `extra` acrescenta ou troca chaves (ex.: `ofertas`). */
function configDaCampanha(extra: Record<string, unknown> = {}) {
  return {
    agent_id: "22222222-2222-4222-8222-222222222222",
    channel_session_id: "33333333-3333-4333-8333-333333333333",
    pipeline_id: "44444444-4444-4444-8444-444444444444",
    stage_id: "55555555-5555-4555-8555-555555555555",
    qualified_stage_id: "66666666-6666-4666-8666-666666666666",
    instruction: "Apresente o serviço para clínicas da região.",
    qualification: "Confirmar se a clínica recebe agendamentos pelo WhatsApp.",
    legal_basis_ref: "legitimo-interesse",
    ...extra,
  };
}

/** Banco falso: responde a linha da campanha e anota os parâmetros de cada consulta. */
function bancoCom(config: unknown, consultas: unknown[][]): Queryable {
  return {
    query: async (_sql: string, params: unknown[]) => {
      consultas.push(params);
      return { rows: [{ config, exit_offered_at: null }] };
    },
  } as unknown as Queryable;
}

const LINHA_DO_OFERTAS = "O que esta campanha vende, em ordem:";

describe("prospectingConversationContext — o que o agente lê sobre as ofertas", () => {
  it("três ofertas: a linha traz os três rótulos de tela, na ordem da campanha", async () => {
    const consultas: unknown[][] = [];
    const texto = await prospectingConversationContext(
      bancoCom(configDaCampanha({ ofertas: ["site", "automacao_crm", "automacao_n8n"] }), consultas),
      ORG_A,
      CONVERSA,
    );
    expect(texto).toContain(
      "O que esta campanha vende, em ordem: Site profissional; Automação do atendimento (CRM); Automações e integrações (N8N).",
    );
  });

  it("a ordem é a de prioridade gravada: quem vem primeiro na config vem primeiro no texto", async () => {
    const texto = await prospectingConversationContext(
      bancoCom(configDaCampanha({ ofertas: ["automacao_n8n", "site"] }), []),
      ORG_A,
      CONVERSA,
    );
    expect(texto).toContain(
      `${LINHA_DO_OFERTAS} Automações e integrações (N8N); Site profissional.`,
    );
  });

  it("campanha sem a chave `ofertas` (configuração de antes): vale o padrão, só 'Site profissional'", async () => {
    const texto = await prospectingConversationContext(bancoCom(configDaCampanha(), []), ORG_A, CONVERSA);
    expect(texto).toContain(`${LINHA_DO_OFERTAS} Site profissional.`);
    expect(texto).not.toContain("Automação do atendimento");
    expect(texto).not.toContain("Automações e integrações");
  });

  it("o resto do contexto fica como estava: a linha entra entre os critérios e a conversa natural", async () => {
    const texto = await prospectingConversationContext(
      bancoCom(configDaCampanha({ ofertas: ["site"] }), []),
      ORG_A,
      CONVERSA,
    );
    const posicaoDosCriterios = texto.indexOf("Critérios de qualificação a confirmar com a pessoa:");
    const posicaoDaLinha = texto.indexOf(LINHA_DO_OFERTAS);
    const posicaoDaConversa = texto.indexOf("Converse naturalmente, uma pergunta por vez.");
    expect(posicaoDosCriterios).toBeGreaterThan(0);
    expect(posicaoDaLinha).toBeGreaterThan(posicaoDosCriterios);
    expect(posicaoDaConversa).toBeGreaterThan(posicaoDaLinha);
    expect(texto).toContain("Objetivo definido pelo operador: Apresente o serviço para clínicas da região.");
  });

  it("isolamento: a consulta da campanha filtra pela organização recebida, não por outra", async () => {
    const consultas: unknown[][] = [];
    await prospectingConversationContext(bancoCom(configDaCampanha(), consultas), ORG_A, CONVERSA);
    expect(consultas).toHaveLength(1);
    expect(consultas[0]?.[0]).toBe(ORG_A);
    expect(consultas[0]).not.toContain(ORG_B);
  });
});
