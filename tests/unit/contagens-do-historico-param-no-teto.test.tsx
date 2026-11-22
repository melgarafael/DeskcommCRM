/**
 * #4451 — o ZERO tem de continuar zero: a pasta vazia NÃO pode mostrar 1.
 *
 * ─── O que estava errado ───────────────────────────────────────────────────
 *
 * As abas de histórico ("Fechadas" e "Arquivadas") contavam com `count:
 * 'planned'` — a estimativa do planejador do Postgres. Ela custa barato, mas o
 * planejador NUNCA estima menos de UMA linha: medido com `EXPLAIN`, tabela com
 * zero linhas que casam responde `rows=1`. Consequência medida na tela: pasta
 * vazia mostrava "1 (aprox.)", e uma instalação nova nascia com as duas abas
 * assim. Na main o badge SOME quando a contagem é zero, e é isso que tem de
 * continuar valendo.
 *
 * ─── A régua de agora ──────────────────────────────────────────────────────
 *
 * `select("id").limit(100)`, sem `count`: conta-se as LINHAS que voltaram.
 * Custo limitado por construção (cem ids), número EXATO enquanto ele é pequeno
 * — o caso de toda pasta recém-criada — e "99+" quando o teto é atingido, que é
 * honesto em vez de prometer um total que ninguém contou.
 *
 * ─── Por que o dublê devolve LINHAS ────────────────────────────────────────
 *
 * O dublê antigo respondia o número pronto, e por isso NUNCA chegava no caso do
 * defeito: com `count` pedido, ele devolvia `1` para qualquer tabela. Aqui o
 * dublê devolve linhas de verdade e, quando alguém pede `count`, imita o
 * planejador (nunca menos de uma linha). É isso que faz o caso da pasta vazia
 * ficar VERMELHO se o `count: 'planned'` voltar — ver a sabotagem no PR.
 */
import type { NextRequest } from "next/server";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/v1/conversations/counts/route";
import {
  InboxFilters,
  type InboxFiltersValue,
} from "@/components/inbox/InboxFilters";
import type { ActiveOrg } from "@/lib/auth/types";

const ORG = "00000000-0000-4000-8000-0000000000aa";

type ConsultaRegistrada = {
  tabela: string;
  count?: string;
  head?: boolean;
  /** O `limit` pedido na consulta — o teto das pastas de histórico. */
  limite?: number;
  filtros: Array<[tipo: string, coluna: string, valor: unknown]>;
};

const h = vi.hoisted(() => ({
  consultas: [] as ConsultaRegistrada[],
  /**
   * Quantas linhas o banco falso tem em cada pasta de histórico. `0` é o caso
   * da instalação nova — e o que o planejador transformava em "1".
   */
  linhas: { closed: 0, archived: 0 } as { closed: number; archived: number },
  /** Uma fila na organização: é ela que faz o seletor (e a contagem por fila) existir. */
  setor: "11111111-1111-4111-8111-111111111111",
}));

/**
 * A resposta do banco falso.
 *
 * ⚠️ A parte que importa: quando a consulta pede `count`, este dublê imita o
 * PLANEJADOR — e o planejador do Postgres nunca estima menos de uma linha. Sem
 * essa imitação, um retorno ao `count: 'planned'` passaria verde aqui e só
 * apareceria na tela de quem tem a pasta vazia.
 */
