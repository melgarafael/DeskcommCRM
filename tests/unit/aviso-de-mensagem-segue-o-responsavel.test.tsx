/**
 * O AVISO DENTRO DO APP SEGUE A REGRA DE QUEM RECEBE.
 *
 * Conversa com responsável avisa só o responsável e os administradores; sem
 * responsável, todos (regra em `lib/notifications/destinatarios-da-mensagem.ts`,
 * a mesma do push do servidor). O hook não decide sozinho — pergunta a
 * `/api/v1/conversations/[id]/aviso-de-mensagem` (o porquê está no cabeçalho
 * da rota) e só se cala com `avisar === false`. Falha da rota avisa, como antes.
 *
 * Roda com: npx vitest run tests/unit/aviso-de-mensagem-segue-o-responsavel.test.tsx
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

const ROTA_DO_VEREDITO = "/api/v1/conversations/conv-1/aviso-de-mensagem";

function resposta(ok: boolean, corpo?: unknown) {
  return { ok, status: ok ? 200 : 500, url: "https://app.teste/api", json: async () => corpo };
}

function mensagem() {
  return {
    new: { id: "msg-1", direction: "inbound", conversation_id: "conv-1", contact_id: "ct-1", type: "text", body: "oi" },
  };
}

/** Rotas de contato respondem com nome; a do veredito, com o que o teste mandar. */
function servidor(veredito: () => ReturnType<typeof resposta>) {
  fetchFalso.mockImplementation(async (url: string) => {
    if (url === ROTA_DO_VEREDITO) return veredito();
    if (url.includes("/avatar")) return resposta(false);
    return resposta(true, { data: { display_name: "Maria Souza" } });
  });
}

async function entrega() {
  renderHook(() => useInboundMessageAlerts());
  await waitFor(() => expect(canal.onChange).not.toBeNull());
  canal.onChange!(mensagem());
  await waitFor(() =>
    expect(fetchFalso).toHaveBeenCalledWith(ROTA_DO_VEREDITO, { credentials: "include" }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  canal.onChange = null;
  vi.stubGlobal("fetch", fetchFalso);
});

describe("aviso de mensagem nova — quem recebe", () => {
  it("avisar=true (responsável, admin ou conversa sem dono) → mostra o aviso", async () => {
    servidor(() => resposta(true, { data: { avisar: true } }));
    await entrega();
    await waitFor(() => expect(toastFalso).toHaveBeenCalled());
    expect(toastFalso.mock.calls.at(-1)![0]).toBe("Maria Souza");
  });

  it("avisar=false (conversa de outra pessoa) → nenhum aviso, nem busca o contato", async () => {
    servidor(() => resposta(true, { data: { avisar: false } }));
    await entrega();
    // Dá tempo ao restante da cadeia assíncrona: se fosse avisar, o toast já teria saído.
    await new Promise((r) => setTimeout(r, 20));
    expect(toastFalso).not.toHaveBeenCalled();
    expect(fetchFalso).not.toHaveBeenCalledWith("/api/v1/contacts/ct-1", { credentials: "include" });
  });

  it("rota do veredito falhando → avisa, como antes da regra", async () => {
    servidor(() => resposta(false, { error: { code: "internal_error" } }));
    await entrega();
    await waitFor(() => expect(toastFalso).toHaveBeenCalled());
  });
});
