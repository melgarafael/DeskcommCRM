import { describe, expect, it, vi } from "vitest";

import { podarArquivoDeWebhooks } from "@/lib/channels/retencao-do-arquivo";

/**
 * A PODA NÃO PODE VIRAR O PROBLEMA QUE ELA RESOLVE.
 *
 * ─── O defeito que ela conserta ─────────────────────────────────────────────
 *
 * `webhook_events_log` nunca foi podado. Medido numa instalação real em
 * 20/08/2026: 468 MB de 545 MB do banco inteiro (86%), todas as 56.291 linhas
 * dos últimos 20 dias — ~23 MB/dia, sem teto, contra os 500 MB do plano
 * gratuito do Supabase.
 *
 * ─── E o defeito que o filtro do update tinha ───────────────────────────────
 *
 * A primeira versão escolhia até 500 ids e mandava a lista inteira no filtro do
 * update. O PostgREST põe filtro na QUERY STRING: 500 uuids passam de 18 KB de
 * URL, e o gateway recusa (414) acima de 8 KB. O `archived_at` nunca era
 * gravado e a rodada seguinte escolhia a mesma leva — a poda rodava e não
 * esvaziava nada. Por isso o caso "nunca manda lista de id" existe.
 *
 * ─── Por que os casos são sobre o que ela NÃO faz ───────────────────────────
 *
 * Uma poda erra de três formas, e as três são caras de descobrir em produção:
 * apagando o que ainda serve, segurando a tabela em que todo webhook escreve,
 * ou escrevendo de novo o que já escreveu. Por isso quase todo caso aqui é um
 * limite, não um caminho feliz.
 *
 * A ORDEM do DELETE e o CANAL da falha não moram aqui: medidos em
 * `retencao-arquivo-webhooks-ordena-e-fala-a-falha.test.ts`, o arquivo criado
 * junto com o conserto do #1769.
 */

interface Chamada {
  tabela: string;
  op: string;
  valores?: Record<string, unknown>;
  ids?: string[];
  /** O teto de tempo do update — o que substituiu a lista de id. */
  ate?: string;
  /** As colunas filtradas com `is(coluna, null)`. */
  ehNulo?: string[];
  /** A coluna e a direção do `order` desta cadeia. */
  ordem?: { coluna: string; ascending?: boolean };
}

const linha = (id: string, received_at: string) => ({ id, received_at });

/** Duble mínimo do client: registra o que foi pedido, devolve o que mandarem. */
function fakeAdmin(
  opts: {
    alvos?: { id: string; received_at: string }[];
    apagadas?: { id: string }[];
    esvaziadas?: { id: string }[];
  } = {},
) {
  const chamadas: Chamada[] = [];
  const admin = {
    from(tabela: string) {
      const ctx: Chamada = { tabela, op: "" };
      const q: Record<string, unknown> = {
        select() { if (!ctx.op) ctx.op = "select"; return q; },
        is(coluna: string) { (ctx.ehNulo ??= []).push(coluna); return q; },
        lt() { return q; },
        lte(_c: string, valor: string) { ctx.ate = valor; return q; },
        order(coluna: string, o?: { ascending?: boolean }) {
          ctx.ordem = { coluna, ascending: o?.ascending };
          return q;
        },
        in(_c: string, ids: string[]) { ctx.ids = ids; return q; },
        update(valores: Record<string, unknown>) { ctx.op = "update"; ctx.valores = valores; return q; },
        delete() { ctx.op = "delete"; return q; },
        limit() {
          chamadas.push(ctx);
          return ctx.op === "delete"
            ? Promise.resolve({ data: opts.apagadas ?? [], error: null })
            : Promise.resolve({ data: opts.alvos ?? [], error: null });
        },
        then(res: (v: unknown) => unknown) {
          chamadas.push(ctx);
          return Promise.resolve({
            data: ctx.op === "update" ? (opts.esvaziadas ?? []) : null,
            error: null,
          }).then(res);
        },
      };
      return q;
    },
  };
  return { admin: admin as never, chamadas };
}

