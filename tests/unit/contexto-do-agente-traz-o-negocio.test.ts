import { describe, expect, it } from "vitest";

import { getLeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";
import { projetarContexto } from "@/lib/agent-engine/agent/projecao";

/**
 * O PRODUTOR entrega o negócio. Sem ele o modelo só tinha o id da PESSOA
 * (`lead_id`, issue #509) e o usava onde o CRM pede o do card.
 */
function dbFalso(negocios: unknown[] | Error) {
  return {
    query: async (sql: string) => {
      if (sql.includes("from contacts")) {
        return {
          rows: [
            {
              name: "Régis",
              display_name: null,
              email: null,
              phone_number: "+5516900000000",
              tags: [],
              is_blocked: false,
              source: "whatsapp",
              consent: null,
              is_anonymized: false,
            },
          ],
        };
      }
      if (sql.includes("from crm_leads l")) {
        if (negocios instanceof Error) throw negocios;
        return { rows: negocios };
      }
      return { rows: [] };
    },
  };
}

const KNOBS = { historyLimit: 20, maxTokens: 1_000 };
const ENTRADA = { tenantId: "org-1", leadId: "contato-9c9e", fuso: "America/Sao_Paulo" };
const NEGOCIO = {
  id: "negocio-aa12",
  organization_id: "org-1",
  pipeline_id: "funil-vendas",
  status: "open",
  last_activity_at: null,
  created_at: new Date("2026-10-01T22:14:27Z"),
  funil: "Vendas",
  etapa: "1. Entrada Lead",
};

describe("o contexto do agente traz o negócio", () => {
  it("com negócio aberto: negocio.id é o do card, e lead_id continua o da pessoa", async () => {
    const r = await getLeadContext(dbFalso([NEGOCIO]) as never, {} as never, ENTRADA, KNOBS);
    if (!r.ok) throw new Error("contexto não montou");
    expect(r.context.negocio).toEqual({ id: "negocio-aa12", funil: "Vendas", etapa: "1. Entrada Lead" });
    // Não renomeia: lead_id circula por outros caminhos (issue #509).
    expect(r.context.lead_id).toBe("contato-9c9e");
    expect(r.context.contact_id).toBe("contato-9c9e");
  });

  it("sem negócio aberto: a chave existe e vale null (ausente seria 'esqueceram de olhar')", async () => {
    const r = await getLeadContext(dbFalso([]) as never, {} as never, ENTRADA, KNOBS);
    if (!r.ok) throw new Error("contexto não montou");
    expect("negocio" in r.context).toBe(true);
    expect(r.context.negocio).toBeNull();
  });

  it("a projeção não deixa o id do negócio chegar ao modelo sem ferramentas", async () => {
    const r = await getLeadContext(dbFalso([NEGOCIO]) as never, {} as never, ENTRADA, KNOBS);
    if (!r.ok) throw new Error("contexto não montou");
    expect(JSON.stringify(projetarContexto(r.context))).not.toContain("negocio-aa12");
  });

  it("a consulta do negócio falha: o contexto monta mesmo assim, sem o negócio", async () => {
    // O negócio é complemento. Se a falha subisse, a pessoa ficaria SEM RESPOSTA
    // por causa de um dado opcional — o mesmo tratamento da proposta.
    const r = await getLeadContext(
      dbFalso(new Error("connection terminated")) as never,
      {} as never,
      ENTRADA,
      KNOBS,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.context.negocio).toBeNull();
  });
});
