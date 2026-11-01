/**
 * A ação `set_lead_date_field` grava o DIA do atendimento no campo de data do
 * negócio — o dia do relógio da ORGANIZAÇÃO, no card do atendimento, sem tocar
 * na vaga de "um follow-up vivo por contato" (#3727).
 *
 * ─── O que este teste morde, e por que cada caso existe ────────────────────
 *
 * 1. FUSO. `2026-03-10T02:30:00Z` é 09/03 às 23h30 em Brasília. A varredura do
 *    gatilho de data compara com `diaLocal` no fuso do tenant; gravar o dia UTC
 *    (10/03) adiaria a mensagem da manutenção em um dia — e ninguém ligaria o
 *    atraso a esta linha. É o caso que a sabotagem derruba.
 * 2. ALVO. O evento `appointment.completed` não traz o negócio no contexto, e o
 *    compromisso não tem `lead_id`: sem o degrau do card aberto do contato a
 *    ação ficaria inútil justamente no gatilho da issue.
 * 3. CAMPO. Chave que não é data do NEGÓCIO (texto, ou campo de contato) é
 *    recusada ANTES da escrita: a varredura só lê `crm_leads.custom_fields`, e
 *    gravar ali onde ela não olha é a regra que existe e nunca dispara.
 * 4. A REGRA DE UM FOLLOW-UP VIVO POR CONTATO. Esta ação não inscreve ninguém
 *    em follow-up nenhum — nada aqui cria `followup_enrollments`, e é por isso
 *    que uma espera de quatro meses não ocupa a vaga única do contato.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionCtx } from "@/lib/automation/types";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { audit } from "@/lib/audit";
import { getAction } from "@/lib/automation/actions";
import "@/lib/automation/actions/set-lead-date-field";

const auditoria = vi.mocked(audit);

type Resposta = { data: unknown; error: { message: string } | null };

/**
 * Um dublê de Supabase que só sabe o que esta ação usa: cadeia de `select`
 * (`.eq().eq().maybeSingle()`) e `rpc`.
 *
 * `entregas` é o que cada TABELA responde — a tabela é identificada no `from` e
 * o resto da cadeia devolve o mesmo objeto, como o PostgREST. `tabelasLidas`
 * existe para provar o que a ação NÃO toca (caso 4).
 */
function adminFalso(entregas: Record<string, Resposta | (() => Resposta)>) {
  const tabelasLidas: string[] = [];
  const rpc: Array<{ nome: string; args: Record<string, unknown> }> = [];
  let respostaDoRpc: Resposta = { data: { data_toxina: "2026-03-09" }, error: null };

  const cadeia = (tabela: string) => {
    const api: Record<string, unknown> = {};
    for (const metodo of ["select", "eq", "order", "limit", "in"]) {
      api[metodo] = () => api;
    }
    api.maybeSingle = async () => {
      const entrega = entregas[tabela] ?? { data: null, error: null };
      return typeof entrega === "function" ? entrega() : entrega;
    };
    // Consulta aguardada sem terminal (`await admin.from(...).select(...)`) não
    // acontece nesta ação, mas o `then` evita um falso "não é promessa".
    api.then = (ok: (v: Resposta) => unknown, erro: (e: unknown) => unknown) => {
      const entrega = entregas[tabela] ?? { data: null, error: null };
      return Promise.resolve(typeof entrega === "function" ? entrega() : entrega).then(ok, erro);
    };
    return api;
  };

  const admin = {
    from: (tabela: string) => {
      tabelasLidas.push(tabela);
      return cadeia(tabela);
    },
    rpc: async (nome: string, args: Record<string, unknown>) => {
      rpc.push({ nome, args });
      return respostaDoRpc;
    },
  };

  return {
    admin: admin as unknown as ActionCtx["admin"],
    tabelasLidas,
    rpc,
    responderRpc: (resposta: Resposta) => {
      respostaDoRpc = resposta;
    },
  };
}

const FUNIL = "11111111-1111-4111-8111-111111111111";
const CONFIG = { pipeline_id: FUNIL, campo: "data_toxina" };

/** O funil com o campo de data do negócio declarado (a mesma forma do settings). */
const SETTINGS_COM_DATA = {
  fields: [{ key: "data_toxina", label: "Data da toxina", type: "date" }],
};

function ctxDe(
  admin: ActionCtx["admin"],
  contexto: Record<string, unknown>,
): ActionCtx {
  return {
    admin,
    organizationId: "org-1",
    ruleId: "rule-1",
    ruleName: "Manutenção da toxina",
    requestId: "evt-1",
    event: {
      id: "evt-1",
      organization_id: "org-1",
      event_type: "appointment.completed",
      entity_kind: "calendar_appointment",
      entity_id: "ap-1",
      payload: {},
      metadata: {},
      consumed_by: [],
      attempts: 0,
    },
    context: contexto,
  };
}

