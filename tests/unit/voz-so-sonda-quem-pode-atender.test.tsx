/**
 * A sessão de chamada de voz mora no shell autenticado INTEIRO
 * (`app/app/layout.tsx` envolve tudo em `<VoiceCallProvider>`), então o que ela
 * faz no boot ela faz em toda tela, para todo mundo.
 *
 * O defeito medido: `GET /api/v1/voice/calls/history` pede `agent`, e um
 * acompanhamento administrativo somente-leitura é rebaixado a `viewer` por
 * `resolveActiveOrg`. Resultado — dois 403 por navegação em
 * `tests/e2e/suporte-temporario.spec.ts:190`, engolidos por um `.catch` vazio:
 * invisíveis na tela, fatais no gate.
 *
 * O que este arquivo guarda é COMPORTAMENTO, não a presença do `usePermission`:
 * ele monta o hook dentro do `AuthProvider` de verdade, com o papel de verdade,
 * e mede se a sondagem e a assinatura de realtime ACONTECERAM.
 */
import { renderHook, waitFor } from "@testing-library/react";
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
  useRealtimeChannel: (opcoes: { enabled?: boolean }) => {
    espiao.realtime(opcoes);
    return { status: "SUBSCRIBED" };
  },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
// O AuthProvider real renderiza `<Providers>` (react-query, tema…) e instancia o
// client do browser. Nada disso participa da decisão que está sob teste.
vi.mock("@/app/providers", () => ({
  Providers: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/lib/supabase/browser", () => ({
  createClient: () => ({ auth: { refreshSession: vi.fn() } }),
  resetRealtimeAuthentication: vi.fn(),
}));

import { AuthProvider } from "@/hooks/auth/AuthProvider";
import type { AuthUser, ActiveOrg, Role } from "@/lib/auth/types";
import { useVoiceCallSession } from "@/hooks/voice/useVoiceCallSession";

const ORG = "11111111-1111-4111-8111-111111111111";

function usuario(support?: AuthUser["support"]): AuthUser {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    email: "quem@exemplo.com",
    full_name: "Quem Testa",
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR",
    organizations: [],
    ...(support ? { support } : {}),
  } as AuthUser;
}

function org(role: Role): ActiveOrg {
  return { orgId: ORG, name: "Org de teste", role };
}

function montar(user: AuthUser, activeOrg: ActiveOrg) {
  const ref = { current: null };
  return renderHook(() => useVoiceCallSession(ref), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <AuthProvider user={user} activeOrg={activeOrg}>
        {children}
      </AuthProvider>
    ),
  });
}

/** Só as assinaturas LIGADAS contam: o hook sempre chama o hook de realtime. */
function assinaturasLigadas(): number {
  return espiao.realtime.mock.calls.filter((c) => (c[0] as { enabled?: boolean })?.enabled).length;
}

beforeEach(() => {
  vi.clearAllMocks();
  espiao.get.mockResolvedValue({ data: [] });
});

describe("a sessão de chamada de voz só existe para quem pode atender", () => {
  it("atendente sonda o histórico e assina a tabela", async () => {
    const { unmount } = montar(usuario(), org("agent"));
    await waitFor(() => expect(espiao.get).toHaveBeenCalledTimes(1));
    expect(espiao.get.mock.calls[0]?.[0]).toContain("/api/v1/voice/calls/history");
    expect(assinaturasLigadas()).toBeGreaterThan(0);
    unmount();
  });

  it("somente-leitura da organização não sonda nem assina", async () => {
    const { unmount } = montar(usuario(), org("viewer"));
    // Espera ativa: o efeito de boot roda no primeiro commit; se ele fosse
    // disparar, já teria disparado quando a assinatura foi avaliada.
    await waitFor(() => expect(espiao.realtime).toHaveBeenCalled());
    expect(espiao.get).not.toHaveBeenCalled();
    expect(assinaturasLigadas()).toBe(0);
    unmount();
  });

  it("acompanhamento administrativo somente-leitura não sonda nem assina", async () => {
    // É exatamente a sessão do e2e de suporte: o ator é rebaixado a `viewer` em
    // `resolveActiveOrg`, mesmo sendo admin FÍSICO da organização observada.
    const suporte = {
      id: "33333333-3333-4333-8333-333333333333",
      organization_id: ORG,
      actor_user_id: "22222222-2222-4222-8222-222222222222",
      auth_session_id: "44444444-4444-4444-8444-444444444444",
      previous_organization_id: null,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      name: "Org observada",
      locale: null,
      access_mode: "support_readonly",
      status: "active",
    } as NonNullable<AuthUser["support"]>;
    const { unmount } = montar(usuario(suporte), org("viewer"));
    await waitFor(() => expect(espiao.realtime).toHaveBeenCalled());
    expect(espiao.get).not.toHaveBeenCalled();
    expect(assinaturasLigadas()).toBe(0);
    unmount();
  });

  it("administrador de plataforma DENTRO de um acompanhamento não escapa pelo bypass", async () => {
    // `usePermission` devolve `true` de saída para platform admin — mas só
    // `!user.support`. Se essa condição sumisse, o super-admin voltaria a sondar
    // dentro de um acompanhamento somente-leitura, que é o caso do e2e.
    const base = usuario({
      id: "33333333-3333-4333-8333-333333333333",
      organization_id: ORG,
      actor_user_id: "22222222-2222-4222-8222-222222222222",
      auth_session_id: "44444444-4444-4444-8444-444444444444",
      previous_organization_id: null,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      name: "Org observada",
      locale: null,
      access_mode: "support_readonly",
      status: "active",
    } as NonNullable<AuthUser["support"]>);
    const { unmount } = montar({ ...base, is_platform_admin: true }, org("viewer"));
    await waitFor(() => expect(espiao.realtime).toHaveBeenCalled());
    expect(espiao.get).not.toHaveBeenCalled();
    unmount();
  });

  it("quem não pode ligar também não consegue iniciar uma chamada", async () => {
    const { result, unmount } = montar(usuario(), org("viewer"));
    await waitFor(() => expect(espiao.realtime).toHaveBeenCalled());
    await result.current.startCall("55555555-5555-4555-8555-555555555555");
    expect(espiao.post).not.toHaveBeenCalled();
    unmount();
  });
});
