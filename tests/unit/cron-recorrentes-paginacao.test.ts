import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * COM MAIS DE 1.000 MOLDES ATIVOS, O MOLDE DEVIDO CONTINUA NASCENDO.
 *
 * ─── O defeito, medido (issue #5059) ────────────────────────────────────────
 *
 * O PostgREST desta instalação devolve no máximo `max_rows` linhas por resposta
 * (`supabase/config.toml`, 1.000). O `recurring-entries` lia UMA página de moldes
 * ativos, sem `.range()` e sem laço. Com 1.001 moldes ativos, o 1.001º — que é
 * justamente o devido no dia — ficava fora da resposta, o insert não acontecia e
 * a rota respondia 200 com `moldes: 1000`, `gerados: 0`. O mês passava sem o
 * lançamento e nada acusava: "nada a gerar" e "não li a linha" eram a mesma
 * resposta.
 *
 * ─── Por que o dublê imita `max_rows` em vez de devolver tudo ───────────────
 *
 * Um mock que devolve o array inteiro ignora a causa do defeito e fica verde com
 * a rota antiga. Aqui o dublê corta em `MAX_ROWS` mesmo quando o `.range()` pede
 * mais, como o PostgREST faz de verdade, e sem `.range()` devolve só a primeira
 * página — o contrato exato em que o bug vive.
 *
 * O tempo é fixo (15/05/2026) porque a regra de competência compara com o dia de
 * hoje: sem isto, o teste mudaria de resultado conforme a data em que rodasse.
 */

const SEGREDO = "segredo-de-cron-do-teste";
/** O `max_rows` do PostgREST (`supabase/config.toml`). */
const MAX_ROWS = 1000;
const HOJE = "2026-05-15";

vi.mock("@/lib/env", () => ({
  env: {
    INTERNAL_CRON_SECRET: SEGREDO,
    INTERNAL_SECRET: "",
    JOB_QUEUE_RETENTION_DAYS: "",
    AUDIT_LOG_RETENTION_DAYS: "",
  },
}));

const auditou = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (...args: unknown[]) => auditou(...args) }));

const banco = vi.hoisted(() => ({
  moldes: [] as Array<Record<string, unknown>>,
  /** Chaves `recurring_entry_id|entry_date` gravadas: o índice único de verdade. */
  lancamentos: new Set<string>(),
  /** Toda tentativa de insert, aceita ou recusada por 23505. */
  inserts: [] as Array<Record<string, unknown>>,
  /** O `range` de cada consulta — `null` quando a rota leu sem paginar. */
  paginas: [] as Array<[number, number] | null>,
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => criarAdmin() }));

function criarAdmin() {
  return {
    from(tabela: string) {
      if (tabela === "financial_entries") {
        return {
          insert: async (linha: Record<string, unknown>) => {
            banco.inserts.push(linha);
            const chave = `${linha.recurring_entry_id}|${linha.entry_date}`;
            if (banco.lancamentos.has(chave)) {
              // O índice único `(recurring_entry_id, entry_date)` pegou.
              return {
                error: {
                  code: "23505",
                  message: "duplicate key value violates unique constraint",
                },
              };
            }
            banco.lancamentos.add(chave);
            return { error: null };
          },
        };
      }
      if (tabela === "recurring_entries") return consultaDeMoldes();
      throw new Error(`tabela inesperada no dublê: ${tabela}`);
    },
  };
}

function consultaDeMoldes() {
  let soAtivos = false;
  let ordem: { coluna: string; ascendente: boolean } | null = null;
  let janela: [number, number] | null = null;

  const responder = () => {
    let linhas = banco.moldes.filter((m) => !soAtivos || m.is_active === true);
    if (ordem) {
      const { coluna, ascendente } = ordem;
      linhas = [...linhas].sort((a, b) => {
        const x = String(a[coluna]);
        const y = String(b[coluna]);
        if (x === y) return 0;
        return (x < y ? -1 : 1) * (ascendente ? 1 : -1);
      });
    }
    const inicio = janela ? janela[0] : 0;
    const pedidas = janela ? janela[1] - inicio + 1 : MAX_ROWS;
    // PostgREST: nunca devolve mais que `max_rows`, ainda que o `.range()` peça.
    const quantidade = Math.min(pedidas, MAX_ROWS);
    banco.paginas.push(janela);
    return { data: linhas.slice(inicio, inicio + quantidade), error: null };
  };

  const cadeia = {
    select: () => cadeia,
    eq: (coluna: string, valor: unknown) => {
      if (coluna === "is_active") soAtivos = valor === true;
      return cadeia;
    },
    order: (coluna: string, opcoes: { ascending?: boolean } = {}) => {
      ordem = { coluna, ascendente: opcoes.ascending !== false };
      return cadeia;
    },
    range: (de: number, ate: number) => {
      janela = [de, ate];
      return Promise.resolve(responder());
    },
    // Thenable: a rota antiga dava `await` no fim de `.eq(...)`; a nova, no de
    // `.range(...)`. As duas formas caem aqui.
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(responder()).then(resolve, reject),
  };
  return cadeia;
}

