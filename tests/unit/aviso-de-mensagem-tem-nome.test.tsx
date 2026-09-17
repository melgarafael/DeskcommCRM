/**
 * O NOME DE QUEM ESCREVEU — o aviso que sempre dizia "Nova mensagem".
 *
 * O aviso de mensagem nova monta o título a partir do contato. Ele lia esse
 * contato pelo client do Supabase DO BROWSER:
 *
 *     const supabase = createClient();
 *     const { data } = await supabase.from("contacts").select("display_name, name")…
 *
 * O client do browser não carrega a sessão (o cookie é httpOnly — está
 * documentado no próprio `lib/supabase/browser.ts`), então o select saía como
 * `anon` e a RLS de `contacts` respondia com ZERO LINHAS — e zero linhas não é
 * erro: nada lança, nada loga, nada reprova build. O código só olhava `data`,
 * recebia `null`, e o título caía no literal de sempre. O mesmo valia para o
 * `contact_id` buscado de `conversations`, quando o payload do realtime não o
 * trazia: sem ele, nem há nome a procurar.
 *
 * O conserto é a LEITURA passar pela rota (`/api/v1/contacts/[id]` e
 * `/api/v1/conversations/[id]`), que autentica no servidor — o mesmo caminho
 * que o avatar do contato já usava e que nunca teve esse defeito.
 *
 * As propriedades cobradas aqui são de PRODUTO, não de forma:
 *   1. O título do aviso é o nome que a rota autenticada devolveu.
 *   2. O client anônimo do browser não é consultado para contato/conversa
 *      (é ele que produzia o silêncio; um `from` de volta é a regressão).
 *   3. O mesmo vale quando o `contact_id` só existe na conversa.
 *   4. Rota recusando (403) ou sem nome apresentável cai no texto de sempre,
 *      sem exceção solta — degradar é a resposta, não quebrar o aviso.
 *
 * Roda com: npx vitest run tests/unit/aviso-de-mensagem-tem-nome.test.tsx
 */
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { toastFalso, fromDoBrowser, fetchFalso } = vi.hoisted(() => ({
  toastFalso: vi.fn(),
  fromDoBrowser: vi.fn(),
  fetchFalso: vi.fn(),
}));

/** O canal é de fora: aqui só interessa a função que ele entrega o payload. */
const canal = vi.hoisted(() => ({ onChange: null as ((p: unknown) => void) | null }));

vi.mock("sonner", () => ({ toast: toastFalso }));
vi.mock("@/lib/notifications/emit", () => ({ emitNotification: vi.fn() }));
vi.mock("@/lib/notifications/push_client", () => ({ syncPushSubscription: vi.fn() }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useActiveOrg: () => ({ orgId: "org-1" }) }));
vi.mock("@/hooks/notifications/OpenConversationContext", () => ({
  getOpenConversationId: () => null,
}));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: (opts: { onChange: (p: unknown) => void }) => {
    canal.onChange = opts.onChange;
    return { status: "subscribed", ultimaEntrega: { current: null } };
  },
}));
// O dublê do client do browser existe só para GRITAR se alguém voltar a ler
// contato por ele: `fromDoBrowser` sendo chamado é a regressão da issue. Ele
// responde com a forma EXATA do defeito — conjunto vazio, sem erro —, então
// quem voltar a ler por aqui reprova com "Nova mensagem" no lugar do nome.
vi.mock("@/lib/supabase/browser", () => ({
  createClient: () => ({
    from: (tabela: string) => {
      fromDoBrowser(tabela);
      const vazio = { data: null, error: null };
      const consulta = {
        select: () => consulta,
        eq: () => consulta,
        maybeSingle: async () => vazio,
        single: async () => vazio,
        then: (resolver: (v: unknown) => unknown) => Promise.resolve(vazio).then(resolver),
      };
      return consulta;
    },
  }),
  prepareRealtimeAuthentication: vi.fn(),
}));

import { useInboundMessageAlerts } from "@/hooks/notifications/useInboundMessageAlerts";