function responder(tabela: string, registro: ConsultaRegistrada) {
  if (tabela === "attendant_sectors") {
    return { data: [{ id: h.setor }], error: null, count: null };
  }
  if (tabela !== "conversations") return { data: [], error: null, count: null };

  const status = registro.filtros.find(([tipo, coluna]) => tipo === "eq" && coluna === "status");
  const chave = status ? String(status[2]) : "";
  const total = chave in h.linhas ? h.linhas[chave as "closed" | "archived"] : 0;

  if (registro.count != null) {
    // `planned` = estimativa do planejador, piso de 1 linha. `exact` = o número
    // certo (as abas acionáveis usam este caminho, e o dublê é fiel a ele).
    const numero = registro.count === "planned" ? Math.max(1, total) : Math.max(chave ? total : 1, 0);
    return { data: [], error: null, count: numero };
  }

  const linhas = Array.from({ length: total }, (_, i) => ({ id: `${chave || "linha"}-${i}` }));
  const limite = registro.limite ?? linhas.length;
  return { data: linhas.slice(0, limite), error: null, count: null };
}

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
        limit(n: number) {
          registro.limite = n;
          return consulta;
        },
        then(resolver: (v: unknown) => unknown, rejeitar?: (e: unknown) => unknown) {
          return Promise.resolve(responder(tabela, registro)).then(resolver, rejeitar);
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

// ─── Os dublês que a TELA usa (mesmos do teste do badge) ───────────────────
let contagensDaTela: Record<string, unknown> | undefined;
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    activeOrg: {
      orgId: ORG,
      name: "Org",
      role: "manager",
      visibility_mode: "all",
    } satisfies ActiveOrg,
  }),
}));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [] }),
}));
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/inbox/useConversationCounts", () => ({
  useConversationCounts: () => ({ data: contagensDaTela }),
}));

const pedido = (query = ""): NextRequest =>
  ({
    nextUrl: new URL(`http://localhost/api/v1/conversations/counts${query}`),
  }) as unknown as NextRequest;

/** A resposta da rota, exatamente como o cliente HTTP a recebe. */
async function contar() {
  const res = await GET(pedido());
  const corpo = (await res.json()) as { data: Record<string, unknown> };
  return corpo.data;
}

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

/** A consulta (de LINHAS ou de contagem) cujo filtro de igualdade é `status = <status>`. */
const consultaDoStatus = (status: string) =>
  h.consultas.find(
    (c) =>
      c.tabela === "conversations" &&
      c.filtros.some(([tipo, coluna, valor]) => tipo === "eq" && coluna === "status" && valor === status),
  );

const VALUE: InboxFiltersValue = { tab: "all", search: "", onlyUnread: false };

/** O texto do gatilho da aba, como o operador lê. */
const aba = (nome: RegExp) => screen.getByRole("tab", { name: nome }).textContent ?? "";

/** Monta a barra de abas com um corpo de resposta REAL (o que a rota devolveu). */
function montarCom(contagens: Record<string, unknown>) {
  contagensDaTela = contagens;
  return render(<InboxFilters value={VALUE} onChange={() => {}} />);
}

beforeEach(() => {
  h.consultas.length = 0;
  h.linhas = { closed: 0, archived: 0 };
  contagensDaTela = undefined;
});

afterEach(cleanup);

