/**
 * `podeGastarComIa` — a pergunta do teto para tarefa lateral (o clima).
 *
 * A decisão em si é `decidirOrcamento`, provada em
 * `tests/unit/orcamento-decisao.test.ts`. Aqui se mede a LIGAÇÃO: que o estado
 * certo chega à decisão, que o atalho do modo `off` não gasta leitura, e que
 * toda falha de leitura erra para o lado que SEGUE.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/ai/budget/check", () => ({ getBudgetStatus: vi.fn() }));

import { getBudgetStatus, type BudgetStatus } from "@/lib/ai/budget/check";
import { podeGastarComIa } from "@/lib/ai/budget/pode-gastar";
import { createAdminClient } from "@/lib/supabase/admin";

const ORG = "11111111-1111-4111-8111-111111111111";
const ONTEM = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

function status(over: Partial<BudgetStatus> = {}): BudgetStatus {
  return {
    organization_id: ORG,
    monthly_limit_cents: 1000,
    current_month_consumed_cents: 1500,
    pct: 150,
    alarm_threshold_pct: 80,
    enforcement_mode: "bloquear",
    enforcement_effective_at: ONTEM,
    enforcement_env: "on",
    blocked_now: false,
    gasto_incompleto: false,
    current_period_start: "2026-10-01",
    last_alarm_sent_at: null,
    updated_at: new Date().toISOString(),
    ...over,
  };
}

/** Admin de brinquedo: a linha de `ai_budgets` e a contagem de avisos do mês. */
function admin(o: {
  modo?: string | null;
  erroDaLinha?: string;
  avisosNoMes?: number;
  erroDoAviso?: string;
}) {
  const from = (tabela: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = new Proxy(
      {},
      {
        get: (_a, prop: string) => {
          if (prop === "maybeSingle") {
            return async () =>
              o.erroDaLinha
                ? { data: null, error: { message: o.erroDaLinha } }
                : { data: o.modo === undefined ? null : { enforcement_mode: o.modo }, error: null };
          }
          if (prop === "then" && tabela === "agent_inbox_items") {
            return (ok: (v: unknown) => unknown) =>
              Promise.resolve(
                o.erroDoAviso
                  ? { count: null, error: { message: o.erroDoAviso } }
                  : { count: o.avisosNoMes ?? 0, error: null },
              ).then(ok);
          }
          if (prop === "then") return undefined;
          return () => chain;
        },
      },
    );
    return chain;
  };
  vi.mocked(createAdminClient).mockReturnValue({ from } as unknown as ReturnType<typeof createAdminClient>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBudgetStatus).mockResolvedValue(status());
});

describe("podeGastarComIa", () => {
  it("bloquear + teto estourado + já avisado no mês: NÃO pode (controle positivo)", async () => {
    admin({ modo: "bloquear", avisosNoMes: 1 });
    expect(await podeGastarComIa(ORG, "sentiment_classify")).toEqual({
      pode: false,
      porque: "teto_atingido",
      gastoCents: 1500,
      tetoCents: 1000,
    });
  });

  it("organização sem linha em ai_budgets segue, sem ler o snapshot completo", async () => {
    admin({ modo: undefined });
    expect(await podeGastarComIa(ORG, "sentiment_classify")).toEqual({
      pode: true,
      porque: "modo_desligado",
    });
    expect(getBudgetStatus).not.toHaveBeenCalled();
  });

  it("modo off segue sem ler o snapshot completo", async () => {
    admin({ modo: "off" });
    expect((await podeGastarComIa(ORG, "sentiment_classify")).pode).toBe(true);
    expect(getBudgetStatus).not.toHaveBeenCalled();
  });

  it("modo 'só avisar' com o teto estourado SEGUE", async () => {
    admin({ modo: "avisar", avisosNoMes: 1 });
    vi.mocked(getBudgetStatus).mockResolvedValue(status({ enforcement_mode: "avisar" }));
    expect(await podeGastarComIa(ORG, "sentiment_classify")).toEqual({
      pode: true,
      porque: "avisar_e_seguir",
    });
  });

  it("bloquear sem aviso no mês SEGUE — ninguém é parado sem ter sido avisado (condição 6)", async () => {
    admin({ modo: "bloquear", avisosNoMes: 0 });
    expect((await podeGastarComIa(ORG, "sentiment_classify")).pode).toBe(true);
  });

  it("chave de emergência da instalação em off SEGUE mesmo armado e estourado", async () => {
    admin({ modo: "bloquear", avisosNoMes: 1 });
    vi.mocked(getBudgetStatus).mockResolvedValue(status({ enforcement_env: "off" }));
    expect((await podeGastarComIa(ORG, "sentiment_classify")).pode).toBe(true);
  });

  it("leitura do modo falha: SEGUE", async () => {
    admin({ erroDaLinha: "conexão recusada" });
    expect(await podeGastarComIa(ORG, "sentiment_classify")).toEqual({
      pode: true,
      porque: "leitura_falhou",
    });
  });

  it("contagem de avisos falha: SEGUE (resolve para 'não avisou')", async () => {
    admin({ modo: "bloquear", erroDoAviso: "timeout" });
    expect((await podeGastarComIa(ORG, "sentiment_classify")).pode).toBe(true);
  });

  it("admin client lança (env faltando): SEGUE, nunca propaga", async () => {
    vi.mocked(createAdminClient).mockImplementation(() => {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY ausente");
    });
    expect(await podeGastarComIa(ORG, "sentiment_classify")).toEqual({
      pode: true,
      porque: "leitura_falhou",
    });
  });
});
