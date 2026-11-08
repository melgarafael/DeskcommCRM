import { describe, expect, it, vi } from "vitest";

/**
 * A aba "Minhas" não pode mostrar o que o atendente já fechou.
 *
 * O defeito era a soma de duas decisões que, isoladas, estão certas: a aba
 * filtrava SÓ por dono, e `Fechar` muda o status mas não solta o dono — de
 * propósito, porque quem atendeu é histórico que vale para auditoria e métrica.
 * Juntas, faziam a aba acumular para sempre tudo que a pessoa já atendeu, e o
 * badge contar um trabalho que não existe mais.
 *
 * A correção é na VISTA, não no dado: `exclude_finished` esconde os estados
 * terminais. As fechadas continuam existindo, com dono, na aba Fechadas.
 *
 * Os três elos da corrente são provados separados porque quebram separados:
 * o significado da aba, a serialização para a query string, e o predicado SQL.
 */

import { listConversationsHandler } from "@/app/api/v1/conversations/_handler";
import { tabToFilter } from "@/components/inbox/InboxLayout";
import { CONVERSATION_TERMINAL_STATUSES, listConversationsQuerySchema } from "@/lib/schemas";

// ---------------------------------------------------------------------------
// elo 1 — o significado da aba
// ---------------------------------------------------------------------------

describe("tabToFilter — o que cada aba significa", () => {
  it("Minhas pede as minhas SEM as terminais", () => {
    expect(tabToFilter("mine")).toEqual({ assigned_to: "me", exclude_finished: true });
  });

  it("Fechadas continua mostrando as fechadas — senão não sobra onde vê-las", () => {
    expect(tabToFilter("closed")).toEqual({ status: "closed" });
  });

  it("a Fila pergunta QUEM MANDA, não o status — e o valor mudou por medição", () => {
    // ESTE `toEqual` MUDOU EM 2026-08-30, e o motivo fica escrito para a próxima
    // sessão não "consertar" de volta.
    //
    // O par anterior (`assigned_to=unassigned` + os dois estados de espera) tinha
    // consertado um defeito real: a conversa escalada é `pending` e sumia de toda
    // aba. Só que ele carregava outro: "sem dono e aberta" é TAMBÉM a conversa
    // que o robô está atendendo agora. Medido na VPS: a Fila mostrava 83 e o
    // automático comandava 47 delas — o atendente via como trabalho seu quase
    // tudo que já estava sendo respondido.
    //
    // `comandosDaFila` responde a pergunta certa e continua cobrindo a conversa
    // escalada (ela é `aguardando`, por causa do silêncio, não do status).
    expect(tabToFilter("unassigned")).toEqual({ comando: ["aguardando"] });
  });

  it("numa org SEM automático, a Fila também traz o que ninguém está atendendo", () => {
    // O controle do caso acima. Sem ele, a Fila de uma instalação recém-instalada
    // — que ainda não publicou agente — nasceria VAZIA com clientes esperando,
    // que é o pior estado possível na primeira impressão. O valor é `ninguem`
    // porque é ele que o campo calculado emite nas organizações sem agente
    // publicado desde a migration 9252 (#4012).
    expect(tabToFilter("unassigned", false)).toEqual({
      comando: ["aguardando", "ninguem"],
    });
  });

  it("a aba do automático pergunta a régua do MOTOR, não `ai_handling`", () => {
    // `ai_handling` é escrito por UM caminho só em produção (a volta pelo botão
    // "Devolver ao automático"), e por isso a aba mostrava 2 enquanto o robô
    // atendia 47.
    expect(tabToFilter("ai")).toEqual({ comando: ["automatico"] });
  });

  it("as outras abas não ganham o filtro de tabela", () => {
    expect(tabToFilter("unassigned").exclude_finished).toBeUndefined();
    expect(tabToFilter("all").exclude_finished).toBeUndefined();
    expect(tabToFilter("ai").exclude_finished).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// elo 2 — a query string
// ---------------------------------------------------------------------------

describe("schema da rota", () => {
  it("aceita exclude_finished", () => {
    const r = listConversationsQuerySchema.safeParse({ exclude_finished: true });
    expect(r.success).toBe(true);
    expect(r.success && r.data.exclude_finished).toBe(true);
  });

  it("sem o parâmetro, fica indefinido — nenhuma aba herda o filtro sem pedir", () => {
    const r = listConversationsQuerySchema.safeParse({});
    expect(r.success && r.data.exclude_finished).toBeUndefined();
  });

  it("os estados terminais são fechada e arquivada", () => {
    expect([...CONVERSATION_TERMINAL_STATUSES]).toEqual(["closed", "archived"]);
  });
});

// ---------------------------------------------------------------------------
// elo 3 — o predicado SQL
// ---------------------------------------------------------------------------

/** Registra a cadeia do PostgREST; resolve como lista vazia no `await`. */
function fakeSupabase() {
  const chamadas: { metodo: string; args: unknown[] }[] = [];
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (ok: (v: unknown) => unknown) => ok({ data: [], error: null });
        }
        return (...args: unknown[]) => {
          chamadas.push({ metodo: String(prop), args });
          return proxy;
        };
      },
    },
  ) as Record<string, unknown>;
  return { client: { from: () => proxy } as never, chamadas };
}

