/**
 * A ROTA QUE ESCREVE O TETO — que até aqui não tinha teste NENHUM.
 *
 * `ls app/api/v1/ai/budget/` devolvia só `route.ts`, e o único hit de
 * "api/v1/ai/budget" fora dela era `scripts/qa-wave-11.ts`, que nenhum job de CI
 * invoca. Uma mudança de semântica nesta rota atravessava `verify`,
 * `invariants`, `build-and-size` e `e2e` verdes.
 *
 * É a porta pela qual uma organização passa a poder PARAR a própria IA. O que
 * este arquivo prende:
 *
 *  1. **A escada** `off → avisar → bloquear`. O salto `off → bloquear` é 422 no
 *     SERVIDOR — uma regra que só vive no componente React não é regra.
 *  2. **O piso** de US$ 1,00 para armar, resolvido sobre o estado PÓS-escrita.
 *  3. **A auditoria**, que não existia: `grep -c "lib/audit"` nesta rota devolvia
 *     0, num endpoint que mexe em dinheiro e cala o atendimento.
 *  4. **O limiar 50..99** recusado pelo Zod (422 dizendo o campo) e não pelo
 *     CHECK do banco (23514 → 500 "Erro ao atualizar orçamento.", com o rollback
 *     otimista do hook desfazendo a mudança na tela — lê-se como "o app engoliu
 *     meu clique").
 *  5. **O laço de retorno**: afrouxar fecha os avisos abertos na hora.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getBudgetStatus, type BudgetStatus } from "@/lib/ai/budget/check";
import { createAdminClient } from "@/lib/supabase/admin";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/budget/check", () => ({ getBudgetStatus: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";
const ADMIN = "11111111-1111-4111-8111-111111111111";

const H72_MS = 72 * 60 * 60 * 1000;

function sessao(papel: Role) {
  const user: AuthUser = {
    id: ADMIN,
    email: "admin@example.com",
    full_name: "Admin",
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG, organization_name: "Org", role: papel }],
  };
  vi.mocked(requireRole).mockImplementation(async (min: Role) =>
    ROLE_RANK[papel] >= ROLE_RANK[min]
      ? { ok: true, user, org: { orgId: ORG, name: "Org", role: papel } }
      : { ok: false, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) },
  );
}

interface Escrita {
  tabela: string;
  op: "update" | "insert";
  payload: Record<string, unknown>;
}

/**
 * Dublê do admin client que GRAVA o que foi escrito — o teste precisa afirmar
 * sobre o payload, não só sobre o status HTTP: "devolveu 200" e "gravou a
 * carência certa" são perguntas diferentes.
 */
function fazerAdmin(opts: {
  linha: Record<string, unknown> | null;
  itensAbertos?: number;
}) {
  const escritas: Escrita[] = [];
  const from = (tabela: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      maybeSingle: async () => ({
        data: tabela === "ai_budgets" ? opts.linha : null,
        error: null,
      }),
      update: (payload: Record<string, unknown>) => {
        escritas.push({ tabela, op: "update", payload });
        return chain;
      },
      insert: (payload: Record<string, unknown>) => {
        escritas.push({ tabela, op: "insert", payload });
        return Promise.resolve({ data: null, error: null });
      },
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve({
          data:
            tabela === "agent_inbox_items"
              ? Array.from({ length: opts.itensAbertos ?? 0 }, (_, i) => ({ id: `item-${i}` }))
              : null,
          error: null,
        }).then(res),
    };
    return chain;
  };
  return { cliente: { from }, escritas };
}

function estadoDaTela(over: Partial<BudgetStatus> = {}): BudgetStatus {
  return {
    organization_id: ORG,
    monthly_limit_cents: 5000,
    current_month_consumed_cents: 0,
    pct: 0,
    alarm_threshold_pct: 80,
    enforcement_mode: "off",
    enforcement_effective_at: null,
    enforcement_env: "on",
    blocked_now: false,
    gasto_incompleto: false,
    current_period_start: "2026-08-01",
    last_alarm_sent_at: null,
    updated_at: "2026-08-15T00:00:00.000Z",
    ...over,
  };
}

