/**
 * O que o primeiro agente da organização pode fazer no minuto em que nasce.
 *
 * Este conjunto não passa por revisão de ninguém: é o que a instalação entrega
 * pronta, e a maioria dos donos nunca abre a tela de capacidades. Por isso ele
 * precisa ser defensável sozinho — nem vazio (o funcionário que conversa e não
 * faz nada), nem largo demais (cada ferramenta a mais degrada a escolha do
 * modelo, que é a razão de o teto existir).
 */
import { describe, expect, it } from "vitest";

import {
  capacidadesPadraoDoOnboarding,
  catalogoComHandler,
  PACOTE_PADRAO_DO_ONBOARDING,
} from "@/lib/ai/agents/capacidades-padrao";
import { BLOCKED_TOOL_IDS } from "@/lib/agent-engine/edge/crm/mcp-tools";
import { TOOL_CATALOG } from "@/lib/mcp/tools/catalog";
import { TETO_TOOLS_POR_AGENTE, estadoDoPacote } from "@/lib/mcp/tools/selecao-por-pacote";

const IDS = capacidadesPadraoDoOnboarding({ academia: false });
const CATALOGO = catalogoComHandler({ academia: false });
const porNome = new Map(TOOL_CATALOG.map((c) => [c.name, c]));

describe("capacidades padrão do onboarding", () => {
  it("só liga a consulta da grade quando a organização tem o módulo Academia", () => {
    expect(capacidadesPadraoDoOnboarding({ academia: false })).not.toContain(
      "crm_find_academia_classes",
    );
    expect(capacidadesPadraoDoOnboarding({ academia: true })).toContain(
      "crm_find_academia_classes",
    );
  });

  it("não é vazio — o agente entregue precisa alcançar o CRM", () => {
    // O defeito de origem: `tool_ids='{}'` faz o turno não montar ferramenta
    // nenhuma, e o funil nunca anda.
    expect(IDS.length).toBeGreaterThan(0);
  });

  it("cabe no teto por agente", () => {
    expect(IDS.length).toBeLessThanOrEqual(TETO_TOOLS_POR_AGENTE);
  });

  it("todas existem no catálogo — nenhuma id inventada", () => {
    const fantasmas = IDS.filter((id) => !porNome.has(id));
    expect(fantasmas, "id que o catálogo não conhece nunca vira ferramenta").toEqual([]);
  });

  it("nenhuma é bloqueada pela ponte do turno", () => {
    // `crm_send_whatsapp_message` e `crm_request_human_handoff` são removidas
    // sempre (o envio e o handoff têm versão nativa, com as proteções). Deixar
    // uma delas aqui só produziria um aviso no log a cada turno.
    const bloqueadas = IDS.filter((id) => BLOCKED_TOOL_IDS.has(id));
    expect(bloqueadas).toEqual([]);
  });

  it("nenhuma é de risco crítico nem operada por pessoa", () => {
    const proibidas = IDS.filter((id) => {
      const c = porNome.get(id);
      return c?.risco === "critico" || c?.apenasHumano === true;
    });
    expect(
      proibidas,
      "efeito que não dá para desfazer, ou ação de pessoa, não entra num default",
    ).toEqual([]);
  });

  it("liga o pacote INTEIRO — meio pacote é uma lista que ninguém explica", () => {
    expect(estadoDoPacote(IDS, CATALOGO, PACOTE_PADRAO_DO_ONBOARDING)).toBe("ligado");
  });

  it("acompanha o catálogo em vez de congelar uma cópia", () => {
    // Guarda contra alguém trocar a derivação por uma lista fixa: o conjunto
    // tem de ser exatamente o que o pacote diz hoje, não o que ele dizia quando
    // isto foi escrito.
    const doPacote = CATALOGO.filter(
      (c) => c.pacotes.includes(PACOTE_PADRAO_DO_ONBOARDING) && c.risco !== "critico",
    ).map((c) => c.name);
    expect([...IDS].sort()).toEqual([...doPacote].sort());
  });
});