type RespostaFalsa = {
  ok: boolean;
  status: number;
  url: string;
  json: () => Promise<unknown>;
};

function resposta(ok: boolean, corpo?: unknown, url = "https://app.teste/api"): RespostaFalsa {
  return { ok, status: ok ? 200 : 403, url, json: async () => corpo };
}

/** Payload como o Supabase Realtime entrega: `new` é a linha de `messages`. */
function mensagem(campos: Record<string, unknown> = {}) {
  return {
    new: {
      id: "msg-1",
      direction: "inbound",
      conversation_id: "conv-1",
      contact_id: "ct-1",
      type: "text",
      body: "  oi, tudo bem?  ",
      ...campos,
    },
  };
}

/** Renderiza o hook, entrega o payload do realtime e devolve a chamada do toast. */
async function avisa(payload: unknown) {
  renderHook(() => useInboundMessageAlerts());
  await waitFor(() => expect(canal.onChange).not.toBeNull());
  canal.onChange!(payload);
  await waitFor(() => expect(toastFalso).toHaveBeenCalled());
  return toastFalso.mock.calls.at(-1)! as [
    string,
    { description?: string; action?: { label: string; onClick: () => void } },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  canal.onChange = null;
  vi.stubGlobal("fetch", fetchFalso);
});

describe("aviso de mensagem nova — quem mandou", () => {
  it("mostra o nome que a ROTA autenticada devolveu, e não o literal de sempre", async () => {
    fetchFalso.mockImplementation(async (url: string) => {
      if (url.includes("/avatar")) return resposta(false);
      return resposta(true, { data: { name: null, display_name: "Maria Souza" } });
    });

    const [titulo, opcoes] = await avisa(mensagem());

    expect(titulo).toBe("Maria Souza");
    expect(opcoes.description).toBe("oi, tudo bem?");
    expect(opcoes.action?.label).toBe("Abrir conversa");
    // A leitura do contato foi pela rota, COM a sessão — é isto que a RLS do
    // browser não tinha como enxergar.
    expect(fetchFalso).toHaveBeenCalledWith("/api/v1/contacts/ct-1", { credentials: "include" });
  });

  it("não consulta o client anônimo do browser — foi ele que zerou em silêncio", async () => {
    fetchFalso.mockImplementation(async (url: string) =>
      url.includes("/avatar")
        ? resposta(false)
        : resposta(true, { data: { display_name: "Maria Souza" } }),
    );

    await avisa(mensagem());

    expect(fromDoBrowser).not.toHaveBeenCalled();
  });

  it("busca o contato da CONVERSA pela rota quando o payload não traz contact_id", async () => {
    fetchFalso.mockImplementation(async (url: string) => {
      if (url === "/api/v1/conversations/conv-1") {
        return resposta(true, { data: { contact_id: "ct-2" } });
      }
      if (url === "/api/v1/contacts/ct-2") return resposta(true, { data: { name: "Joana Ribeiro" } });
      return resposta(false);
    });

    const [titulo] = await avisa(mensagem({ contact_id: undefined }));

    expect(titulo).toBe("Joana Ribeiro");
    expect(fetchFalso).toHaveBeenCalledWith("/api/v1/conversations/conv-1", {
      credentials: "include",
    });
    expect(fromDoBrowser).not.toHaveBeenCalled();
  });

  it("com a rota recusando (403), o aviso sai com o texto de sempre — não estoura", async () => {
    fetchFalso.mockImplementation(async () =>
      resposta(false, { error: { code: "forbidden", message: "Sem acesso." } }),
    );

    const [titulo, opcoes] = await avisa(mensagem());

    expect(titulo).toBe("Nova mensagem");
    expect(opcoes.description).toBe("oi, tudo bem?");
  });

  it("contato sem nome apresentável cai no texto de sempre, em vez de inventar nome", async () => {
    fetchFalso.mockImplementation(async (url: string) =>
      url.includes("/avatar")
        ? resposta(false)
        : resposta(true, { data: { name: null, display_name: null } }),
    );

    const [titulo] = await avisa(mensagem());

    expect(titulo).toBe("Nova mensagem");
  });
});
