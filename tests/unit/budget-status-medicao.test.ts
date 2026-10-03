/**
 * QUEM PRODUZ O NÚMERO DA TELA — e o aviso de que ele está incompleto.
 *
 * `tests/unit/budget-card-promessas.test.tsx` guarda o que o card DIZ quando
 * `gasto_incompleto` é `true`. Sozinho ele é um gate com ponto cego: um produtor
 * que devolvesse `false` para sempre deixaria a tela verde, silenciosa e errada
 * — a ressalva nunca apareceria, e nada reprovaria.
 *
 * Aqui se prende o PRODUTOR: que a pergunta feita ao banco é "há chamada DESTE
 * MÊS sem custo conhecido?" (e não outra qualquer), e que a resposta chega ao
 * contrato.
 *
 * O outro eixo — o gasto vir da régua única `fn_gasto_de_ia_do_mes`, e não da
 * coluna materializada — também está aqui, com a degradação declarada: a queda
 * para a coluna acontece, mas nunca em silêncio.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getBudgetStatus } from "@/lib/ai/budget/check";
import { PONTO_TRANSCRICAO_DE_AUDIO } from "@/lib/ai/pontos/registro";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

const ORG = "22222222-2222-4222-8222-222222222222";

interface Filtro {
  metodo: string;
  args: unknown[];
}

const LINHA = {
  organization_id: ORG,
  monthly_limit_cents: 5000,
  current_month_consumed_cents: 999_999,
  alarm_threshold_pct: 80,
  enforcement_mode: "avisar",
  enforcement_effective_at: null,
  current_period_start: "2026-03-01",
  last_alarm_sent_at: null,
  updated_at: "2026-08-15T00:00:00.000Z",
};

/**
 * Dublê que REGISTRA os filtros por tabela — o teste precisa afirmar sobre a
 * PERGUNTA, não só sobre o número devolvido: um contador que conte a coisa
 * errada também devolve um número.
 */
function fazerAdmin(opts: {
  gastoDaRegua?: number | null;
  erroDaRegua?: string;
  itensBloqueio?: number;
  chamadasSemPreco?: number;
  erroSemPreco?: string;
}) {
  const filtros: Record<string, Filtro[]> = {};

  const from = (tabela: string) => {
    filtros[tabela] ??= [];
    const registra = (metodo: string, args: unknown[]) => {
      filtros[tabela]!.push({ metodo, args });
      return chain;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: (...a: unknown[]) => registra("select", a),
      eq: (...a: unknown[]) => registra("eq", a),
      neq: (...a: unknown[]) => registra("neq", a),
      is: (...a: unknown[]) => registra("is", a),
      gte: (...a: unknown[]) => registra("gte", a),
      maybeSingle: async () => ({ data: tabela === "ai_budgets" ? LINHA : null, error: null }),
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve(
          tabela === "llm_calls"
            ? {
                count: opts.chamadasSemPreco ?? 0,
                error: opts.erroSemPreco ? { message: opts.erroSemPreco } : null,
              }
            : { count: opts.itensBloqueio ?? 0, error: null },
        ).then(res),
    };
    return chain;
  };

  const rpc = async () =>
    opts.erroDaRegua
      ? { data: null, error: { message: opts.erroDaRegua } }
      : { data: opts.gastoDaRegua ?? 0, error: null };

  return { cliente: { from, rpc }, filtros };
}

