import { describe, expect, it } from "vitest";

import { getLeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";

/**
 * O PRODUTOR sempre entrega a chave — mesmo quando não há decisão nenhuma.
 *
 * `last_human_decision` é opcional no tipo por causa do hook que congela
 * `tests/invariants/**` (um campo obrigatório obrigaria a editar o fixture de
 * um invariante existente). A garantia que interessa, porém, não é o fixture
 * declarar o campo: é `getLeadContext` nunca esquecer de preenchê-lo. Se
 * esquecer, o turno segue cego e o agente repropõe o que o humano acabou de
 * negar — o defeito que o bloco 4.5 existe para matar.
 *
 * Por isso o teste assere a presença da CHAVE (`in`), não a verdade do valor:
 * `undefined` e `null` significam coisas diferentes aqui. `null` é "ninguém
 * decidiu"; ausente é "esqueceram de olhar".
 */
interface Chamada {
  sql: string;
  params: unknown[];
}

function dbFalso(decisoes: unknown[], contato = [{ name: "Carlos" }]) {
  const chamadas: Chamada[] = [];
  return {
    chamadas,
    db: {
      query: async (sql: string, params: unknown[]) => {
        chamadas.push({ sql, params });
        if (sql.includes("from contacts")) {
          return {
            rows: contato.map(() => ({
              name: "Carlos",
              display_name: null,
              email: null,
              phone_number: "+5511900000000",
              tags: [],
              is_blocked: false,
              source: "whatsapp",
              consent: null,
              is_anonymized: false,
            })),
          };
        }
        if (sql.includes("from crm_lead_activities")) return { rows: decisoes };
        return { rows: [] }; // conversations / messages
      },
    },
  };
}

const KNOBS = { historyLimit: 20, maxTokens: 1_000 };
const ENTRADA = { tenantId: "org-1", leadId: "contato-1", fuso: "America/Sao_Paulo" };

describe("last_human_decision no contexto do turno", () => {
  it("a chave existe mesmo sem decisão nenhuma", async () => {
    const { db } = dbFalso([]);
    const r = await getLeadContext(db as never, {} as never, ENTRADA, KNOBS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // `in`, não truthiness: ausente e null dizem coisas diferentes.
    expect("last_human_decision" in r.context).toBe(true);
    expect(r.context.last_human_decision).toBeNull();
  });

  it("a decisão mais recente chega com ação, sentido e quando", async () => {
    const { db } = dbFalso([
      {
        type: "next_action_dismissed",
        payload: { next_action: "ligar para o Carlos amanhã" },
        reason: "Descartou: ligar para o Carlos amanhã",
        performed_at: "2026-07-25T10:23:35Z",
      },
    ]);
    const r = await getLeadContext(db as never, {} as never, ENTRADA, KNOBS);
    if (!r.ok) throw new Error("contexto falhou");
    expect(r.context.last_human_decision).toEqual({
      action: "ligar para o Carlos amanhã",
      decision: "dismissed",
      at: "2026-07-25T10:23:35Z",
    });
  });

  it("decisão sem o QUÊ não vira meia informação", async () => {
    // "aprovado" sem dizer o que foi aprovado não ajuda o próximo turno — e
    // mandar a metade seria pior que mandar nada, porque parece informação.
    const { db } = dbFalso([
      {
        type: "next_action_approved",
        payload: {},
        reason: "Aprovou: algo",
        performed_at: "2026-07-25T10:23:35Z",
      },
    ]);
    const r = await getLeadContext(db as never, {} as never, ENTRADA, KNOBS);
    if (!r.ok) throw new Error("contexto falhou");
    expect(r.context.last_human_decision).toBeNull();
  });

  it("a busca é escopada por org E contato — decisão de outro não vaza", async () => {
    const { db, chamadas } = dbFalso([]);
    await getLeadContext(db as never, {} as never, ENTRADA, KNOBS);
    const busca = chamadas.find((c) => c.sql.includes("from crm_lead_activities"));
    expect(busca).toBeDefined();
    expect(busca!.params).toEqual(["org-1", "contato-1"]);
    expect(busca!.sql).toContain("organization_id = $1");
    expect(busca!.sql).toContain("contact_id = $2");
  });
});
