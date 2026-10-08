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
  /** Linhas de `llm_calls`: a contagem passa a ser a dos FILTROS aplicados a elas. */
  linhasDeLlmCalls?: LinhaDeLlmCalls[];
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
      or: (...a: unknown[]) => registra("or", a),
      is: (...a: unknown[]) => registra("is", a),
      gte: (...a: unknown[]) => registra("gte", a),
      maybeSingle: async () => ({ data: tabela === "ai_budgets" ? LINHA : null, error: null }),
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve(
          tabela === "llm_calls"
            ? {
                count: opts.linhasDeLlmCalls
                  ? opts.linhasDeLlmCalls.filter((l) => filtros[tabela]!.every((f) => passa(l, f))).length
                  : (opts.chamadasSemPreco ?? 0),
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

type LinhaDeLlmCalls = Record<string, string | number | null>;

/**
 * Os filtros do PostgREST com a semântica do SQL, só nas formas que a consulta
 * usa — inclusive o `NULL` que não casa com `neq` nem com `not.in`, que é onde
 * um filtro de exclusão some com linhas sem ninguém ver.
 */
function condicao(l: LinhaDeLlmCalls, col: string, op: string, val: unknown): boolean {
  const v = l[col] ?? null;
  if (op === "is") return val === null || val === "null" ? v === null : v === val;
  if (v === null) return false;
  if (op === "eq") return v === val;
  if (op === "neq") return v !== val;
  if (op === "gte") return String(v) >= String(val);
  const lista = String(val).replace(/^\(|\)$/g, "").split(",");
  if (op === "in") return lista.includes(String(v));
  if (op === "not.in") return !lista.includes(String(v));
  throw new Error(`filtro não suportado pelo dublê: ${op}`);
}

function passa(l: LinhaDeLlmCalls, f: Filtro): boolean {
  if (f.metodo === "select") return true;
  if (f.metodo !== "or") return condicao(l, String(f.args[0]), f.metodo, f.args[1]);
  // Vírgulas DENTRO de parênteses são da lista do `in`, não do `or`.
  const termos = String(f.args[0]).split(/,(?![^(]*\))/);
  return termos.some((t) => {
    const m = /^([a-z_]+)\.(not\.in|in|is|eq|neq)\.(.*)$/.exec(t);
    if (!m) throw new Error(`termo de or não suportado pelo dublê: ${t}`);
    return condicao(l, m[1]!, m[2]!, m[3]);
  });
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

  describe("o que é furo e o que é custo nulo por construção", () => {
    // Linha do mês, `ok`, sem custo: o que varia é o QUE a gerou.
    const semCusto = (extra: LinhaDeLlmCalls): LinhaDeLlmCalls => ({
      organization_id: ORG,
      cost_cents: null,
      status: "ok",
      purpose: "agent_reply",
      origem_da_escolha: null,
      created_at: new Date().toISOString(),
      ...extra,
    });
    const avisa = async (linha: LinhaDeLlmCalls): Promise<boolean> => {
      instalar({ linhasDeLlmCalls: [linha] });
      return (await getBudgetStatus(ORG)).gasto_incompleto;
    };

    it("controle positivo: chamada do turno sem preço conhecido acende o aviso", async () => {
      expect(await avisa(semCusto({}))).toBe(true);
    });

    it("a falha não acende: o provedor recusou, nenhum token foi cobrado", async () => {
      expect(await avisa(semCusto({ status: "erro" }))).toBe(false);
    });

    it("transcrição pelo serviço (degraus 1 e 2) não acende: preço próprio, sem tokens", async () => {
      // Contá-las fazia o card dizer "o produto não sabe o preço do modelo em
      // uso... a parada pode não acontecer" a toda organização que recebeu um
      // áudio no mês — com o modelo do turno precificado e a parada funcionando.
      for (const origem of ["servico_da_instalacao", "padrao_openai_compativel"]) {
        expect(
          await avisa(semCusto({ purpose: PONTO_TRANSCRICAO_DE_AUDIO, origem_da_escolha: origem })),
          `degrau ${origem} acendeu o aviso`,
        ).toBe(false);
      }
    });

    it("transcrição pelo modelo da organização (degrau 3) SEM preço ACENDE: é LLM cobrado por token", async () => {
      // Excluir o `purpose` inteiro apagava o aviso justamente aqui: o gasto
      // desse áudio não entra na soma do teto, e o card dizia que entrava.
      expect(
        await avisa(semCusto({ purpose: PONTO_TRANSCRICAO_DE_AUDIO, origem_da_escolha: "modelo_da_organizacao" })),
      ).toBe(true);
    });

    it("transcrição sem origem gravada acende: na dúvida, a medição avisa", async () => {
      expect(await avisa(semCusto({ purpose: PONTO_TRANSCRICAO_DE_AUDIO }))).toBe(true);
    });

    it("linha de outra organização ou de outro mês não acende", async () => {
      expect(await avisa(semCusto({ organization_id: "outra" }))).toBe(false);
      expect(await avisa(semCusto({ created_at: "2001-01-01T00:00:00.000Z" }))).toBe(false);
    });
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

  it("`blocked_now` fala só do orçamento da ORG: o aviso do teto do PLANO não entra na conta", async () => {
    // O budget_exceeded com ref_kind='plano' (cobrança) não é deste card: contá-lo
    // mandaria o admin mexer num teto que não destrava nada, e o PATCH do
    // orçamento devolveria blocked_now:false com a IA ainda parada pelo plano.
    // Mesma régua do retratarAvisos da rota.
    const filtros = instalar({ itensBloqueio: 0 });
    await getBudgetStatus(ORG);
    const bloqueio = filtros["agent_inbox_items"] ?? [];
    expect(bloqueio.some((f) => f.metodo === "eq" && f.args[0] === "kind" && f.args[1] === "budget_exceeded")).toBe(true);
    expect(bloqueio.filter((f) => f.metodo === "or").map((f) => f.args[0])).toEqual([
      "ref_kind.is.null,ref_kind.eq.ai_budget",
    ]);
  });
});