const DUAS = [linha("a", "2026-01-01T10:00:00.000Z"), linha("b", "2026-01-02T10:00:00.000Z")];

describe("a poda esvazia, mas não apaga o que ainda serve", () => {
  it("descarta as TRÊS colunas pesadas e nada mais", async () => {
    // São ~97% do peso. Esvaziar só uma delas deixaria o problema de pé, e
    // esvaziar uma quarta (provider, tipo, horário) mataria o índice forense —
    // que é a razão de esvaziar em vez de apagar.
    const { admin, chamadas } = fakeAdmin({ alvos: DUAS });
    await podarArquivoDeWebhooks(admin, { diasComCorpo: 7, diasParaApagar: 90 });

    const update = chamadas.find((c) => c.op === "update");
    expect(update?.valores).toMatchObject({ raw_body: null, payload_parsed: null, headers: null });
    expect(Object.keys(update?.valores ?? {}).sort()).toEqual(
      ["archived_at", "headers", "payload_parsed", "raw_body"],
    );
  });

  it("carimba `archived_at` — sem ele, NULL vira ambíguo", async () => {
    // NULL sem carimbo não distingue "a poda passou" de "o arquivo falhou ao
    // gravar". Quem investigar depois precisa saber qual dos dois foi.
    const { admin, chamadas } = fakeAdmin({ alvos: [linha("a", "2026-01-01T10:00:00.000Z")] });
    await podarArquivoDeWebhooks(admin, { diasComCorpo: 7, diasParaApagar: 90 });
    expect(chamadas.find((c) => c.op === "update")?.valores?.archived_at).toBeTypeOf("string");
  });

  it("não escreve nada quando não há linha velha", async () => {
    // Rodando de minuto em minuto, o caso NORMAL é não ter trabalho. Uma poda
    // que escreve à toa é a mesma doença do worker que perguntava 4×/s.
    const { admin, chamadas } = fakeAdmin({ alvos: [] });
    const r = await podarArquivoDeWebhooks(admin, { diasComCorpo: 7, diasParaApagar: 90 });
    expect(r.esvaziadas).toBe(0);
    expect(chamadas.some((c) => c.op === "update")).toBe(false);
  });
});

describe("o filtro do update não pode viajar na URL", () => {
  it("NUNCA manda lista de id — era isto que devolvia 414 e travava a poda", async () => {
    const { admin, chamadas } = fakeAdmin({ alvos: DUAS });
    await podarArquivoDeWebhooks(admin, { diasComCorpo: 7, diasParaApagar: 90 });
    const update = chamadas.find((c) => c.op === "update");
    // Sem esta linha o caso passaria por vacuidade: sem update, `ids` também é
    // indefinido.
    expect(update).toBeDefined();
    expect(update?.ids).toBeUndefined();
  });

  it("corta pela data da ÚLTIMA linha do lote, como o banco a devolveu", async () => {
    // As linhas vêm da mais velha para a mais nova: o teto é a última, e assim o
    // update alcança o lote inteiro e nada além dele. A string segue intacta —
    // passar por `Date` perderia os microssegundos, e a última linha ficaria de
    // fora do próprio teto.
    const { admin, chamadas } = fakeAdmin({
      alvos: [
        linha("a", "2026-01-01T10:00:00.123456+00:00"),
        linha("b", "2026-01-02T10:00:00.654321+00:00"),
      ],
    });
    await podarArquivoDeWebhooks(admin, { diasComCorpo: 7, diasParaApagar: 90 });
    expect(chamadas.find((c) => c.op === "update")?.ate).toBe("2026-01-02T10:00:00.654321+00:00");
  });

  it("repete o predicado da escolha — linha já esvaziada não é escrita de novo", async () => {
    const { admin, chamadas } = fakeAdmin({ alvos: DUAS });
    await podarArquivoDeWebhooks(admin, { diasComCorpo: 7, diasParaApagar: 90 });
    expect(chamadas.find((c) => c.op === "update")?.ehNulo).toEqual(["archived_at"]);
  });

  it("a escolha ordena por received_at CRESCENTE — é ela que faz o teto do update ser o lote", async () => {
    // O update corta pela data da ÚLTIMA linha escolhida. Com a escolha em
    // ordem crescente, essa linha é a mais nova do lote e o update alcança o
    // lote e só ele. Em ordem decrescente (ou por `id`), a última linha pode
    // ser a mais nova de TODAS as vencidas, e o update esvazia a fila inteira
    // de uma vez — a mesma tabela em que todo webhook escreve, sem teto.
    const { admin, chamadas } = fakeAdmin({ alvos: DUAS });
    await podarArquivoDeWebhooks(admin, { diasComCorpo: 7, diasParaApagar: 90 });
    expect(chamadas.find((c) => c.op === "select")?.ordem).toEqual({
      coluna: "received_at",
      ascending: true,
    });
  });

  it("conta o que VOLTOU, não o que pediu", async () => {
    // O empate de instante pode levar uma linha a mais junto; o número relatado
    // tem de ser o que aconteceu, senão a rodada mente no log.
    const { admin } = fakeAdmin({
      alvos: DUAS,
      esvaziadas: [{ id: "a" }, { id: "b" }, { id: "c" }],
    });
    const r = await podarArquivoDeWebhooks(admin, { diasComCorpo: 7, diasParaApagar: 90 });
    expect(r.esvaziadas).toBe(3);
  });
});

