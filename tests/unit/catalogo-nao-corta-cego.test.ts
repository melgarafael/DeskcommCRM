/**
 * A BUSCA DO CATÁLOGO NÃO CORTA CEGO — E NÃO AFIRMA AUSÊNCIA SOBRE AMOSTRA
 * (issue #480).
 *
 * ─── O defeito, medido em c5b45b24 ──────────────────────────────────────────
 *
 * `lib/mcp/tools/comercio.ts` trazia os candidatos e pontuava em memória:
 *
 *     .eq("organization_id", ctx.organizationId)
 *     .eq("ativo", true)
 *     .limit(2000)          // ← sem .order()
 *
 * CONTROLE POSITIVO dentro do mesmo arquivo: a consulta de PEDIDOS (linha 44)
 * TEM `.order("ordered_at", …)`. A sonda enxerga `.order` quando ele existe; na
 * consulta do catálogo não havia nenhum.
 *
 * Sem `ORDER BY`, o Postgres devolve N linhas ARBITRÁRIAS — a ordem é a que o
 * plano der, e muda com o tempo, com o vacuum e com o plano. Numa loja acima do
 * teto, o produto pedido pode simplesmente não estar no lote que veio, e a busca
 * responde:
 *
 *     "não há nada com esse nome no catálogo da loja."
 *
 * O agente diz "não temos" para um produto que a loja TEM.
 *
 * ─── O teto é METADE do que o código pede ───────────────────────────────────
 *
 * `supabase/config.toml:12` declara `max_rows = 1000`. O PostgREST corta a
 * resposta nesse número, então o `.limit(2000)` nunca trouxe 2000 — trouxe no
 * máximo 1000. O defeito é o dobro do reportado, e nenhum limite escrito no
 * código dizia isso.
 *
 * Por isso a truncagem não pode ser deduzida de `linhas.length === limite`: o
 * corte é do SERVIDOR e o cliente não sabe qual é. Quem sabe é o `count`, que a
 * consulta passa a pedir — a varredura parcial vira DADO, não adivinhação.
 *
 * ─── O que muda no desfecho ─────────────────────────────────────────────────
 *
 * Não achar entre uma amostra e não achar no catálogo são coisas diferentes, e
 * a única errada é afirmar a segunda quando se mediu a primeira.
 */
import { describe, expect, it, vi } from "vitest";

import { crmSearchProducts } from "@/lib/mcp/tools/comercio";

interface Chamada {
  metodo: string;
  args: unknown[];
}

/**
 * Dublê do PostgREST que se comporta como o servidor real: aplica `range`,
 * devolve `count` TOTAL (não o da página) e — quando pedido — CORTA a página
 * num teto próprio, como o `max_rows` faz.
 *
 * Um dublê que devolvesse tudo de uma vez aprovaria o código que ignora
 * paginação, que é metade do defeito.
 */
function fakeDb(total: number, tetoDoServidor = 1000, contaOculta = false) {
  const chamadas: Chamada[] = [];
  const linhas = Array.from({ length: total }, (_, i) => ({
    id: `p${i}`,
    codigo: `COD${String(i).padStart(6, "0")}`,
    // Só o ÚLTIMO produto casa a busca. Se a varredura parar antes do fim, ele
    // não é alcançado — que é exatamente o defeito desta issue.
    nome: i === total - 1 ? "Perfume Importado Raro" : `Item Generico ${i}`,
    descricao: null,
    marca: null,
    categoria: null,
    preco_cents: 1000 + i,
    moeda: "BRL",
    controla_estoque: false,
    quantidade: 0,
  }));

  let de = 0;
  let ate = tetoDoServidor - 1;
  let limite: number | null = null;

  const q: Record<string, unknown> = {};
  const registra = (metodo: string) => (...args: unknown[]) => {
    chamadas.push({ metodo, args });
    if (metodo === "range") {
      de = args[0] as number;
      ate = args[1] as number;
    }
    if (metodo === "limit") limite = args[0] as number;
    return q;
  };
  for (const m of ["select", "eq", "order", "range", "limit", "is"]) q[m] = registra(m);
  (q as { then: unknown }).then = (ok: (v: unknown) => unknown) => {
    const fim = Math.min(ate + 1, de + tetoDoServidor, limite ?? Infinity, total);
    return Promise.resolve(
      ok({ data: linhas.slice(de, fim), error: null, count: contaOculta ? null : total }),
    );
  };

  return {
    chamadas,
    ctx: {
      supabase: { from: () => q },
      organizationId: "org-1",
    } as never,
  };
}

const buscar = (db: ReturnType<typeof fakeDb>, termo: string) =>
  crmSearchProducts.handler({ termo, limite: 5 } as never, db.ctx) as Promise<{
    produtos: unknown[];
    mensagem?: string;
  }>;

describe("a consulta do catálogo é determinística", () => {
  it("⭐ pede ORDER BY — sem ele o lote que vem é arbitrário e muda com o plano", async () => {
    const db = fakeDb(50);
    await buscar(db, "perfume");

    const ordens = db.chamadas.filter((c) => c.metodo === "order");
    expect(
      ordens.length,
      "a consulta do catálogo não ordena: o Postgres devolve linhas arbitrárias e o corte vira amostragem cega",
    ).toBeGreaterThan(0);
  });

  it("continua isolando por organização e por ativo", async () => {
    // Guarda contra o conserto quebrar o que já estava certo: service role
    // bypassa RLS, então o filtro de organização é obrigatório.
    const db = fakeDb(10);
    await buscar(db, "perfume");
    const eqs = JSON.stringify(db.chamadas.filter((c) => c.metodo === "eq"));
    expect(eqs).toContain("organization_id");
    expect(eqs).toContain("ativo");
  });
});