const ctx = {
  organization_id: "org-1",
  requestId: "req-1",
  actor: { type: "user" as const, id: "user-1" },
} as never;

async function rodar(q: Record<string, unknown>) {
  const { client, chamadas } = fakeSupabase();
  await listConversationsHandler(client, ctx, { limit: 50, ...q } as never);
  return chamadas;
}

/** O `.not("status","in","(closed,archived)")` que esconde as terminais. */
const temNotTerminal = (chamadas: { metodo: string; args: unknown[] }[]) =>
  chamadas.some(
    (c) =>
      c.metodo === "not" &&
      c.args[0] === "status" &&
      c.args[1] === "in" &&
      String(c.args[2]).includes("closed") &&
      String(c.args[2]).includes("archived"),
  );

describe("listConversationsHandler — predicado", () => {
  it("com exclude_finished, exclui as terminais no BANCO (não na tela)", async () => {
    expect(temNotTerminal(await rodar({ assigned_to: "me", exclude_finished: true }))).toBe(true);
  });

  it("sem exclude_finished, NÃO exclui nada — Todas e Fechadas seguem inteiras", async () => {
    expect(temNotTerminal(await rodar({ assigned_to: "me" }))).toBe(false);
    expect(temNotTerminal(await rodar({ status: "closed" }))).toBe(false);
  });

  it("status terminal + exclude_finished aplica os DOIS: contradição devolve vazio", async () => {
    const chamadas = await rodar({ status: ["closed"], exclude_finished: true });
    // `in` e não `eq`: o filtro de status virou lista para a aba Fila poder pedir
    // os DOIS estados de espera (open + pending). Um valor só continua chegando,
    // agora como lista de um.
    expect(chamadas.some((c) => c.metodo === "in" && c.args[0] === "status")).toBe(true);
    expect(temNotTerminal(chamadas)).toBe(true);
  });

  it("continua filtrando por organização — o filtro novo não desloca o de tenant", async () => {
    const chamadas = await rodar({ assigned_to: "me", exclude_finished: true });
    expect(
      chamadas.some((c) => c.metodo === "eq" && c.args[0] === "organization_id" && c.args[1] === "org-1"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// o badge tem que espelhar a aba
// ---------------------------------------------------------------------------

describe("contador de Minhas", () => {
  it("usa o mesmo conjunto de estados terminais que a aba", async () => {
    // Lê a fonte da rota de counts em vez de repetir a string: o que quebra
    // aqui é o badge e a aba discordarem, e um literal duplicado no teste
    // esconderia exatamente isso.
    const { readFileSync } = await import("node:fs");
    const fonte = readFileSync("app/api/v1/conversations/counts/route.ts", "utf8");

    expect(fonte).toContain("CONVERSATION_TERMINAL_STATUSES");
    expect(fonte).toMatch(/assigned_to_user_id[\s\S]{0,200}not\(\s*"status"\s*,\s*"in"/);
  });
});

vi.resetModules();
