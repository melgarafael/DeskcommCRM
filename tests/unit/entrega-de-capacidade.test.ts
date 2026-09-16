import { describe, expect, it } from "vitest";

import {
  CAPACIDADES_DE_OPERACAO,
  EQUIVALENTE_NO_OPERADOR,
  capacidadesEntreguesAoOperador,
  catalogoEntregueAoOperador,
} from "@/lib/agent-engine/agent/entrega-de-capacidade";
import { AGENT_TOOL_DEFS, buildOpeningMessage } from "@/lib/agent-engine/agent/inbound-turn";
import type { LeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";
import { TOOL_CATALOG } from "@/lib/mcp/tools/catalog";

/**
 * Quando uma capacidade sai do Conversador (spec 16, passo 6 — a cura).
 *
 * O gate de vazamento é rede: barra na saída e ensina. A cura é o Conversador
 * nunca ter visto o vocabulário — o modelo não repete o nome de uma ferramenta
 * que não está no contexto dele. O sinal de sucesso do passo é o vazamento
 * medido em 30% ir a zero **por ausência, não por filtro**.
 */
describe("entrega de capacidade ao Operador", () => {
  it("papel DESLIGADO: nada sai — é o comportamento de todo self-hoster hoje", () => {
    // `operator_enabled` nasce false. Se o corte acontecesse mesmo desligado,
    // uma migration teria mudado o comportamento de quem não pediu nada.
    expect(
      capacidadesEntreguesAoOperador({
        operadorLigado: false,
        ferramentasDoOperador: ["crm_move_lead_stage"],
      }),
    ).toEqual([]);
  });

  it("papel LIGADO mas SEM o equivalente marcado: nada sai — a regra que impede o buraco", () => {
    // Este é o caso que justifica o módulo inteiro. Ligar o Operador e esquecer
    // de marcar `crm_move_lead_stage` tiraria o avanço do funil do Conversador
    // sem dar a ninguém — e o funil pararia de andar em silêncio, que é o modo
    // de falha que este épico existe para combater.
    expect(
      capacidadesEntreguesAoOperador({ operadorLigado: true, ferramentasDoOperador: [] }),
    ).toEqual([]);
  });

  it("papel LIGADO com o equivalente marcado: a capacidade muda de dono", () => {
    const saem = capacidadesEntreguesAoOperador({
      operadorLigado: true,
      ferramentasDoOperador: ["crm_move_lead_stage"],
    });
    expect(saem).toContain("update_lead_state");
  });

  it("cada capacidade sai por conta própria — marcar uma não leva a outra junto", () => {
    const saem = capacidadesEntreguesAoOperador({
      operadorLigado: true,
      ferramentasDoOperador: ["crm_move_lead_stage"],
    });
    // `schedule_followup` continua com o Conversador: seu equivalente não foi
    // marcado. Entregar em bloco perderia a promessa de retorno do lead.
    expect(saem).not.toContain("schedule_followup");
  });

  it("qualquer um dos equivalentes serve — o usuário não precisa adivinhar qual", () => {
    expect(
      capacidadesEntreguesAoOperador({
        operadorLigado: true,
        ferramentasDoOperador: ["crm_update_lead"],
      }),
    ).toContain("update_lead_state");
  });

  describe("o que NÃO pode ser entregue (medido contra o catálogo real)", () => {
    it.each(["save_lead_note", "open_human_case", "provide_case_update"])(
      "%s fica com o Conversador — não há equivalente no catálogo",
      (nativa) => {
        // A afirmação é medida, não copiada: se alguém expuser um equivalente no
        // catálogo, este teste vermelha e força a decisão de entregar.
        expect(Object.keys(EQUIVALENTE_NO_OPERADOR)).not.toContain(nativa);
        expect(
          capacidadesEntreguesAoOperador({
            operadorLigado: true,
            ferramentasDoOperador: TOOL_CATALOG.map((t) => t.name),
          }),
          `${nativa} saiu do Conversador sem ter quem a faça`,
        ).not.toContain(nativa);
      },
    );

    it("request_human_handoff fica — e não é por falta de equivalente", () => {
      // Ela EXISTE no catálogo, mas está bloqueada na ponte (a variante do
      // catálogo não silencia o harness). E passar a conversa para uma pessoa é
      // decisão sobre a CONVERSA, com efeito imediato: adiá-la ao turno seguinte
      // deixaria o assistente respondendo depois de o lead pedir um humano.
      expect(TOOL_CATALOG.map((t) => t.name)).toContain("crm_request_human_handoff");
      expect(Object.keys(EQUIVALENTE_NO_OPERADOR)).not.toContain("request_human_handoff");
    });
  });

  describe("a tabela de equivalência é honesta", () => {
    it("toda nativa listada existe de verdade no Conversador", () => {
      // Uma chave com typo nunca casaria, e a capacidade jamais sairia — o corte
      // não aconteceria, silenciosamente.
      for (const nativa of Object.keys(EQUIVALENTE_NO_OPERADOR)) {
        expect(Object.keys(AGENT_TOOL_DEFS), `${nativa} não é tool nativa`).toContain(nativa);
      }
    });

    it("todo equivalente listado existe de verdade no catálogo", () => {
      // Um equivalente inexistente faria a condição nunca ser satisfeita: o
      // usuário marcaria tudo e a capacidade continuaria nos dois lados.
      const nomes = TOOL_CATALOG.map((t) => t.name);
      for (const [nativa, equivalentes] of Object.entries(EQUIVALENTE_NO_OPERADOR)) {
        for (const e of equivalentes) {
          expect(nomes, `equivalente de ${nativa} não existe no catálogo: ${e}`).toContain(e);
        }
      }
    });

    it("send_message NUNCA é entregue — falar é do Conversador, por definição", () => {
      expect(Object.keys(EQUIVALENTE_NO_OPERADOR)).not.toContain("send_message");
      expect(
        capacidadesEntreguesAoOperador({
          operadorLigado: true,
          ferramentasDoOperador: TOOL_CATALOG.map((t) => t.name),
        }),
      ).not.toContain("send_message");
    });
  });

  describe("o NOME some do prompt — é isto que é a cura", () => {
    const contexto: LeadContext = {
      lead_id: "11111111-1111-4111-8111-111111111111",
      contact: { name: "Ana", phone: null, email: null, tags: [], is_blocked: false, custom_fields: {} },
      conversation_id: null,
      last_human_decision: null,
      messages: [],
    };

    function abertura(entregues: string[]): string {
      return buildOpeningMessage(null, null, contexto, "—", false, entregues);
    }

    it("com a capacidade entregue, o prompt não cita mais a ferramenta", () => {
      // O ponto do passo 6. Remover a ferramenta e MANTER a instrução seria o
      // pior dos dois mundos: o modelo tentaria chamar o que não existe, e o
      // nome continuaria no contexto — que é por onde o vazamento voltou quando
      // limparam só a descrição.
      expect(abertura(["update_lead_state"])).not.toContain("update_lead_state");
    });

    it("sem entrega, a instrução continua lá — nada muda para quem não ligou o papel", () => {
      expect(abertura([])).toContain("update_lead_state");
      expect(abertura([])).toContain("save_lead_note");
    });

    it("entregar uma não apaga a instrução da outra", () => {
      const texto = abertura(["update_lead_state"]);
      expect(texto).not.toContain("update_lead_state");
      expect(texto).toContain("save_lead_note");
    });

    it("send_message continua no prompt sempre — sem ela o turno não fala", () => {
      expect(abertura(["update_lead_state", "save_lead_note"])).toContain("send_message");
    });
  });

  describe("as ferramentas de CATÁLOGO que carregavam o vazamento", () => {
    // As sete da lista foram medidas: com elas 30,0%, sem elas 10,0%
    // (RELATORIO-passo6.md, ferramentas executadas, controle calibrado).
    const CONVERSADOR = [
      "crm_list_pipelines",
      "crm_list_stages",
      "crm_list_tags",
      "crm_list_webhook_sources",
      "crm_list_automation_rules",
      "crm_list_automation_runs",
      "crm_list_team_members",
      "crm_list_message_templates",
    ];

    it("papel desligado: nada sai, nem as de operação", () => {
      expect(
        catalogoEntregueAoOperador({
          operadorLigado: false,
          ferramentasDoOperador: CAPACIDADES_DE_OPERACAO,
          ferramentasDoConversador: CONVERSADOR,
        }),
      ).toEqual([]);
    });

    it("ligado mas sem a ferramenta marcada: ela NÃO sai — a capacidade nunca fica órfã", () => {
      expect(
        catalogoEntregueAoOperador({
          operadorLigado: true,
          ferramentasDoOperador: [],
          ferramentasDoConversador: CONVERSADOR,
        }),
      ).toEqual([]);
    });

    it("ligado e com elas marcadas: as SETE saem do Conversador", () => {
      const saem = catalogoEntregueAoOperador({
        operadorLigado: true,
        ferramentasDoOperador: CAPACIDADES_DE_OPERACAO,
        ferramentasDoConversador: CONVERSADOR,
      });
      // As duas que carregavam o dado que vazou.
      expect(saem).toContain("crm_list_automation_runs");
      expect(saem).toContain("crm_list_team_members");
    });

    it("o contexto de CONVERSA fica — tirar funil/etapa/marcador pioraria o atendimento", () => {
      const saem = catalogoEntregueAoOperador({
        operadorLigado: true,
        ferramentasDoOperador: [...CAPACIDADES_DE_OPERACAO, "crm_list_pipelines", "crm_list_stages"],
        ferramentasDoConversador: CONVERSADOR,
      });
      // Mesmo marcadas no Operador, estas não saem: trocar um vazamento por um
      // agente que não sabe onde o lead está é um mau negócio.
      expect(saem).not.toContain("crm_list_pipelines");
      expect(saem).not.toContain("crm_list_stages");
      expect(saem).not.toContain("crm_list_tags");
    });

    it("o toolset que sobra é EXATAMENTE o que foi medido em 10%", () => {
      // O laço que fecha código e medição: a configuração C da re-medição tirou
      // estas sete e mediu 1/10. Se a lista mudar sem nova medição, este caso
      // vermelha e força re-medir em vez de presumir.
      const saem = catalogoEntregueAoOperador({
        operadorLigado: true,
        ferramentasDoOperador: CAPACIDADES_DE_OPERACAO,
        ferramentasDoConversador: CONVERSADOR,
      });
      const sobra = CONVERSADOR.filter((t) => !saem.includes(t));
      expect(sobra.sort()).toEqual(["crm_list_pipelines", "crm_list_stages", "crm_list_tags"]);
    });
  });
});
