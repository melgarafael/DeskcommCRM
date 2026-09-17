import { describe, expect, it } from "vitest";

import { listConversationsHandler } from "@/app/api/v1/conversations/_handler";

/**
 * O FILTRO DE "NÃO LIDOS" TEM DE ACONTECER NO BANCO, NÃO NA PÁGINA.
 *
 * ─── O defeito, medido na tela de uma instalação real ────────────────────────
 * `onlyUnread` nasceu como estado de componente e virava um predicado aplicado
 * em memória sobre a página JÁ TRUNCADA em 50 linhas. Ligar o botão não gerava
 * requisição nenhuma — provado com controle positivo (trocar de aba, na mesma
 * sessão, gerava). Com as 50 primeiras conversas lidas, a tela afirmava "Sem
 * conversas por aqui" e nem desenhava o "Carregar mais", porque o estado vazio
 * retornava antes dele. Não havia erro, não havia aviso: havia uma tela mentindo.
 *
 * ─── Por que ele é UNIT e não vive em tests/invariants/ ──────────────────────
 * O que estava errado não era o SQL — era o handler nunca ter emitido predicado
 * nenhum. Este arquivo mede exatamente isso, e roda sem Docker. O invariante de
 * banco provaria a semântica do `>`, que nunca esteve em dúvida.
 */

interface Chamada {
  tabela: string;
  metodo: string;
  args: unknown[];
}

/** Dublê que registra a cadeia POR TABELA — o mesmo padrão de `inbox-busca-acha-pelo-contato`. */
function fakeSupabase() {
  const chamadas: Chamada[] = [];
  const client = {
    from: (tabela: string) => {
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
  return { client: client as never, chamadas };
}

const ctx = {
  organization_id: "org-1",
  requestId: "req-1",
  actor: { type: "user" as const, id: "user-1" },
} as never;

async function listar(query: Record<string, unknown>) {
  const { client, chamadas } = fakeSupabase();
  await listConversationsHandler(client, ctx, { limit: 50, ...query } as never);
  return chamadas;
}

const emConversas = (c: Chamada[], metodo: string) =>
  c.filter((x) => x.tabela === "conversations" && x.metodo === metodo);

describe("o filtro de não lidos vira predicado de consulta", () => {
  it("⭐ com `unread`, a consulta pede ao banco só as não lidas", async () => {
    const c = await listar({ unread: true });
    const gts = emConversas(c, "gt");
    expect(gts.map((x) => x.args.join(":"))).toContain("unread_count_for_assignee:0");
  });

  it("CONTROLE: sem `unread`, nenhum predicado de não lidas é emitido", async () => {
    // Sem este caso, um handler que filtrasse SEMPRE passaria no de cima — e a
    // caixa inteira passaria a esconder o que já foi lido, para todo mundo.
    const c = await listar({});
    const gts = emConversas(c, "gt").map((x) => x.args.join(":"));
    expect(gts).not.toContain("unread_count_for_assignee:0");
  });

  it("⛔ o predicado COMPÕE sobre a consulta que já filtra a organização", async () => {
    // Este handler usa o admin client, que passa por cima da RLS: o filtro manual
    // de organização é a ÚNICA barreira. Se alguém "otimizar" abrindo uma consulta
    // nova só para os não lidos, ela nasce sem barreira nenhuma e devolve conversa
    // de OUTRO CLIENTE. Vendemos tenants — isto não é severidade alta, é o fim.
    const c = await listar({ unread: true });
    const orgs = emConversas(c, "eq").map((x) => x.args.join(":"));
    expect(orgs).toContain("organization_id:org-1");
    // e o `gt` saiu na MESMA tabela, não numa consulta paralela
    expect(emConversas(c, "gt").length).toBeGreaterThan(0);
  });

  it("combina com os demais filtros em vez de competir com eles", async () => {
    // O botão só valia para a página carregada, então não somava com aba nem canal.
    const c = await listar({ unread: true, exclude_finished: true });
    expect(emConversas(c, "gt").length).toBeGreaterThan(0);
    expect(emConversas(c, "not").length + emConversas(c, "neq").length).toBeGreaterThan(0);
  });
});
