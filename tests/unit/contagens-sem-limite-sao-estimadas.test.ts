/**
 * #4325 (segunda fatia) — as abas que crescem SEM LIMITE param de varrer a
 * organização inteira a cada chamada.
 *
 * ─── O que estava medido na main ───────────────────────────────────────────
 *
 * `GET /api/v1/conversations/counts` dispara SEIS `count: 'exact'` em
 * `Promise.all` (fila, automático, minhas, todas, fechadas, arquivadas), cada
 * uma sobre a organização inteira. "Fechadas" e "Arquivadas" são as duas que
 * crescem com o HISTÓRICO — todo atendimento encerrado entra numa delas e
 * nenhuma sai — então o custo delas só aumenta com o tempo, e o número é
 * pedido a cada 30 s em toda tela do Inbox.
 *
 * ─── A regra desta fatia ───────────────────────────────────────────────────
 *
 * 1. Fechadas e Arquivadas usam `count: 'planned'` (estimativa do planejador do
 *    PostgREST): custo de PLANO, não varredura. O número é aproximado e a rota
 *    DIZ isso em `aproximadas`, para a tela poder avisar em vez de mentir.
 * 2. Fila, Automático, Minhas e Todas continuam `exact`. Exatidão ali é
 *    requisito de produto: são as abas em que alguém age.
 *
 * Este arquivo fala com a ROTA de verdade (GET), com um client falso que
 * registra o `count` pedido em cada consulta. Teste de texto-fonte não pegaria
 * o defeito: o `count` viaja como argumento de objeto, e trocá-lo de volta para
 * `exact` mantém a linha parecendo certa.
 */
import type { NextRequest } from "next/server";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/v1/conversations/counts/route";

const ORG = "00000000-0000-4000-8000-0000000000aa";

type ConsultaRegistrada = {
  tabela: string;
  count?: string;
  head?: boolean;
  filtros: Array<[string, string, unknown]>;
};

const h = vi.hoisted(() => ({
  consultas: [] as ConsultaRegistrada[],
  /** O que o banco falso responde em cada status — números distintos de propósito. */
  porStatus: { closed: 71, archived: 29 } as { closed: number; archived: number },
  /** Uma fila na organização: é ela que faz o seletor (e a contagem por fila) existir. */
  setor: "11111111-1111-4111-8111-111111111111",
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }),
    },
    from(tabela: string) {
      const registro: ConsultaRegistrada = { tabela, filtros: [] };
      h.consultas.push(registro);
      const consulta: Record<string, unknown> = {
        select(_colunas: string, opcoes?: { count?: string; head?: boolean }) {
          registro.count = opcoes?.count;
          registro.head = opcoes?.head;
          return consulta;
        },
        eq(coluna: string, valor: unknown) {
          registro.filtros.push(["eq", coluna, valor]);
          return consulta;
        },
        not(coluna: string, _op: string, valor: unknown) {
          registro.filtros.push(["not", coluna, valor]);
          return consulta;
        },
        in(coluna: string, valor: unknown) {
          registro.filtros.push(["in", coluna, valor]);
          return consulta;
        },
        is(coluna: string, valor: unknown) {
          registro.filtros.push(["is", coluna, valor]);
          return consulta;
        },
        gt(coluna: string, valor: unknown) {
          registro.filtros.push(["gt", coluna, valor]);
          return consulta;
        },
        or(valor: string) {
          registro.filtros.push(["or", "or", valor]);
          return consulta;
        },
        filter(coluna: string, _op: string, valor: unknown) {
          registro.filtros.push(["filter", coluna, valor]);
          return consulta;
        },
        limit() {
          return consulta;
        },
        then(resolver: (v: unknown) => unknown, rejeitar?: (e: unknown) => unknown) {
          let count: number | null = null;
          if (tabela === "conversations") {
            const status = registro.filtros.find(([tipo, coluna]) => tipo === "eq" && coluna === "status");
            const chave = status ? String(status[2]) : "";
            count = chave in h.porStatus ? h.porStatus[chave as "closed" | "archived"] : 1;
          }
          const base = {
            data:
              tabela === "attendant_sectors"
                ? [{ id: h.setor }]
                : [],
            error: null,
            count,
          };
          return Promise.resolve(base).then(resolver, rejeitar);
        },
      };
      return consulta;
    },
  }),
}));

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: async () => ({ idioma: "pt-BR" }) }));
vi.mock("@/lib/auth/require-role", () => ({
  orgAtivaDaApi: async () => ({ ok: true, org: { orgId: ORG } }),
}));