describe("o lote é o que impede a poda de derrubar a entrada", () => {
  it("pede no MÁXIMO o tamanho do lote", async () => {
    const { admin } = fakeAdmin({
      alvos: Array.from({ length: 3 }, (_, i) => linha(`x${i}`, `2026-01-0${i + 1}T10:00:00.000Z`)),
    });
    const r = await podarArquivoDeWebhooks(admin, { diasComCorpo: 7, diasParaApagar: 90, lote: 3 });
    // Lote cheio = ainda há fila. É o sinal de que a varredura não alcançou o
    // regime estável — no primeiro dia são dezenas de milhares atrasadas.
    expect(r.temMais).toBe(true);
  });

  it("lote com folga significa fila vazia", async () => {
    const { admin } = fakeAdmin({ alvos: [linha("x", "2026-01-01T10:00:00.000Z")] });
    const r = await podarArquivoDeWebhooks(admin, { diasComCorpo: 7, diasParaApagar: 90, lote: 500 });
    expect(r.temMais).toBe(false);
  });
});

describe("falha do banco na BUSCA não derruba a rodada", () => {
  it("erro ao escolher devolve zero, não lança", async () => {
    // Este cron roda ao lado dos que entregam mensagem. Uma exceção aqui não
    // pode virar 500 numa rota que o scheduler chama de minuto em minuto.
    //
    // O escopo deste caso é o PASSO 1, e ele é estreito de propósito: a busca
    // é idempotente e o mesmo lote volta a ser escolhido na rodada seguinte de
    // 5 em 5 minutos, enquanto o DELETE do passo 2 é a linha que some para
    // sempre. Por isso a falha da busca continua devolvendo zero — e a do
    // DELETE passou a SUBIR no #1769, com a mesma régua da poda irmã. Os dois
    // canais estão medidos em
    // `retencao-arquivo-webhooks-ordena-e-fala-a-falha.test.ts`.
    const admin = {
      from: () => ({
        select: () => ({ is: () => ({ lt: () => ({ order: () => ({
          limit: () => Promise.resolve({ data: null, error: { message: "timeout" } }),
        }) }) }) }),
      }),
    } as never;
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(podarArquivoDeWebhooks(admin, { diasComCorpo: 7, diasParaApagar: 90 }))
      .resolves.toMatchObject({ esvaziadas: 0, apagadas: 0 });
    aviso.mockRestore();
  });
});
