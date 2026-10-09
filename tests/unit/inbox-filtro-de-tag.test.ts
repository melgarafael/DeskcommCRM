/**
 * O FILTRO POR TAG DO INBOX FILTRA.
 *
 * ## O defeito que fez este arquivo existir
 *
 * A cadeia do filtro por tag existia inteira e rompia num ponto só, no meio:
 *
 *   `components/inbox/InboxFilters.tsx`       mostra o select "Filtrar por tag"
 *   `hooks/inbox/useConversationsRealtime.ts` faz `qs.set("tag", filters.tag)`
 *   `app/api/v1/conversations/route.ts`       lia 6 params — e `tag` NÃO era um deles
 *   `app/api/v1/conversations/_handler.ts`    `if (q.tag) query.contains("tags", [q.tag])`
 *
 * O usuário escolhia uma tag, o browser mandava `?tag=vip`, a rota descartava e a
 * lista voltava inteira. **Sem erro** — que é o que torna esta classe cara: um
 * controle visível que não faz nada não gera ticket, gera desconfiança na tela.
 *
 * Achado por @jmpo, que o documentou no cabeçalho de
 * `tests/unit/inbox-aba-minhas-encanamento.test.tsx` do PR #199 e — corretamente —
 * não o consertou, porque estava fora do escopo do PR dele.
 *
 * ## Por que o teste é da ROTA, e não do handler
 *
 * O handler já estava certo: `if (q.tag) query.contains(...)` está lá desde sempre.
 * Um teste que chamasse `listConversationsHandler` com `{tag:"vip"}` passaria com o
 * defeito VIVO — o elo quebrado era a leitura de `searchParams`, uma camada acima.
 * Por isso aqui se chama `GET` com uma query string de verdade e se afere o que o
 * handler RECEBEU.
 *
 * Sabotar a linha `tag:` de `route.ts` deixa `_handler.ts` intacto, o símbolo
 * `q.tag` presente e todo `grep` verde. É a perda silenciosa que este arquivo vigia.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listConversationsHandler = vi.fn(async () => ({
  conversations: [],
  cursor: null,
  has_more: false,
}));

vi.mock("@/app/api/v1/conversations/_handler", () => ({ listConversationsHandler }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u-1" } }, error: null }) },
  }),
}));
vi.mock("@/lib/auth/server", () => ({
  mfaEmDivida: vi.fn(async () => false),
  loadAuthUser: async () => ({ id: "u-1" }),
  orgAtivaSemPortao: async () => ({ orgId: "org-1", role: "agent", org_status: "active" }),
}));

/** A query que o handler recebeu na última chamada. */
async function queryRecebidaCom(qs: string): Promise<Record<string, unknown>> {
  const { GET } = await import("@/app/api/v1/conversations/route");
  await GET(new NextRequest(`http://x/api/v1/conversations${qs}`));
  const chamada = listConversationsHandler.mock.calls.at(-1);
  if (!chamada) throw new Error("o handler não foi chamado — a rota morreu antes");
  return (chamada as unknown[])[2] as Record<string, unknown>;
}

describe("GET /api/v1/conversations — o `tag` da query string chega ao handler", () => {
  beforeEach(() => listConversationsHandler.mockClear());

  // ⚠️ O `tag` virou LISTA pela MESMAVia que o `status` já tinha virado (e pelo
  // mesmo motivo: um filtro de vários valores viaja como repetição na URL). A
  // compatibilidade NÃO está no TIPO que chega ao handler e sim no PREDICADO: o
  // caso de uma etiqueta desvia para `aplicarMarcador`, que produz o `or=` de
  // sempre, byte a byte. O que este arquivo mede é a LEITURA da URL — e a
  // leitura de uma repetição só existe com `getAll`.
  it("com `?tag=vip`, o handler recebe a lista `['vip']`", async () => {
    expect((await queryRecebidaCom("?tag=vip")).tag).toEqual(["vip"]);
  });

  it("com `?tag=vip&tag=orçamento`, as DUAS chegam — a segunda não se perde", async () => {
    // A rotura que um `get` aqui causaria: leria a primeira e a tela mostraria
    // duas etiquetas escolhidas filtrando por uma. Silencioso, e por isso um
    // caso próprio, e não uma consequência do de cima.
    expect((await queryRecebidaCom("?tag=vip&tag=orçamento")).tag).toEqual([
      "vip",
      "orçamento",
    ]);
  });

  it("`?tag=vip&modo=ou` chega com o modo — E/OU não pode ser lido só na tela", async () => {
    const q = await queryRecebidaCom("?tag=vip&tag=orçamento&modo=ou");
    expect([q.tag, q.modo]).toEqual([["vip", "orçamento"], "ou"]);
  });

  /**
   * Guarda de vacuidade nº 1: sem `tag` na URL o campo tem de chegar `undefined`.
   * Se a rota passasse a mandar `tag` sempre (um literal, um default), o caso acima
   * ficaria verde sem provar que a leitura da query string existe.
   */
  it("sem `tag` na URL, o handler recebe `tag: undefined`", async () => {
    // `getAll` devolve `[]` numa URL sem `tag`, e o schema transforma lista vazia
    // em `undefined` — "sem filtro". Sem essa transformação, o handler receberia
    // `[]`, que é um filtro que não casa nada: lista vazia com filtro desligado.
    expect((await queryRecebidaCom("")).tag).toBeUndefined();
  });

  /**
   * Guarda de vacuidade nº 2: o instrumento está vivo? Um param que a rota SEMPRE
   * leu tem de chegar. Se este caso reprovasse junto com o de cima, o defeito
   * estaria no dublê e não na rota — é o controle positivo do arquivo.
   */
  it("controle positivo: `?status=open` continua chegando", async () => {
    // Chega como LISTA de um desde que o filtro passou a aceitar vários
    // (`?status=open,pending`, que é o que a aba Fila pede). A mudança é aditiva:
    // a forma antiga continua válida e o SQL que ela produz é equivalente.
    expect((await queryRecebidaCom("?status=open")).status).toEqual(["open"]);
  });

  it("a forma PLURAL chega inteira — `?status=open,pending`", async () => {
    // A razão de o filtro ter deixado de ser um valor só: a conversa que o
    // automático escalou é `pending`, e sem os dois estados numa consulta a aba
    // Fila teria de filtrar em memória o que a página já truncou.
    expect((await queryRecebidaCom("?status=open,pending")).status).toEqual([
      "open",
      "pending",
    ]);
  });

  it("os dois juntos convivem — `?status=open&tag=vip`", async () => {
    const q = await queryRecebidaCom("?status=open&tag=vip");
    expect([q.status, q.tag]).toEqual([["open"], ["vip"]]);
  });
});
