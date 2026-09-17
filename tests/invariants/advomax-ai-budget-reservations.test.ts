import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "./psql-transporte";

const ORG = "a5000000-0000-4000-8000-000000000005";
const key = "a5100000-0000-4000-8000-000000000005";
const reserve = (id: string, model = "claude-sonnet-4") =>
  `select allowed || '|' || idempotent || '|' || reason from public.fn_reservar_orcamento_advomax_ia('${ORG}', '${id}', 'advomax:max', 'DEEPSEEK', '${model}', 60);`;

describe("reserva de orçamento IA do Advomax", () => {
  beforeAll(() => {
    sql(`insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'inv-advomax-ai', 'Advomax IA Teste', 'Advomax IA Teste');
      insert into public.ai_budgets (organization_id, monthly_limit_cents, enforcement_mode, enforcement_effective_at)
      values ('${ORG}', 100, 'bloquear', now() - interval '1 day')
      on conflict (organization_id) do update set monthly_limit_cents=100, enforcement_mode='bloquear', enforcement_effective_at=now()-interval '1 day';
      insert into public.agent_inbox_items (organization_id, kind, severity, title, body)
      values ('${ORG}', 'budget_warning', 'warn', 'Aviso', 'Aviso mensal');`);
  });

  it("serializa reservas, recusa conflito e finaliza uma vez", () => {
    expect(sql(reserve(key))).toBe("true|false|reserved");
    expect(sql(reserve(key))).toBe("true|true|already_reserved");
    expect(sql(reserve(key, "outro-modelo"))).toBe("false|false|idempotency_conflict");
    expect(sql(reserve("a5200000-0000-4000-8000-000000000005"))).toBe("false|false|monthly_limit_reached");
    const finalize = `select public.fn_finalizar_advomax_ia('${ORG}', '${key}', 'advomax:max', 'DEEPSEEK', 'claude-sonnet-4', 100, 100, 0, 0, 10, 40);`;
    expect(sql(finalize)).toBe("t");
    expect(sql(finalize)).toBe("f");
    expect(sql(`select count(*) from public.llm_calls where organization_id='${ORG}' and external_request_id='${key}';`)).toBe("1");
    expect(sql(`select status from public.advomax_ai_budget_reservations where organization_id='${ORG}' and external_request_id='${key}';`)).toBe("finalized");
  });

  it("não concede execução das funções nem acesso às reservas ao frontend", () => {
    expect(sql("select has_table_privilege('anon','public.advomax_ai_budget_reservations','SELECT');")).toBe("f");
    expect(sql("select has_table_privilege('authenticated','public.advomax_ai_budget_reservations','SELECT');")).toBe("f");
    expect(sql("select has_function_privilege('anon','public.fn_finalizar_advomax_ia(uuid,text,text,text,text,int,int,int,int,int,numeric)','EXECUTE');")).toBe("f");
  });

  it("não aceita consumo sem reserva do escritório", () => {
    expect(() => sql(`select public.fn_finalizar_advomax_ia('${ORG}', 'a5300000-0000-4000-8000-000000000005', 'advomax:max', 'DEEPSEEK', 'claude-sonnet-4', 1, 1, 0, 0, 1, 1);`))
      .toThrow(/advomax_ai_reservation_not_found/);
  });
});