describe("#4451 — a rota conta LINHAS, não estima", () => {
  it("pasta VAZIA responde ZERO nas duas abas — o planejador dizia 1", async () => {
    const corpo = await contar();
    // O defeito do #4451 é este número: com `count: 'planned'` o planejador
    // devolve 1 para uma tabela sem linha que case, e a pasta vazia estampava
    // "1 (aprox.)". Zero é a única resposta honesta para uma pasta vazia.
    expect(corpo.closed).toBe(0);
    expect(corpo.archived).toBe(0);
    expect(corpo.truncadas).toEqual([]);
  });

  it("A TELA não desenha badge nenhum na pasta vazia (o zero continua zero)", async () => {
    // O caminho inteiro: dublê devolve LINHAS → rota → tela. Com o `count:
    // 'planned'` de volta, a rota responderia 1, a aba mostraria "1" e este caso
    // fica VERMELHO — é a sabotagem que o PR registra.
    const corpo = await contar();
    montarCom(corpo);
    await screen.findByRole("tab", { name: /Fechadas/ });
    const fechadas = aba(/Fechadas/);
    expect(fechadas).toContain("Fechadas");
    expect(fechadas, `a pasta vazia desenhou número: "${fechadas}"`).not.toMatch(/\d/);
    expect(aba(/Arquivadas/)).not.toMatch(/\d/);
    // Nem sufixo de aproximação, nem "+" de teto: não há número para marcar.
    expect(fechadas).not.toContain("aprox.");
    expect(fechadas).not.toContain("+");
  });

  it("cem linhas viram 99+ — o número para no teto em vez de prometer um total", async () => {
    h.linhas.closed = 100;
    const corpo = await contar();
    expect(corpo.closed).toBe(99);
    expect(corpo.truncadas).toEqual(["closed"]);
    montarCom(corpo);
    expect(await screen.findByText("99+")).toBeTruthy();
    expect(aba(/Fechadas/)).toContain("99+");
  });

  it("noventa e nove linhas viram 99 EXATO — sem `+`, porque o total foi contado", async () => {
    h.linhas.closed = 99;
    const corpo = await contar();
    expect(corpo.closed).toBe(99);
    expect(corpo.truncadas).toEqual([]);
    montarCom(corpo);
    expect(await screen.findByText("99")).toBeTruthy();
    expect(aba(/Fechadas/)).not.toContain("+");
  });

  it("três linhas viram 3 — pasta pequena mostra o número exato", async () => {
    h.linhas.closed = 3;
    h.linhas.archived = 0;
    const corpo = await contar();
    expect(corpo.closed).toBe(3);
    expect(corpo.archived).toBe(0);
    expect(corpo.truncadas).toEqual([]);
    montarCom(corpo);
    expect(await screen.findByText("3")).toBeTruthy();
    expect(aba(/Arquivadas/)).not.toMatch(/\d/);
  });

  it("no teto, o badge EXPLICA o corte — não é um `+` solto", async () => {
    h.linhas.archived = 250;
    montarCom(await contar());
    expect(await screen.findByText("99+")).toBeTruthy();
    const explicacoes = screen.getAllByTitle(/histórico inteiro/);
    expect(explicacoes).toHaveLength(1);
    expect(explicacoes[0]?.textContent).toBe("99+");
  });
});

describe("#4451 — nenhuma consulta das pastas pede `count`", () => {
  it("Fechadas e Arquivadas trazem LINHAS até o teto, com `count` desligado", async () => {
    await contar();
    for (const status of ["closed", "archived"]) {
      const consulta = consultaDoStatus(status);
      expect(consulta, `nenhuma consulta de status=${status} saiu`).toBeTruthy();
      // O coração do conserto: sem `count`, e sem `head` (a resposta traz as
      // linhas). Um `count: 'planned'` voltaria a estimar — 1 na pasta vazia.
      expect(consulta?.count, `${status} voltou a pedir contagem`).toBeUndefined();
      expect(consulta?.head).toBeFalsy();
      // O teto é o que mantém o custo limitado: cem ids, não o histórico.
      expect(consulta?.limite).toBe(100);
    }
  });

  it("MEDIÇÃO: quatro contagens exatas nas abas acionáveis, nenhuma estimativa", async () => {
    await contar();
    const modos = contagensDasAbas().map((c) => c.count);
    expect(modos.filter((m) => m === "exact")).toHaveLength(4);
    // Nenhuma chamada deste arquivo pede `planned` — era ele que mentia "1".
    expect(modos.filter((m) => m === "planned")).toHaveLength(0);
    expect(modos).toHaveLength(4);
  });

  it("a aba Pessoal e a contagem por FILA continuam exatas", async () => {
    await contar();
    // A aba Pessoal recebe o `pessoalVisivel` pela fábrica (repasse conferido);
    // aqui se mede o que NÃO pode mudar: ela é `exact` e não é a lista do teto.
    const porFila = contagensPorFila();
    expect(porFila).toHaveLength(1);
    expect(porFila[0]?.count).toBe("exact");
  });

  it("a resposta DIZ quais pastas pararam no teto — a tela não adivinha", async () => {
    h.linhas = { closed: 100, archived: 99 };
    const corpo = await contar();
    expect(corpo.truncadas).toEqual(["closed"]);
    expect(corpo.closed).toBe(99);
    expect(corpo.archived).toBe(99);
  });
});