const pedido = (query = ""): NextRequest =>
  ({
    nextUrl: new URL(`http://localhost/api/v1/conversations/counts${query}`),
  }) as unknown as NextRequest;

/** As consultas de CONTAGEM (as que pediram `count`), na ordem em que saíram. */
const contagens = () =>
  h.consultas.filter((c) => c.tabela === "conversations" && c.count != null);

/** As contagens DO SELETOR de filas — uma por setor, e não são abas. */
const contagensPorFila = () =>
  contagens().filter((c) =>
    c.filtros.some(([tipo, coluna]) => tipo === "eq" && coluna === "sector_id"),
  );

/** As SEIS contagens das abas — as que o badge do menu desenha. */
const contagensDasAbas = () => contagens().filter((c) => !contagensPorFila().includes(c));

/** A consulta cujo filtro de igualdade é `status = <status>`. */
const contagemDoStatus = (status: string) =>
  contagens().find((c) =>
    c.filtros.some(([tipo, coluna, valor]) => tipo === "eq" && coluna === "status" && valor === status),
  );

beforeEach(() => {
  h.consultas.length = 0;
});

describe("#4325 — as contagens das abas", () => {
  it("Fechadas é ESTIMADA: pede `count: planned`, não uma varredura exata", async () => {
    await GET(pedido());
    const fechadas = contagemDoStatus("closed");
    expect(fechadas, "nenhuma contagem de status=closed saiu").toBeTruthy();
    // O defeito original: `count: 'exact'` sobre o histórico inteiro. `planned`
    // é o plano do PostgREST (estimativa), cujo custo não cresce com as linhas.
    expect(fechadas?.count).toBe("planned");
    expect(fechadas?.head).toBe(true);
  });

  it("Arquivadas é ESTIMADA pelo mesmo motivo — é a outra pasta que só cresce", async () => {
    await GET(pedido());
    const arquivadas = contagemDoStatus("archived");
    expect(arquivadas, "nenhuma contagem de status=archived saiu").toBeTruthy();
    expect(arquivadas?.count).toBe("planned");
    expect(arquivadas?.head).toBe(true);
  });

  it("as abas ACIONÁVEIS continuam EXATAS: fila, automático, minhas e todas", async () => {
    await GET(pedido());
    const exatas = contagensDasAbas().filter((c) => c.count === "exact");
    // Quatro, e não seis: é a régua de produto — um badge de trabalho pendente
    // não pode ser "mais ou menos 30".
    expect(exatas).toHaveLength(4);
    // E nenhuma delas pediu estimativa: o conjunto é disjunto.
    expect(contagensDasAbas().filter((c) => c.count === "planned")).toHaveLength(2);
  });

  it("a contagem por FILA (seletor de setores) também continua exata", async () => {
    await GET(pedido());
    const porFila = contagensPorFila();
    // Se a organização tem uma fila, o seletor pede UMA contagem — e ela é
    // exata: o número ao lado do nome da fila é trabalho esperando gente.
    expect(porFila).toHaveLength(1);
    expect(porFila[0]?.count).toBe("exact");
  });

  it("a resposta DIZ quais números são aproximados — a tela não adivinha", async () => {
    const res = await GET(pedido());
    const corpo = (await res.json()) as { data: Record<string, unknown> };
    expect(corpo.data.aproximadas).toEqual(["closed", "archived"]);
    // Os valores continuam saindo: a estimativa preenche o badge, só não promete
    // exatidão. Zero seria "não sei", e a tela mostraria uma pasta vazia.
    expect(corpo.data.closed).toBe(h.porStatus.closed);
    expect(corpo.data.archived).toBe(h.porStatus.archived);
  });

  it("MEDIÇÃO: uma chamada faz 6 contagens no banco — 4 exatas e 2 planejadas", async () => {
    // Antes desta fatia: 6 `exact`. Depois: 4 `exact` + 2 `planned`. O número de
    // consultas não muda; o que muda é o custo das duas que crescem sem limite.
    await GET(pedido());
    const modos = contagensDasAbas().map((c) => c.count);
    expect(modos.filter((m) => m === "exact")).toHaveLength(4);
    expect(modos.filter((m) => m === "planned")).toHaveLength(2);
    expect(modos).toHaveLength(6);
    // A contagem do seletor de filas não entra na conta das abas.
    expect(contagensPorFila()).toHaveLength(1);
  });
});
