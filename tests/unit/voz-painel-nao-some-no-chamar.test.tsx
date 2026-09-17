/**
 * O PAINEL DE QUEM DISCOU NÃO SOME QUANDO A RESPOSTA DO "CHAMAR" CHEGA.
 *
 * `voz-painel-nao-some-com-a-resposta.test.ts` prende a função pura; este
 * arquivo prende o CALL SITE, montando o hook de verdade. Sem ele, voltar
 * `startCall` a `setCall(res.data)` passava em toda a suíte.
 *
 * A ordem medida em produção: a ponte grava a ligação, o Realtime a entrega com
 * `owner_user_id`, e só então a rota responde. Substituir a linha pela resposta
 * fazia `minha` depender do que a resposta trouxe — e o painel, com o botão de
 * desligar, some quando ela não traz o dono.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const espiao = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  del: vi.fn(),
  realtime: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: espiao.get, post: espiao.post, delete: espiao.del },
}));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: (opcoes: { enabled?: boolean; onChange?: (p: unknown) => void }) => {
    espiao.realtime(opcoes);
    return { status: "SUBSCRIBED" };
  },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/app/providers", () => ({
  Providers: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/lib/supabase/browser", () => ({
  createClient: () => ({ auth: { refreshSession: vi.fn() } }),
  resetRealtimeAuthentication: vi.fn(),
}));

import { AuthProvider } from "@/hooks/auth/AuthProvider";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";
import { useVoiceCallSession } from "@/hooks/voice/useVoiceCallSession";

const ORG = "11111111-1111-4111-8111-111111111111";
const EU = "22222222-2222-4222-8222-222222222222";
const CONTATO = "55555555-5555-4555-8555-555555555555";

function montar() {
  const user = {
    id: EU,
    email: "quem@exemplo.com",
    full_name: "Quem Liga",
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR",
    organizations: [],
  } as AuthUser;
  const activeOrg: ActiveOrg = { orgId: ORG, name: "Org de teste", role: "agent" };
  const ref = { current: null };
  return renderHook(() => useVoiceCallSession(ref), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <AuthProvider user={user} activeOrg={activeOrg}>
        {children}
      </AuthProvider>
    ),
  });
}

/** O `onChange` da assinatura ligada mais recente — é o que o Realtime chama. */
function entregarPeloRealtime(linha: Record<string, unknown>) {
  const ligadas = espiao.realtime.mock.calls
    .map((c) => c[0] as { enabled?: boolean; onChange?: (p: unknown) => void })
    .filter((o) => o.enabled && o.onChange);
  ligadas.at(-1)!.onChange!({ new: linha });
}

beforeEach(() => {
  vi.clearAllMocks();
  espiao.get.mockResolvedValue({ data: [] });
});

describe("Chamar: a resposta chega depois da linha do Realtime", () => {
  it("a resposta sem dono não tira o painel de quem discou", async () => {
    let responder!: (v: unknown) => void;
    espiao.post.mockImplementationOnce(() => new Promise((r) => (responder = r)));
    const { result, unmount } = montar();
    await waitFor(() => expect(espiao.get).toHaveBeenCalled());

    let chamando!: Promise<void>;
    act(() => {
      chamando = result.current.startCall(CONTATO);
    });

    act(() =>
      entregarPeloRealtime({
        id: "c1",
        contact_id: CONTATO,
        direction: "outbound",
        peer_phone: "553198966398",
        status: "ringing",
        end_reason: null,
        started_at: "2026-09-15T13:42:24.000Z",
        answered_at: null,
        owner_user_id: EU,
        created_by: null,
      }),
    );
    expect(result.current.minha).toBe(true);

    await act(async () => {
      responder({ data: { id: "c1", status: "starting", callId: "up-1" } });
      await chamando;
    });

    expect(result.current.minha, "o painel de quem discou sumiu com a resposta").toBe(true);
    expect(result.current.call?.owner_user_id).toBe(EU);
    expect(result.current.call?.status).toBe("ringing");
    unmount();
  });
});
