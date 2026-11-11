import { describe, expect, it } from "vitest";

import { listConversationsHandler } from "@/app/api/v1/conversations/_handler";
import { listConversationsQuerySchema } from "@/lib/schemas";

/**
 * A BUSCA DO INBOX ALCANÇA O TEXTO DAS MENSAGENS (issue #1355, fatia 1).
 *
 * ─── O defeito que este arquivo trava ────────────────────────────────────────
 * A busca casava `conversations.last_message_preview` — a ÚLTIMA mensagem,
 * truncada em 200 caracteres na ingestão — e o contato. Buscar o que o cliente
 * pediu na 3ª mensagem de um tique de 32 devolvia ZERO: quem atende rolava o fio
 * à mão para responder "onde ele falou sobre X?".
 *
 * ─── O que é provado aqui, e o que NÃO é ────────────────────────────────────
 * Aqui se prova a FORMA: que a rota consulta `messages.body`, que escopa a
 * consulta por organização, que deixa de fora mensagem oculta/revogada, que
 * soma as conversas casadas ao MESMO `or=` da lista e que devolve o trecho na
 * linha. A RLS não se prova com dublê — quem a mede contra o Postgres é
 * `tests/invariants/busca-em-mensagens-respeita-visibilidade.test.ts`.
 *
 * É por isso que a linha "a conversa que a pessoa NÃO enxerga não aparece" aqui
 * é o que o dublê devolve: a consulta de mensagens roda no client da SESSÃO, e
 * `messages_select` (0035) delega para `fn_can_view_conversation` — a MESMA
 * função que a lista usa. O dublê representa o banco já filtrado; a prova de
 * que ele filtra está no invariante.
 */

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";

const CONVERSA_ANTIGA = {
  id: "11111111-1111-4111-8111-111111111111",
  organization_id: ORG,
  last_message_at: "2026-01-02T10:00:00Z",
  last_message_preview: "bom dia, tudo bem?",
};

/** A conversa de OUTRO atendente: a RLS de `messages` não devolveria nada dela. */
const CONVERSA_ALHEIA = {
  id: "22222222-2222-4222-8222-222222222222",
  organization_id: ORG,
  last_message_at: "2026-01-03T10:00:00Z",
  last_message_preview: "mensagem de rotina",
};

const MENSAGEM_ANTIGA = {
  id: "33333333-3333-4333-8333-333333333333",
  conversation_id: CONVERSA_ANTIGA.id,
  body: "oi, sobre aquele orçamento da tangerina, ficou combinado o frete incluso",
  sent_at: "2025-12-01T09:00:00Z",
};

type Pedido = { metodo: string; args: unknown[] };

/**
 * O DUBLE DO POSTGREST: anota cada método encadeado e devolve, ao ser aguardado,
 * a base FIXA da tabela. Mesma técnica de `pre-filtro-do-comando.test.ts` — o
 * que se mede é o `WHERE` que a rota monta, não o banco.
 */
function clienteFalso(base: {
  conversations?: unknown[];
  messages?: unknown[];
  contacts?: unknown[];
}) {
  const pedidos: Record<string, Pedido[]> = {};
  const client = {
    from(tabela: string) {
      pedidos[tabela] ??= [];
      const proxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_alvo, prop) {
            if (prop === "then") {
              return (ok: (v: unknown) => unknown) =>
                ok({ data: base[tabela as keyof typeof base] ?? [], error: null });
            }
            return (...args: unknown[]) => {
              pedidos[tabela]!.push({ metodo: String(prop), args });
              return proxy;
            };
          },
        },
      );
      return proxy;
    },
  };
  return { client, pedidos };
}

function ctx() {
  return {
    organization_id: ORG,
    requestId: "req-1355",
    actor: { type: "user", id: "99999999-9999-4999-8999-999999999999" },
  };
}

async function buscar(base: Parameters<typeof clienteFalso>[0], termo = "tangerina") {
  const { client, pedidos } = clienteFalso(base);
  const resultado = await listConversationsHandler(
    client as never,
    ctx() as never,
    listConversationsQuerySchema.parse({ search: termo, limit: 10 }),
  );
  return { resultado, pedidos };
}

const orDaLista = (pedidos: Record<string, Pedido[]>): string => {
  const chamada = (pedidos.conversations ?? []).find((p) => p.metodo === "or");
  expect(chamada, "a lista não pediu nenhum `or=` — a busca não foi aplicada").toBeDefined();
  return String(chamada!.args[0]);
};

