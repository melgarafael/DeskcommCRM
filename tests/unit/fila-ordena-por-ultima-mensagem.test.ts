import { describe, expect, it } from "vitest";

import { listConversationsHandler } from "@/app/api/v1/conversations/_handler";

/**
 * A ABA FILA ORDENA PELA MESMA REGRA DAS DEMAIS ABAS (#639 — o defeito que o
 * operador relatou no #464).
 *
 * ─── O defeito, como o operador o viu ────────────────────────────────────────
 * "no inbox, quando esta na aba fila a ornação (classificacao) das conversas fica
 * aleatorio. deveria ficar por hora (ultima msg mais recente no topo e a mais
 * antiga no final) já quando entra no todas, ele classifica corretamente por
 * horario." (#464)
 *
 * Não era aleatório: era OUTRA ordem. A Fila era a única aba com `ORDER BY` próprio
 * (tempo de espera, `last_inbound_at` ASC), enquanto a linha mostra o relógio de
 * `last_message_at` ("há X min"). Numa lista ordenada por uma coluna e legendada
 * com outra, os minutos não são monotônicos de cima para baixo — e a MESMA conversa
 * muda de lugar ao trocar de aba, que é o que o operador comparou.
 *
 * ─── Por que este arquivo mede o PEDIDO feito ao banco ───────────────────────
 * Quem ordena a lista é o BANCO: a página chega pronta e é desenhada na ordem que
 * veio. O que estava errado era o handler pedir a ordem errada. Então medimos o
 * `ORDER BY` emitido, com a cadeia do supabase dublada (mesmo padrão de
 * `nao-lidos-filtra-no-banco`). Um teste que olhasse o JSX do componente passaria
 * com o defeito em pé.
 *
 * ─── Sabotagem ──────────────────────────────────────────────────────────────
 * Tirar o `ORDER BY last_message_at` do handler — ou a Fila voltar a pedir a ordem
 * de espera — deixa os testes marcados com ⭐ VERMELHOS: sem o pedido, a página sai
 * na ordem em que o banco a devolveu.
 */

const AVISO =
  "A Fila é a única aba em que a ordem já foi uma decisão; se ela voltar a ter ORDER BY próprio (tempo de espera) a lista parece aleatória (#464). A ordem de exibição do inbox é last_message_at DESC, nulls last, id DESC (#639).";

interface Chamada {
  tabela: string;
  metodo: string;
  args: unknown[];
}

type Spec = { ascending?: boolean; nullsFirst?: boolean } | undefined;

interface Linha {
  id: string;
  last_message_at: string | null;
}

/** Página como o banco a devolveu, e de propósito FORA da ordem de exibição. */
const PAGINA_DA_FILA: Linha[] = [
  { id: "conv-antiga", last_message_at: "2026-08-18T09:00:00.000Z" }, // escreveu às 9h
  { id: "conv-recente", last_message_at: "2026-08-18T15:00:00.000Z" }, // escreveu às 15h
  { id: "conv-sem-mensagem", last_message_at: null }, // nunca recebeu mensagem
];

function fakeSupabase(pagina: Linha[]) {
  const chamadas: Chamada[] = [];
  const client = {
    from: (tabela: string) => {
      const proxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              return (ok: (v: unknown) => unknown) =>
                ok({ data: tabela === "conversations" ? pagina : [], error: null });
            }
            return (...args: unknown[]) => {
              chamadas.push({ tabela, metodo: String(prop), args });
              return proxy;
            };
          },
        },
      );
      return proxy;
    },
  };
  return { client: client as never, chamadas };
}

const ctx = {
  organization_id: "org-1",
  requestId: "req-1",
  actor: { type: "user" as const, id: "user-1" },
} as never;

async function listar(pagina: Linha[], query: Record<string, unknown> = {}) {
  const { client, chamadas } = fakeSupabase(pagina);
  await listConversationsHandler(client, ctx, { limit: 50, ...query } as never);
  return chamadas;
}

const ordens = (c: Chamada[]) =>
  c.filter((chamada) => chamada.tabela === "conversations" && chamada.metodo === "order");

const ordemDe = (c: Chamada[], coluna: string) =>
  ordens(c).filter((chamada) => chamada.args[0] === coluna);