async function patch(body: unknown): Promise<Response> {
  const { PATCH } = await import("@/app/api/v1/ai/budget/route");
  return PATCH(
    new NextRequest("http://localhost/api/v1/ai/budget", {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

async function corpo(res: Response): Promise<{
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details?: unknown };
}> {
  return (await res.json()) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBudgetStatus).mockResolvedValue(estadoDaTela());
});

describe("PATCH /api/v1/ai/budget", () => {
  describe("quem pode mexer", () => {
    for (const papel of ["viewer", "agent", "manager"] as const) {
      it(`${papel} recebe 403 — mexer no teto é decisão de admin`, async () => {
        sessao(papel);
        const { cliente } = fazerAdmin({ linha: null });
        vi.mocked(createAdminClient).mockReturnValue(
          cliente as unknown as ReturnType<typeof createAdminClient>,
        );
        const res = await patch({ monthly_limit_cents: 10_000 });
        expect(res.status).toBe(403);
      });
    }
  });

  describe("a escada — a fase de aviso não é pulável", () => {
    it("off → bloquear é 422, não 500 e não sucesso", async () => {
      sessao("admin");
      const { cliente, escritas } = fazerAdmin({
        linha: {
          monthly_limit_cents: 5000,
          alarm_threshold_pct: 80,
          enforcement_mode: "off",
          enforcement_effective_at: null,
        },
      });
      vi.mocked(createAdminClient).mockReturnValue(
        cliente as unknown as ReturnType<typeof createAdminClient>,
      );

      const res = await patch({ enforcement_mode: "bloquear" });

      expect(res.status).toBe(422);
      expect((await corpo(res)).error?.code).toBe("invalid_state_transition");
      // Recusar e gravar mesmo assim seria pior que aceitar: a tela mostraria o
      // erro e o banco teria a parada armada.
      expect(escritas).toEqual([]);
      expect(vi.mocked(audit)).not.toHaveBeenCalled();
    });

    it("avisar → bloquear grava a carência de 72h", async () => {
      sessao("admin");
      const { cliente, escritas } = fazerAdmin({
        linha: {
          monthly_limit_cents: 5000,
          alarm_threshold_pct: 80,
          enforcement_mode: "avisar",
          enforcement_effective_at: null,
        },
      });
      vi.mocked(createAdminClient).mockReturnValue(
        cliente as unknown as ReturnType<typeof createAdminClient>,
      );

      const antes = Date.now();
      const res = await patch({ enforcement_mode: "bloquear" });
      expect(res.status).toBe(200);

      const escrita = escritas.find((e) => e.tabela === "ai_budgets");
      expect(escrita?.op).toBe("update");
      expect(escrita?.payload.enforcement_mode).toBe("bloquear");
      const efetivo = new Date(String(escrita?.payload.enforcement_effective_at)).getTime();
      expect(efetivo - antes).toBeGreaterThanOrEqual(H72_MS - 60_000);
      expect(efetivo - antes).toBeLessThanOrEqual(H72_MS + 60_000);
    });

    it("confirmar_imediato renuncia à carência — e é escolha explícita, não default", async () => {
      sessao("admin");
      const { cliente, escritas } = fazerAdmin({
        linha: {
          monthly_limit_cents: 5000,
          alarm_threshold_pct: 80,
          enforcement_mode: "avisar",
          enforcement_effective_at: null,
        },
      });
      vi.mocked(createAdminClient).mockReturnValue(
        cliente as unknown as ReturnType<typeof createAdminClient>,
      );

      const antes = Date.now();
      const res = await patch({ enforcement_mode: "bloquear", confirmar_imediato: true });
      expect(res.status).toBe(200);

      const escrita = escritas.find((e) => e.tabela === "ai_budgets");
      const efetivo = new Date(String(escrita?.payload.enforcement_effective_at)).getTime();
      expect(efetivo - antes).toBeLessThan(60_000);
    });
  });

  describe("o piso — armado sem valor útil não passa pela porta da frente", () => {
    it("armar com teto de US$ 0,50 é 422 e nomeia o piso", async () => {
      sessao("admin");
      const { cliente, escritas } = fazerAdmin({
        linha: {
          monthly_limit_cents: 5000,
          alarm_threshold_pct: 80,
          enforcement_mode: "avisar",
          enforcement_effective_at: null,
        },
      });
      vi.mocked(createAdminClient).mockReturnValue(
        cliente as unknown as ReturnType<typeof createAdminClient>,
      );

      const res = await patch({ enforcement_mode: "bloquear", monthly_limit_cents: 50 });

      expect(res.status).toBe(422);
      const body = await corpo(res);
      expect(body.error?.code).toBe("unprocessable_entity");
      expect(body.error?.message).toContain("US$ 1,00");
      expect(escritas).toEqual([]);
    });

    it("quem JÁ está armado não consegue derrubar o teto abaixo do piso", async () => {
      // O piso é resolvido sobre o estado PÓS-escrita: sem isso, bastaria armar
      // hoje com teto válido e zerar o teto amanhã, num PATCH que não fala de
      // modo nenhum.
      sessao("admin");
      const { cliente, escritas } = fazerAdmin({
        linha: {
          monthly_limit_cents: 5000,
          alarm_threshold_pct: 80,
          enforcement_mode: "bloquear",
          enforcement_effective_at: "2026-08-01T00:00:00.000Z",
        },
      });
      vi.mocked(createAdminClient).mockReturnValue(
        cliente as unknown as ReturnType<typeof createAdminClient>,
      );

      const res = await patch({ monthly_limit_cents: 0 });

      expect(res.status).toBe(422);
      expect(escritas).toEqual([]);
    });
  });

  describe("o limiar recusado pelo Zod, e não pelo CHECK do banco", () => {
    for (const pct of [30, 100]) {
      it(`alarm_threshold_pct ${pct} é 422 de validação (não 500)`, async () => {
        sessao("admin");
        const { cliente, escritas } = fazerAdmin({ linha: null });
        vi.mocked(createAdminClient).mockReturnValue(
          cliente as unknown as ReturnType<typeof createAdminClient>,
        );

        const res = await patch({ alarm_threshold_pct: pct });

        expect(res.status).toBe(422);
        expect((await corpo(res)).error?.code).toBe("validation_failed");
        expect(escritas).toEqual([]);
      });
    }
  });

  describe("a linha que nasce pela tela não herda o DEFAULT 5000", () => {
    it("organização sem linha grava o teto EXPLÍCITO que veio no payload", async () => {
      sessao("admin");
      const { cliente, escritas } = fazerAdmin({ linha: null });
      vi.mocked(createAdminClient).mockReturnValue(
        cliente as unknown as ReturnType<typeof createAdminClient>,
      );

      const res = await patch({ enforcement_mode: "avisar", monthly_limit_cents: 2000 });
      expect(res.status).toBe(200);

      const escrita = escritas.find((e) => e.tabela === "ai_budgets");
      expect(escrita?.op).toBe("insert");
      expect(escrita?.payload.monthly_limit_cents).toBe(2000);
    });

    it('sem teto no payload, a linha nasce em 0 ("sem teto") e nunca em 5000', async () => {
      // `DEFAULT 5000` é o valor que ninguém escolheu — é a confusão que a 0159
      // desfez. Deixá-lo entrar pela porta de escrita a recriaria: a tela
      // passaria a mostrar "US$ 50,00" para quem só mexeu no percentual.
      sessao("admin");
      const { cliente, escritas } = fazerAdmin({ linha: null });
      vi.mocked(createAdminClient).mockReturnValue(
        cliente as unknown as ReturnType<typeof createAdminClient>,
      );

      const res = await patch({ alarm_threshold_pct: 90 });
      expect(res.status).toBe(200);

      const escrita = escritas.find((e) => e.tabela === "ai_budgets");
      expect(escrita?.op).toBe("insert");
      expect(escrita?.payload.monthly_limit_cents).toBe(0);
    });
  });

  describe("auditoria — mexer no teto deixa rastro", () => {
    it("armar emite ai.budget_enforcement_armed com antes/depois", async () => {
      sessao("admin");
      const { cliente } = fazerAdmin({
        linha: {
          monthly_limit_cents: 5000,
          alarm_threshold_pct: 80,
          enforcement_mode: "avisar",
          enforcement_effective_at: null,
        },
      });
      vi.mocked(createAdminClient).mockReturnValue(
        cliente as unknown as ReturnType<typeof createAdminClient>,
      );

      await patch({ enforcement_mode: "bloquear" });

      expect(vi.mocked(audit)).toHaveBeenCalledTimes(1);
      const entrada = vi.mocked(audit).mock.calls[0]![0];
      expect(entrada.action).toBe("ai.budget_enforcement_armed");
      expect(entrada.actorUserId).toBe(ADMIN);
      expect(entrada.organizationId).toBe(ORG);
      expect(entrada.metadata?.enforcement_mode).toEqual({
        antes: "avisar",
        depois: "bloquear",
      });
    });

    it("desarmar emite ai.budget_enforcement_disarmed", async () => {
      sessao("admin");
      const { cliente } = fazerAdmin({
        linha: {
          monthly_limit_cents: 5000,
          alarm_threshold_pct: 80,
          enforcement_mode: "bloquear",
          enforcement_effective_at: "2026-08-01T00:00:00.000Z",
        },
      });
      vi.mocked(createAdminClient).mockReturnValue(
        cliente as unknown as ReturnType<typeof createAdminClient>,
      );

      await patch({ enforcement_mode: "off" });

      expect(vi.mocked(audit)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(audit).mock.calls[0]![0].action).toBe("ai.budget_enforcement_disarmed");
    });

    it("mudar só o teto emite ai.budget_limit_changed com os dois valores", async () => {
      sessao("admin");
      const { cliente } = fazerAdmin({
        linha: {
          monthly_limit_cents: 5000,
          alarm_threshold_pct: 80,
          enforcement_mode: "avisar",
          enforcement_effective_at: null,
        },
      });
      vi.mocked(createAdminClient).mockReturnValue(
        cliente as unknown as ReturnType<typeof createAdminClient>,
      );

      await patch({ monthly_limit_cents: 12_000 });

      expect(vi.mocked(audit)).toHaveBeenCalledTimes(1);
      const entrada = vi.mocked(audit).mock.calls[0]![0];
      expect(entrada.action).toBe("ai.budget_limit_changed");
      expect(entrada.metadata?.monthly_limit_cents).toEqual({ antes: 5000, depois: 12_000 });
    });
  });

  describe("o laço de retorno — afrouxar fecha o alerta na hora", () => {
    it("desarmar resolve os budget_exceeded/budget_warning abertos", async () => {
      sessao("admin");
      const { cliente, escritas } = fazerAdmin({
        linha: {
          monthly_limit_cents: 5000,
          alarm_threshold_pct: 80,
          enforcement_mode: "bloquear",
          enforcement_effective_at: "2026-08-01T00:00:00.000Z",
        },
        itensAbertos: 2,
      });
      vi.mocked(createAdminClient).mockReturnValue(
        cliente as unknown as ReturnType<typeof createAdminClient>,
      );
      // Gasto ACIMA do limiar: sem o afrouxamento do modo, nada seria retratado
      // — é o que separa "fechou porque afrouxei" de "fechou porque o mês virou".
      vi.mocked(getBudgetStatus).mockResolvedValue(
        estadoDaTela({ current_month_consumed_cents: 9000, pct: 180, blocked_now: true }),
      );

      const res = await patch({ enforcement_mode: "avisar" });
      expect(res.status).toBe(200);

      const fechamento = escritas.find((e) => e.tabela === "agent_inbox_items");
      expect(fechamento?.op).toBe("update");
      expect(fechamento?.payload).toEqual({ status: "resolved" });
      // A tela não pode voltar do clique dizendo que a IA continua parada.
      expect((await corpo(res)).data?.blocked_now).toBe(false);
    });

    it("apertar com gasto acima do limiar NÃO retrata aviso nenhum", async () => {
      sessao("admin");
      const { cliente, escritas } = fazerAdmin({
        linha: {
          monthly_limit_cents: 5000,
          alarm_threshold_pct: 80,
          enforcement_mode: "off",
          enforcement_effective_at: null,
        },
        itensAbertos: 1,
      });
      vi.mocked(createAdminClient).mockReturnValue(
        cliente as unknown as ReturnType<typeof createAdminClient>,
      );
      vi.mocked(getBudgetStatus).mockResolvedValue(
        estadoDaTela({ current_month_consumed_cents: 9000, pct: 180 }),
      );

      const res = await patch({ enforcement_mode: "avisar" });
      expect(res.status).toBe(200);
      expect(escritas.some((e) => e.tabela === "agent_inbox_items")).toBe(false);
    });
  });
});

describe("o piso guarda `avisar` também — o aviso permanente e falso", () => {
  /**
   * O piso guardava só `bloquear`. Com isso, `avisar` + teto 0 era salvável pela
   * tela e pela API — e não era inofensivo: a CTE `avisa` de `SQL_ORCAMENTO`
   * dispara com `gasto >= teto * limiar / 100`, que com teto 0 é `gasto >= 0`,
   * SEMPRE verdadeiro já na primeira chamada com gasto zero. A CTE `retrata`
   * exigia `gasto < 0` para fechar. Resultado: um `budget_warning` permanente e
   * falso na Central, no caminho de PRIMEIRA IMPRESSÃO — organização nova não tem
   * linha em `ai_budgets`, o campo pré-preenche "0.00" e o radio "Me avisar"
   * nasce habilitado.
   *
   * O tell estava no próprio título da opção: "Me avisar ao passar de 80% de
   * US$ 0,00" — avisar de quê?
   */
  it("avisar com teto 0 é 422, sem escrita e sem auditoria", async () => {
    sessao("admin");
    const { cliente, escritas } = fazerAdmin({ linha: null });
    vi.mocked(createAdminClient).mockReturnValue(
      cliente as unknown as ReturnType<typeof createAdminClient>,
    );

    const res = await patch({ enforcement_mode: "avisar", monthly_limit_cents: 0 });

    expect(res.status).toBe(422);
    expect((await corpo(res)).error?.code).toBe("unprocessable_entity");
    expect(escritas, "gravou o estado que produz o aviso permanente").toEqual([]);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("avisar SEM teto no payload, em organização sem linha, também é 422", async () => {
    // Este é o caminho exato da tela numa instalação nova: o campo pré-preenche
    // "0.00" e o usuário só clica no radio. `tetoDepois` cai em 0 e o 422 tem de
    // pegá-lo pelo estado PÓS-escrita, não pela presença do campo no payload.
    sessao("admin");
    const { cliente, escritas } = fazerAdmin({ linha: null });
    vi.mocked(createAdminClient).mockReturnValue(
      cliente as unknown as ReturnType<typeof createAdminClient>,
    );

    const res = await patch({ enforcement_mode: "avisar" });

    expect(res.status).toBe(422);
    expect(escritas).toEqual([]);
  });

  it("já em `avisar`, derrubar o teto para 0 depois também é 422", async () => {
    // "Armado sem valor útil" renascendo pela porta de trás: mudar só o modo
    // hoje e derrubar o teto amanhã.
    sessao("admin");
    const { cliente, escritas } = fazerAdmin({
      linha: {
        monthly_limit_cents: 5000,
        alarm_threshold_pct: 80,
        enforcement_mode: "avisar",
        enforcement_effective_at: null,
      },
    });
    vi.mocked(createAdminClient).mockReturnValue(
      cliente as unknown as ReturnType<typeof createAdminClient>,
    );

    const res = await patch({ monthly_limit_cents: 0 });

    expect(res.status).toBe(422);
    expect(escritas).toEqual([]);
  });

  it("controle positivo: teto 0 com modo `off` continua aceito", async () => {
    // "Só acompanhar sem limite" é um estado legítimo — é a opção que existe
    // exatamente para isso. Um piso que a barrasse tiraria da pessoa a única
    // saída honesta.
    sessao("admin");
    const { cliente, escritas } = fazerAdmin({
      linha: {
        monthly_limit_cents: 5000,
        alarm_threshold_pct: 80,
        enforcement_mode: "avisar",
        enforcement_effective_at: null,
      },
    });
    vi.mocked(createAdminClient).mockReturnValue(
      cliente as unknown as ReturnType<typeof createAdminClient>,
    );
    vi.mocked(getBudgetStatus).mockResolvedValue(estadoDaTela({ monthly_limit_cents: 0 }));

    const res = await patch({ enforcement_mode: "off", monthly_limit_cents: 0 });

    expect(res.status).toBe(200);
    expect(escritas.some((e) => e.tabela === "ai_budgets")).toBe(true);
  });
});

describe("desarmar devolve a carência inteira — a coluna NÃO fica pré-gasta", () => {
  /**
   * `enforcement_effective_at` só era escrito ao ARMAR, e nunca limpo ao
   * desarmar. Uma organização que armou (efetivo em T) e voltou para `off` ficava
   * com uma data NO PASSADO e o modo desarmado: a carência pré-gasta. Qualquer
   * escritor que pusesse `enforcement_mode='bloquear'` sem tocar na data — outro
   * código, um caminho novo — armaria um bloqueio válido NO ATO, sem as 72h.
   *
   * O comentário da própria coluna diz que `null` é o estado de repouso de uma
   * linha desarmada; depois do primeiro desarme isso deixava de valer, e nada
   * restaurava o invariante. O teste de desarme que existia só olhava o código de
   * auditoria, então a omissão atravessava a suíte verde.
   */
  for (const destino of ["off", "avisar"] as const) {
    it(`bloquear → ${destino} grava enforcement_effective_at: null`, async () => {
      sessao("admin");
      const { cliente, escritas } = fazerAdmin({
        linha: {
          monthly_limit_cents: 5000,
          alarm_threshold_pct: 80,
          enforcement_mode: "bloquear",
          enforcement_effective_at: "2026-08-01T00:00:00.000Z",
        },
      });
      vi.mocked(createAdminClient).mockReturnValue(
        cliente as unknown as ReturnType<typeof createAdminClient>,
      );

      const res = await patch({ enforcement_mode: destino });
      expect(res.status).toBe(200);

      const escrita = escritas.find((e) => e.tabela === "ai_budgets");
      expect(escrita?.op).toBe("update");
      expect(
        Object.prototype.hasOwnProperty.call(escrita?.payload ?? {}, "enforcement_effective_at"),
        "desarmou e deixou a data antiga no banco — a próxima armada valeria no ato",
      ).toBe(true);
      expect(escrita?.payload.enforcement_effective_at).toBeNull();
    });
  }

  it("armar de novo, depois, volta a gravar as 72h inteiras", async () => {
    // Controle positivo: zerar ao desarmar não pode virar "nunca mais grava".
    sessao("admin");
    const { cliente, escritas } = fazerAdmin({
      linha: {
        monthly_limit_cents: 5000,
        alarm_threshold_pct: 80,
        enforcement_mode: "avisar",
        enforcement_effective_at: null,
      },
    });
    vi.mocked(createAdminClient).mockReturnValue(
      cliente as unknown as ReturnType<typeof createAdminClient>,
    );

    const antes = Date.now();
    const res = await patch({ enforcement_mode: "bloquear" });
    expect(res.status).toBe(200);

    const escrita = escritas.find((e) => e.tabela === "ai_budgets");
    const gravado = new Date(String(escrita?.payload.enforcement_effective_at)).getTime();
    expect(gravado).toBeGreaterThanOrEqual(antes + H72_MS - 5_000);
  });

  it("mexer só no teto de quem já está armado NÃO adia a parada", async () => {
    // Senão bastaria salvar o diálogo para empurrar por mais 72h uma parada que
    // já vale.
    sessao("admin");
    const { cliente, escritas } = fazerAdmin({
      linha: {
        monthly_limit_cents: 5000,
        alarm_threshold_pct: 80,
        enforcement_mode: "bloquear",
        enforcement_effective_at: "2026-08-01T00:00:00.000Z",
      },
    });
    vi.mocked(createAdminClient).mockReturnValue(
      cliente as unknown as ReturnType<typeof createAdminClient>,
    );

    const res = await patch({ monthly_limit_cents: 9000 });
    expect(res.status).toBe(200);

    const escrita = escritas.find((e) => e.tabela === "ai_budgets");
    expect(
      Object.prototype.hasOwnProperty.call(escrita?.payload ?? {}, "enforcement_effective_at"),
      "salvar o diálogo adiou uma parada que já valia",
    ).toBe(false);
  });
});

// Este teste isola o handler; autoridade de suporte é exercitada na suíte própria.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/impersonate/support")>(),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));