const BASE = {
  organization_id: "org-1",
  account_id: "conta-1",
  account_plan_id: null,
  direction: "out",
  amount_cents: 129_900,
  currency: "BRL",
  name: "Aluguel",
  ends_on: null,
  is_active: true,
};

/** 1.000 ativos NÃO devidos hoje + o devido, que só cai na 2ª página. */
function montarMoldes(): void {
  const moldes: Array<Record<string, unknown>> = [];
  // Dia 20 de maio > 15 de maio: competência futura, `continue` no laço.
  for (let i = 1; i <= 1000; i++) {
    moldes.push({ ...BASE, id: `molde-${String(i).padStart(4, "0")}`, day_of_month: 20 });
  }
  // Dia 1 já chegou. `molde-1001` é o ÚLTIMO na ordem crescente de `id`.
  moldes.push({ ...BASE, id: "molde-1001", day_of_month: 1 });
  banco.moldes = moldes;
}

async function rodarRota() {
  const { GET } = await import("@/app/api/v1/cron/recurring-entries/route");
  const resposta = await GET({
    headers: new Headers({ authorization: `Bearer ${SEGREDO}` }),
  } as never);
  const corpo = await resposta.json();
  return { resposta, corpo };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${HOJE}T12:00:00Z`));
  banco.moldes = [];
  banco.lancamentos.clear();
  banco.inserts.length = 0;
  banco.paginas.length = 0;
  auditou.mockClear();
  montarMoldes();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("recurring-entries × teto de 1.000 linhas do PostgREST", () => {
  it("o dublê respeita max_rows (controle do instrumento)", async () => {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const semRange = await (createAdminClient() as never as {
      from: (t: string) => {
        select: (c: string) => { eq: (c: string, v: unknown) => Promise<{ data: unknown[] }> };
      };
    })
      .from("recurring_entries")
      .select("id")
      .eq("is_active", true);
    // Sem `.range()`: o PostgREST devolve UMA página, não os 1.001.
    expect(semRange.data).toHaveLength(MAX_ROWS);
    expect(banco.moldes).toHaveLength(1001);
  });

  it("gera o molde devido da 2ª página e devolve o TOTAL de moldes lidos", async () => {
    const { resposta, corpo } = await rodarRota();

    expect(resposta.status).toBe(200);
    expect(corpo.data).toEqual({
      moldes: 1001,
      gerados: 1,
      ja_existiam: 0,
      falharam: 0,
    });

    expect(banco.inserts).toHaveLength(1);
    expect(banco.inserts[0]).toMatchObject({
      recurring_entry_id: "molde-1001",
      entry_date: "2026-05-01",
      status: "pending",
      origin: "recurring",
      description: "Aluguel",
    });

    // A leitura passou pela segunda página: 0–999 e 1000–1999.
    expect(banco.paginas[0]).toEqual([0, MAX_ROWS - 1]);
    expect(banco.paginas[1]).toEqual([MAX_ROWS, 2 * MAX_ROWS - 1]);

    // Auditou porque houve efeito.
    expect(auditou).toHaveBeenCalledTimes(1);
    expect(auditou.mock.calls[0]?.[0]).toMatchObject({
      action: "financeiro.recorrencia_gerada",
      metadata: { gerados: 1, ja_existiam: 0, falharam: 0 },
    });
  });

  it("a segunda rodada do dia não duplica: gerados 0, ja_existiam 1, sem audit", async () => {
    await rodarRota();
    const { resposta, corpo } = await rodarRota();

    expect(resposta.status).toBe(200);
    expect(corpo.data).toEqual({
      moldes: 1001,
      gerados: 0,
      ja_existiam: 1,
      falharam: 0,
    });

    // Duas tentativas de insert, um único lançamento gravado: o índice único
    // continua sendo a idempotência, e o `23505` continua sendo "já existia".
    expect(banco.inserts).toHaveLength(2);
    expect(banco.lancamentos.size).toBe(1);
    // Rodada sem efeito não audita.
    expect(auditou).toHaveBeenCalledTimes(1);
  });
});