function instalar(opts: Parameters<typeof fazerAdmin>[0]) {
  const { cliente, filtros } = fazerAdmin(opts);
  vi.mocked(createAdminClient).mockReturnValue(
    cliente as unknown as ReturnType<typeof createAdminClient>,
  );
  return filtros;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("o furo de medição é medido, não presumido", () => {
  it("pergunta pelas chamadas DESTE MÊS sem custo conhecido", () => {
    const filtros = instalar({ chamadasSemPreco: 3 });
    return getBudgetStatus(ORG).then(() => {
      const llm = filtros["llm_calls"] ?? [];
      expect(llm.length, "ninguém perguntou nada a llm_calls").toBeGreaterThan(0);
      // `cost_cents is null` é a definição de "preço desconhecido" no schema
      // (`llm_calls.cost_cents numeric` — null = nunca inventar 0).
      expect(
        llm.some((f) => f.metodo === "is" && f.args[0] === "cost_cents" && f.args[1] === null),
        "a pergunta não filtra por custo desconhecido — está medindo outra coisa",
      ).toBe(true);
      expect(
        llm.some((f) => f.metodo === "eq" && f.args[0] === "organization_id" && f.args[1] === ORG),
        "consulta sem filtro de organização: service role bypassa RLS",
      ).toBe(true);
      const janela = llm.find((f) => f.metodo === "gte" && f.args[0] === "created_at");
      expect(janela, "sem janela: um modelo sem preço de 2024 acenderia o aviso para sempre").toBeDefined();
      const inicio = new Date(String(janela?.args[1]));
      const agora = new Date();
      expect(inicio.getUTCDate()).toBe(1);
      expect(inicio.getUTCMonth()).toBe(agora.getUTCMonth());
      expect(inicio.getUTCFullYear()).toBe(agora.getUTCFullYear());
    });
  });

  it("não conta como modelo sem preço a transcrição nem a falha", async () => {
    // As duas gravam `cost_cents` nulo por construção: a transcrição é cobrada
    // por minuto e sem tokens, a falha não cobrou token nenhum. Contá-las fazia
    // o card dizer "o produto não sabe o preço do modelo em uso... a parada pode
    // não acontecer" a toda organização que recebeu um áudio no mês — com o
    // modelo do turno precificado e a parada funcionando.
    const filtros = instalar({ chamadasSemPreco: 0 });
    await getBudgetStatus(ORG);
    const llm = filtros["llm_calls"] ?? [];
    expect(
      llm.some((f) => f.metodo === "neq" && f.args[0] === "purpose" && f.args[1] === PONTO_TRANSCRICAO_DE_AUDIO),
      "a transcrição entra na contagem e acende o aviso de modelo sem preço",
    ).toBe(true);
    expect(
      llm.some((f) => f.metodo === "eq" && f.args[0] === "status" && f.args[1] === "ok"),
      "a linha de falha entra na contagem e acende o aviso de modelo sem preço",
    ).toBe(true);
  });

  it("com chamadas sem preço no mês, o contrato avisa", async () => {
    instalar({ chamadasSemPreco: 1 });
    expect((await getBudgetStatus(ORG)).gasto_incompleto).toBe(true);
  });

  it("sem nenhuma, não avisa (controle negativo)", async () => {
    instalar({ chamadasSemPreco: 0 });
    expect((await getBudgetStatus(ORG)).gasto_incompleto).toBe(false);
  });

  it("consulta que FALHA não inventa furo, mas também não cala", async () => {
    // Afirmar um furo que não se mediu assusta quem está protegido de verdade;
    // engolir o erro é a frase tranquilizadora que a doutrina proíbe.
    instalar({ erroSemPreco: "PostgREST fora" });
    expect((await getBudgetStatus(ORG)).gasto_incompleto).toBe(false);
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
  });
});

describe("o número exibido é o número que decide", () => {
  it("o gasto vem da régua, não da coluna materializada", async () => {
    // A linha traz `current_month_consumed_cents: 999_999` — o contador que soma
    // desde a instalação. Se ele vazar para a tela, alguém arma uma proteção
    // contra uma mentira.
    instalar({ gastoDaRegua: 1234 });
    const status = await getBudgetStatus(ORG);
    expect(status.current_month_consumed_cents).toBe(1234);
    expect(status.pct).toBe(24.68);
  });

  it("régua fora do ar degrada para a coluna — e LOGA a queda", async () => {
    // O caso concreto é o clone cujo `update.sh` (sem ON_ERROR_STOP) engoliu o
    // apêndice e não tem a função. Um erro na tela de Uso seria pior; um número
    // pior em silêncio também.
    instalar({ erroDaRegua: "function does not exist" });
    const status = await getBudgetStatus(ORG);
    expect(status.current_month_consumed_cents).toBe(999_999);
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
  });

  it("`blocked_now` vem do único produtor real: um budget_exceeded aberto", async () => {
    instalar({ itensBloqueio: 1 });
    expect((await getBudgetStatus(ORG)).blocked_now).toBe(true);
    instalar({ itensBloqueio: 0 });
    expect((await getBudgetStatus(ORG)).blocked_now).toBe(false);
  });
});