describe("a busca do Inbox alcança o texto das mensagens (#1355)", () => {
  it("a conversa cujo termo só existe numa mensagem ANTIGA volta na busca, com o trecho", async () => {
    const { resultado, pedidos } = await buscar({
      conversations: [CONVERSA_ANTIGA],
      messages: [MENSAGEM_ANTIGA],
    });

    const or = orDaLista(pedidos);
    expect(or, "o casamento em mensagem não entrou no WHERE da lista").toContain(
      `id.in.(${CONVERSA_ANTIGA.id})`,
    );
    expect(resultado.conversations).toHaveLength(1);
    expect(resultado.conversations[0]?.busca_em_mensagem?.trecho).toContain("tangerina");
    expect(resultado.conversations[0]?.busca_em_mensagem?.message_id).toBe(MENSAGEM_ANTIGA.id);
  });

  it("a consulta de mensagens é escopada pela organização e ignora oculta e revogada", async () => {
    const { pedidos } = await buscar({
      conversations: [CONVERSA_ANTIGA],
      messages: [MENSAGEM_ANTIGA],
    });

    const daMensagem = pedidos.messages ?? [];
    const tem = (metodo: string, ...args: unknown[]) =>
      daMensagem.some((p) => p.metodo === metodo && JSON.stringify(p.args) === JSON.stringify(args));

    // Sem o filtro manual de organização, o MCP (admin client, que bypassa a
    // RLS) varreria a base inteira.
    expect(tem("eq", "organization_id", ORG), "a consulta de mensagens não é escopada").toBe(true);
    expect(tem("ilike", "body", "%tangerina%"), "a busca não olha o corpo").toBe(true);
    // Mensagem oculta no CRM e mensagem revogada: o fio não as mostra, a busca
    // não pode devolvê-las pela porta dos fundos.
    expect(tem("is", "revoked_at", null)).toBe(true);
    expect(tem("is", "metadata->>crm_hidden_at", null)).toBe(true);
  });

  it("conversa que a pessoa NÃO enxerga não entra no `or=` nem no resultado", async () => {
    // O banco (RLS de `messages`) devolve só a mensagem da conversa visível; a
    // consulta da lista devolve só ela também. A conversa alheia existe na base.
    const { resultado, pedidos } = await buscar({
      conversations: [CONVERSA_ANTIGA],
      messages: [MENSAGEM_ANTIGA],
    });

    const or = orDaLista(pedidos);
    expect(or, "o id de uma conversa fora do escopo vazou para a busca").not.toContain(
      CONVERSA_ALHEIA.id,
    );
    expect(resultado.conversations.map((c) => c.id)).not.toContain(CONVERSA_ALHEIA.id);
  });

  it("o ramo de mensagem entra no MESMO `WHERE` da lista — não numa consulta paralela", async () => {
    const { pedidos } = await buscar({
      conversations: [CONVERSA_ANTIGA],
      messages: [MENSAGEM_ANTIGA],
    });

    const chamadas = pedidos.conversations ?? [];
    const indiceDoOr = chamadas.findIndex((p) => p.metodo === "or");
    const indiceDaOrg = chamadas.findIndex(
      (p) => p.metodo === "eq" && p.args[0] === "organization_id",
    );
    // `or` DEPOIS do `eq(organization_id)` = composto sobre a consulta que já
    // tinha a régua de visibilidade; uma consulta nova nasceria sem ela.
    expect(indiceDaOrg).toBeGreaterThanOrEqual(0);
    expect(indiceDoOr).toBeGreaterThan(indiceDaOrg);
  });

  it("sem casamento no texto, a busca é a de hoje (nome, telefone, última mensagem)", async () => {
    const { resultado, pedidos } = await buscar({
      conversations: [CONVERSA_ALHEIA],
      messages: [],
    });

    const chamadas = pedidos.conversations ?? [];
    // Sem contato casado a rota usa `.ilike` direto; com contato, `.or`. As duas
    // formas são "a busca de hoje" — o que não pode existir é o ramo de mensagem.
    const texto = chamadas
      .filter((p) => p.metodo === "or" || p.metodo === "ilike")
      .map((p) => JSON.stringify(p.args))
      .join("|");
    expect(texto, "a busca por conteúdo saiu junto", ).toContain("last_message_preview");
    expect(texto, "sem casamento, nada de `id.in` deve ir para a URL").not.toContain("id.in.");
    expect(resultado.conversations[0]?.busca_em_mensagem).toBeUndefined();
  });
});