describe("catálogo maior que o teto do servidor", () => {
  it("⭐ acha o produto que está DEPOIS do teto de uma página", async () => {
    // 2500 produtos, servidor cortando em 1000: sem paginação o produto que
    // casa (o último) nunca é alcançado, e o agente diz "não temos".
    const db = fakeDb(2500, 1000);
    const r = await buscar(db, "perfume importado raro");

    expect(
      r.produtos.length,
      "o produto existe no catálogo e a busca não o alcançou — é o defeito desta issue",
    ).toBeGreaterThan(0);
  });

  it("⭐ quando a varredura NÃO foi completa, a resposta deixa de afirmar ausência", async () => {
    // Teto de varredura estourado: o certo é dizer que não achou no que varreu,
    // nunca que o catálogo não tem. As duas frases levam o agente a condutas
    // diferentes com o cliente.
    const db = fakeDb(200_000, 1000);
    const r = await buscar(db, "coisa que nao existe em lugar nenhum");

    expect(r.produtos).toEqual([]);
    const msg = String(r.mensagem ?? "");
    expect(
      /não há nada com esse nome no catálogo/i.test(msg),
      `afirmou ausência sobre uma amostra: ${msg}`,
    ).toBe(false);
    // E precisa DIZER o que houve, senão o agente inventa a explicação.
    expect(msg.length, "não achou e não disse por quê").toBeGreaterThan(20);
  });

  it("catálogo pequeno segue afirmando ausência — e deve", async () => {
    // Controle na direção oposta. Sem este caso, um "conserto" que nunca mais
    // afirmasse ausência passaria — e o agente deixaria de dizer "não temos"
    // para produto que a loja realmente não tem, que é informação útil.
    const db = fakeDb(30, 1000);
    const r = await buscar(db, "coisa que nao existe em lugar nenhum");

    expect(r.produtos).toEqual([]);
    expect(String(r.mensagem)).toMatch(/não há nada com esse nome no catálogo/i);
  });

  it("a varredura tem teto declarado — não puxa catálogo de 200 mil linhas para a memória", async () => {
    const db = fakeDb(200_000, 1000);
    await buscar(db, "perfume");

    const paginas = db.chamadas.filter((c) => c.metodo === "range").length;
    expect(paginas, "varreu sem teto: uma busca puxaria o catálogo inteiro").toBeLessThanOrEqual(10);
    expect(paginas, "não paginou nada").toBeGreaterThan(0);
  });
});

/**
 * ⚠️ O RAMO EM QUE O `count` NÃO VEM — reprodução antes do conserto.
 *
 * `count` é `number | null` no client. Quando ele vem `null` (cabeçalho
 * `Content-Range` ausente ou não parseável — proxy, versão, gateway), o laço
 * fazia `total = count ?? total` com `total` iniciado em 0, e a condição de
 * parada `linhas.length >= total` virava `>= 0`: verdadeira SEMPRE, já na
 * primeira página.
 *
 * O desfecho é o defeito da issue #480 DE VOLTA, e pior: `varreduraParcial`
 * fica `false` (0 > 1000 é falso), então a busca afirma ausência com confiança
 * sobre uma amostra de uma página. O dublê original sempre fornece `count`, e
 * por isso nada vigiava este ramo.
 */
describe("o count ausente não pode virar 'varri o catálogo inteiro'", () => {
  it("loja de 3000 itens com count nulo: acha o produto que só existe no fim", async () => {
    const db = fakeDb(3000, 1000, true);
    const r = await buscar(db, "perfume importado raro");
    expect(r.produtos.length, "parou na primeira página e não alcançou o produto").toBeGreaterThan(0);
  });

  it("varredura que ESTOURA o teto de páginas não afirma ausência, mesmo sem count", async () => {
    // 12000 > PAGINAS_MAXIMAS × TAMANHO_DA_PAGINA (10 × 1000): a varredura é
    // genuinamente parcial, e sem `count` ela precisa saber disso pelo fato de
    // ter esgotado as páginas — não por uma conta com um total que não veio.
    const db = fakeDb(12000, 1000, true);
    const r = await buscar(db, "produto que nao existe em lugar nenhum");
    expect(r.produtos).toHaveLength(0);
    expect(
      r.mensagem ?? "",
      "afirmou 'a loja não tem' depois de varrer 10 mil de 12 mil",
    ).not.toMatch(/não há nada com esse nome/i);
  });

  it("⚠️ CONTROLE: varredura que CHEGA ao fim sem count PODE afirmar ausência", async () => {
    // Sem este caso, "nunca afirme ausência quando o count faltar" satisfaria o
    // anterior — e a busca viraria eternamente evasiva numa loja pequena cujo
    // servidor não manda `Content-Range`. A página vazia É prova de fim.
    const db = fakeDb(2500, 1000, true);
    const r = await buscar(db, "produto que nao existe em lugar nenhum");
    expect(r.produtos).toHaveLength(0);
    expect(r.mensagem ?? "").toMatch(/não há nada com esse nome/i);
  });
});