/** Réplica de ORDER BY do Postgres, o suficiente para reordenar a página do dublê. */
function ordenarComoOPedido(linhas: Linha[], specs: Array<[string, Spec]>): string[] {
  const comparar = (a: string | null, b: string | null, spec: Spec): number => {
    if (a === b) return 0;
    if (a === null) return spec?.nullsFirst === false ? 1 : -1;
    if (b === null) return spec?.nullsFirst === false ? -1 : 1;
    const base = a < b ? -1 : 1;
    return spec?.ascending === false ? -base : base;
  };
  return [...linhas]
    .sort((a, b) => {
      for (const [coluna, spec] of specs) {
        const cmp = comparar(a[coluna as keyof Linha], b[coluna as keyof Linha], spec);
        if (cmp !== 0) return cmp;
      }
      return 0;
    })
    .map((linha) => linha.id);
}

describe("a aba Fila ordena por atividade recente, como o resto do inbox", () => {
  it("⭐ pede ao banco a mesma ordem das demais abas: last_message_at DESC, nulls last, id DESC", async () => {
    const c = await listar([], { comando: "aguardando" });
    const pedido = ordemDe(c, "last_message_at")[0];
    if (pedido === undefined) throw new Error(`a Fila não pediu ordem nenhuma: ${JSON.stringify(c)}`);

    // DESC porque o topo é a mensagem MAIS RECENTE (#464: "a mais antiga no final").
    expect(pedido.args[1], AVISO).toMatchObject({ ascending: false });
    // Sem `nullsFirst: false` o Postgres põe as conversas sem mensagem no TOPO do
    // DESC — três linhas de conversa vazia por cima do atendimento de verdade.
    expect(pedido.args[1], AVISO).toMatchObject({ nullsFirst: false });

    // Empate de horário tem de ter desempate determinístico, senão a lista oscila
    // entre duas requisições idênticas (que é "aleatório" de novo, e com razão).
    const desempate = c.find(
      (chamada) =>
        chamada.tabela === "conversations" &&
        chamada.metodo === "order" &&
        chamada.args[0] === "id",
    );
    expect(desempate?.args[1], AVISO).toMatchObject({ ascending: false });
  });

  it("a Fila NÃO tem mais uma ordem só dela (tempo de espera)", async () => {
    const c = await listar([], { comando: "aguardando" });
    expect(
      ordemDe(c, "last_inbound_at").map((chamada) => chamada.args),
      AVISO,
    ).toEqual([]);
    // E continua filtrada pela fila: a ordem mudou, a membresia não.
    expect(c.some((chamada) => chamada.metodo === "eq" || chamada.metodo === "in")).toBe(true);
  });

  it("CONTROLE: a aba Todas já ordenava por atividade — e não mudou", async () => {
    const c = await listar([], {});
    const pedido = ordemDe(c, "last_message_at")[0];
    expect(pedido, "a aba Todas sempre ordenou por last_message_at").toBeDefined();
    expect(pedido?.args[1]).toMatchObject({ ascending: false, nullsFirst: false });
  });

  it("⭐ duas conversas na fila: a de mensagem mais nova em cima (o caso do #464)", async () => {
    const c = await listar([...PAGINA_DA_FILA], { comando: "aguardando" });
    const pedidos = ordens(c);
    if (pedidos.length === 0) {
      throw new Error(`a Fila não pediu ordem nenhuma: ${JSON.stringify(c)}`);
    }

    const exibidas = ordenarComoOPedido(
      PAGINA_DA_FILA,
      pedidos.map((chamada) => [String(chamada.args[0]), chamada.args[1] as Spec]),
    );

    expect(exibidas, AVISO).toEqual(["conv-recente", "conv-antiga", "conv-sem-mensagem"]);
  });

  it("⛔ a ordem é pedida JUNTO com o filtro de organização, na mesma consulta", async () => {
    // O handler usa o admin client (passa por cima da RLS): o filtro manual de
    // organização é a única barreira — e a ordem não pode vir de uma consulta nova.
    const c = await listar([], { comando: "aguardando" });
    expect(
      c.some(
        (chamada) =>
          chamada.tabela === "conversations" &&
          chamada.metodo === "eq" &&
          chamada.args.join(":") === "organization_id:org-1",
      ),
    ).toBe(true);
    expect(ordens(c).length, AVISO).toBeGreaterThan(0);
  });
});
