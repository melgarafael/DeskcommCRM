import { describe, expect, it } from "vitest";

import { listConversationsHandler } from "@/app/api/v1/conversations/_handler";

/**
 * O CONTATO TEM DE ESTAR NO PRÓPRIO `WHERE`, ANTES DO `.limit` (#2184).
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 * `crm_list_conversations` filtrava o contato DEPOIS: o handler devolvia a
 * página da ORGANIZAÇÃO (10 por padrão, até 50) e a ferramenta recortava em
 * memória o que cabia nela. Duas consequências, medidas na issue:
 *
 *   1. a conversa mais ANTIGA do mesmo cliente, fora daquela página, ficava
 *      invisível para o agente — e o `has_more: false` que saía junto dizia
 *      que não havia mais nada;
 *   2. o filtro por `input.contact_id` (que já existia) mantinha o cursor, o
 *      que é pior: o cursor continuava descrevendo a varredura da
 *      ORGANIZAÇÃO, e a próxima página voltava a ser varredura.
 *
 * Filtrar em memória é sempre filtro de PÁGINA. O conserto é o predicado na
 * consulta — e é isso que este arquivo mede: o `eq("contact_id", …)` sai, sai
 * na MESMA cadeia que o de organização, e sai ANTES do `.limit`.
 *
 * Por que UNIT e não em `tests/invariants/`: o que estava errado não era o
 * SQL, era o handler nunca emitir o predicado. O invariante de banco
 * provaria a semântica da igualdade, que nunca esteve em dúvida.
 *
 * O predicado da ferramenta (o `contact_id` que ela passa ao handler) é coberto
 * em `tests/unit/leitura-do-turno-escopo-conversas.test.ts`.
 */

interface Chamada {
  tabela: string;
  metodo: string;
  args: unknown[];
}

/** Dublê que registra a cadeia POR TABELA e conta as idas ao banco. */
function fakeSupabase() {
  const chamadas: Chamada[] = [];
  const consultas: string[] = [];
  const client = {
    from: (tabela: string) => {
      consultas.push(tabela);
      const proxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              return (ok: (v: unknown) => unknown) => ok({ data: [], error: null });
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
  return { client: client as never, chamadas, consultas };
}

const ctx = {
  organization_id: "org-1",
  requestId: "req-1",
  actor: { type: "user" as const, id: "user-1" },
} as never;

const CONTATO = "22222222-2222-4222-8222-222222222222";

async function listar(query: Record<string, unknown>) {
  const { client, chamadas, consultas } = fakeSupabase();
  await listConversationsHandler(client, ctx, { limit: 50, ...query } as never);
  return { chamadas, consultas };
}

const emConversas = (c: Chamada[], metodo: string) =>
  c.filter((x) => x.tabela === "conversations" && x.metodo === metodo);

const indice = (c: Chamada[], metodo: string, args: string) =>
  c.findIndex((x) => x.tabela === "conversations" && x.metodo === metodo && x.args.join(":") === args);

describe("o filtro de contato vira predicado de consulta", () => {
  it("⭐ com `contact_id`, a consulta pede ao banco só as conversas dele", async () => {
    const { chamadas } = await listar({ contact_id: CONTATO });
    const eqs = emConversas(chamadas, "eq").map((x) => x.args.join(":"));
    expect(eqs).toContain(`contact_id:${CONTATO}`);
  });

  it("CONTROLE: sem `contact_id`, nenhum predicado de contato é emitido", async () => {
    // Sem este caso, um handler que filtrasse SEMPRE passaria no de cima — e a
    // lista da organização inteira sumiria da tela para todo mundo.
    const { chamadas } = await listar({});
    const eqs = emConversas(chamadas, "eq").map((x) => x.args.join(":"));
    expect(eqs).not.toContain(`contact_id:${CONTATO}`);
    expect(eqs.some((e) => e.startsWith("contact_id:"))).toBe(false);
  });

  it("⛔ o predicado COMPÕE sobre a consulta que já filtra a organização", async () => {
    // Este handler usa o admin client, que passa por cima da RLS: o filtro
    // manual de organização é a Única barreira. Se alguém "otimizar" abrindo
    // uma consulta nova só para o contato, ela nasce sem barreira nenhuma e
    // devolve conversa de OUTRA EMPRESA. Vendemos tenants — isto é o fim.
    const { chamadas, consultas } = await listar({ contact_id: CONTATO });
    const eqs = emConversas(chamadas, "eq").map((x) => x.args.join(":"));
    expect(eqs).toContain("organization_id:org-1");
    expect(eqs).toContain(`contact_id:${CONTATO}`);
    // E saiu na MESMA consulta: uma ida só a `conversations`.
    expect(consultas.filter((t) => t === "conversations")).toHaveLength(1);
  });

  it("⭐ o predicado sai NA MESMA consulta que o `.limit` — o cursor descreve o contato", async () => {
    // Fecha o defeito 1: o `.limit` corta o CONJUNTO, então o contato tem de
    // estar no mesmo `WHERE`. Se o recorte fosse noutro lugar (ou num filtro
    // em memória depois), o corte continuaria da ORGANIZAÇÃO e a página não
    // seria do contato — a conversa mais antiga dele ficaria invisível e o
    // `has_more: false` diria que não há mais nada.
    //
    // A ordem em que os métodos são encadeados em JS não importa (o PostgREST
    // monta a URL na hora de executar): o que importa é o predicado e o limite
    // morarem na MESMA cadeia — que é só uma ida a `conversations`.
    const { chamadas, consultas } = await listar({ contact_id: CONTATO });
    expect(indice(chamadas, "eq", `contact_id:${CONTATO}`)).toBeGreaterThanOrEqual(0);
    expect(chamadas.filter((x) => x.tabela === "conversations" && x.metodo === "limit")).toHaveLength(1);
    expect(consultas.filter((t) => t === "conversations")).toHaveLength(1);
  });

  it("combina com os demais filtros em vez de competir com eles", async () => {
    const { chamadas } = await listar({ contact_id: CONTATO, unread: true, status: ["open"] });
    const eqs = emConversas(chamadas, "eq").map((x) => x.args.join(":"));
    expect(eqs).toContain("organization_id:org-1");
    expect(eqs).toContain(`contact_id:${CONTATO}`);
    // `status` chega como LISTA e sai por `.in` (um valor vira lista de um),
    // e `unread` por `.gt` — são outras cadeias da MESMA query.
    const ins = emConversas(chamadas, "in");
    expect(ins.map((x) => x.args[0])).toContain("status");
    expect(JSON.stringify(ins.find((x) => x.args[0] === "status")?.args)).toContain("open");
    const gts = emConversas(chamadas, "gt").map((x) => x.args.join(":"));
    expect(gts).toContain("unread_count_for_assignee:0");
  });
});