const COMPROMISSO = { id: "ap-1", starts_at: "2026-03-10T02:30:00Z", contact_id: "c-1" };

describe("set_lead_date_field: o dia do atendimento no campo do negócio", () => {
  beforeEach(() => auditoria.mockClear());

  it("grava o dia do relógio da ORGANIZAÇÃO (23h30 de Brasília não vira o dia seguinte)", async () => {
    const fake = adminFalso({
      organizations: { data: { timezone: "America/Sao_Paulo" }, error: null },
      crm_pipelines: { data: { settings: SETTINGS_COM_DATA }, error: null },
      crm_leads: { data: { id: "lead-aberto" }, error: null },
    });

    const resultado = await getAction("set_lead_date_field")!.execute(
      ctxDe(fake.admin, { appointment: COMPROMISSO, contact: { id: "c-1" } }),
      CONFIG,
    );

    expect(resultado).toEqual({
      type: "set_lead_date_field",
      status: "success",
      detail: { lead_id: "lead-aberto", campo: "data_toxina", data: "2026-03-09" },
    });
    // A escrita é a função do banco (0502), não um merge montado aqui.
    expect(fake.rpc).toEqual([
      {
        nome: "fn_lead_anotar_campos",
        args: { p_org: "org-1", p_lead: "lead-aberto", p_campos: { data_toxina: "2026-03-09" } },
      },
    ]);
    expect(auditoria).toHaveBeenCalledTimes(1);
  });

  it("sem negócio no evento, grava no card ABERTO do contato no funil escolhido", async () => {
    const fake = adminFalso({
      organizations: { data: { timezone: "America/Sao_Paulo" }, error: null },
      crm_pipelines: { data: { settings: SETTINGS_COM_DATA }, error: null },
      // `negocioAbertoDoContato`: o card aberto do contato NAQUELE funil.
      crm_leads: { data: { id: "lead-c-1" }, error: null },
    });

    const resultado = await getAction("set_lead_date_field")!.execute(
      ctxDe(fake.admin, { appointment: COMPROMISSO, contact: { id: "c-1" } }),
      CONFIG,
    );

    expect(resultado.status).toBe("success");
    expect(fake.rpc[0]?.args.p_lead).toBe("lead-c-1");
    expect(fake.tabelasLidas).toContain("crm_leads");
  });

  it("campo que não é DATA do negócio não é gravado — a varredura nunca o leria", async () => {
    const fake = adminFalso({
      organizations: { data: { timezone: "America/Sao_Paulo" }, error: null },
      crm_pipelines: {
        data: { settings: { fields: [{ key: "data_toxina", label: "Obs", type: "text" }] } },
        error: null,
      },
      crm_leads: { data: { id: "lead-aberto" }, error: null },
    });

    const resultado = await getAction("set_lead_date_field")!.execute(
      ctxDe(fake.admin, { appointment: COMPROMISSO, contact: { id: "c-1" } }),
      CONFIG,
    );

    expect(resultado).toEqual({
      type: "set_lead_date_field",
      status: "skipped",
      detail: { reason: "campo_nao_e_data" },
    });
    expect(fake.rpc).toEqual([]);
    expect(auditoria).not.toHaveBeenCalled();
  });

  it("sem compromisso no contexto não grava nada (a data do atendimento não é 'hoje')", async () => {
    const fake = adminFalso({
      organizations: { data: { timezone: "America/Sao_Paulo" }, error: null },
      crm_pipelines: { data: { settings: SETTINGS_COM_DATA }, error: null },
    });

    const resultado = await getAction("set_lead_date_field")!.execute(
      ctxDe(fake.admin, { lead: { id: "lead-1", pipeline_id: FUNIL } }),
      CONFIG,
    );

    expect(resultado).toEqual({
      type: "set_lead_date_field",
      status: "skipped",
      detail: { reason: "sem_compromisso" },
    });
    expect(fake.rpc).toEqual([]);
  });

  it("não inscreve ninguém em follow-up: a vaga de 'um follow-up vivo por contato' fica livre", async () => {
    const fake = adminFalso({
      organizations: { data: { timezone: "America/Sao_Paulo" }, error: null },
      crm_pipelines: { data: { settings: SETTINGS_COM_DATA }, error: null },
      crm_leads: { data: { id: "lead-aberto" }, error: null },
    });

    await getAction("set_lead_date_field")!.execute(
      ctxDe(fake.admin, { appointment: COMPROMISSO, contact: { id: "c-1" } }),
      CONFIG,
    );

    // A espera mora no CAMPO. Nenhuma tabela de follow-up é lida ou escrita, e o
    // único rpc é o que grava o campo — sem `followup_enrollments` não há índice
    // único a ocupar (`idx_followup_enrollments_one_live`).
    expect(fake.tabelasLidas).not.toContain("followup_enrollments");
    expect(fake.rpc.map((c) => c.nome)).toEqual(["fn_lead_anotar_campos"]);
  });
});
