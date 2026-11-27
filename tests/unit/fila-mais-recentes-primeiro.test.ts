/**
 * A FILA PODE MOSTRAR O CONTATO QUE ACABOU DE CHEGAR EM CIMA.
 *
 * Medido numa instalação em produção em 21/11/2026: 52 esperas antigas na Fila, e a conversa
 * nova ficou na posição 53 — fora da primeira página (50). O atendente abria a
 * Fila e não via o contato novo, que só aparecia em "Todas".
 *
 *  1. `ordem_fila=recentes` pede `awaiting_since` DECRESCENTE (a mesma coluna);
 *  2. sem o parâmetro, a Fila segue na fila de banco (crescente);
 *  3. fora da Fila o parâmetro não muda nada;
 *  4. o cursor acompanha a direção: na ordem recente, a próxima página é `lt`.
 */
import { describe, expect, it } from "vitest";

import { listConversationsHandler } from "@/app/api/v1/conversations/_handler";

interface Chamada {
  tabela: string;
  metodo: string;
  args: unknown[];
}

function fakeSupabase() {
  const chamadas: Chamada[] = [];
  const client = {
    from: (tabela: string) => {
      const proxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: [], error: null });
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

const ctx = { organization_id: "org-1", requestId: "req-1", actor: { type: "user" as const, id: "user-1" } } as never;

async function listar(query: Record<string, unknown>) {
  const { client, chamadas } = fakeSupabase();
  await listConversationsHandler(client, ctx, { limit: 50, ...query } as never);
  return chamadas.filter((x) => x.tabela === "conversations");
}

const ordens = (c: Chamada[]) =>
  c
    .filter((x) => x.metodo === "order")
    .map((x) => `${x.args[0]} ${(x.args[1] as { ascending?: boolean })?.ascending ? "asc" : "desc"}`);

describe("a ordem da Fila", () => {
  it("⭐ recentes: a mesma coluna de espera, decrescente", async () => {
    expect(ordens(await listar({ comando: ["aguardando", "ninguem"], ordem_fila: "recentes" }))).toEqual([
      "awaiting_since desc",
      "id desc",
    ]);
  });

  it("sem o parâmetro, a Fila segue na fila de banco", async () => {
    expect(ordens(await listar({ comando: ["aguardando", "ninguem"] }))).toEqual([
      "awaiting_since asc",
      "id asc",
    ]);
  });

  it("CONTROLE: fora da Fila o parâmetro não muda a ordem", async () => {
    expect(ordens(await listar({ ordem_fila: "recentes" }))).toEqual(["last_message_at desc", "id desc"]);
  });

  it("o cursor acompanha a direção: na ordem recente a próxima página vem com `lt`", async () => {
    // O mesmo formato do cursor da rota (JSON em base64url).
    const cursor = Buffer.from(JSON.stringify({ sort: "2026-11-21T15:32:05Z", id: "c1" }), "utf8").toString("base64url");
    const c = await listar({ comando: ["aguardando"], ordem_fila: "recentes", cursor });
    const or = c.filter((x) => x.metodo === "or").map((x) => String(x.args[0]));
    expect(or.some((f) => f.startsWith("awaiting_since.lt."))).toBe(true);
  });
});
