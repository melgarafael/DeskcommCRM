/**
 * SAIR ENCERRA O PUSH DO APARELHO ANTES DA ACTION DE SAÍDA.
 *
 * A rota DELETE da inscrição precisa do cookie de sessão, e é a action de saída
 * que o apaga — depois dela a rota responderia 401. Por isso a ordem importa,
 * e por isso a saída não pode depender do resultado do encerramento.
 */
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ordem: string[] = [];
const mocks = vi.hoisted(() => ({
  encerrar: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/app/providers", () => ({ Providers: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/lib/supabase/browser", () => ({
  createClient: () => ({ auth: { refreshSession: vi.fn() } }),
  resetRealtimeAuthentication: vi.fn(),
}));
vi.mock("@/lib/notifications/push_client", () => ({ encerrarPushDesteAparelho: mocks.encerrar }));
vi.mock("@/app/actions/auth/signOut", () => ({ signOut: mocks.signOut }));

import { AuthProvider, useAuth } from "./AuthProvider";

let sair: () => Promise<void> = async () => {};

function montar() {
  const { result } = renderHook(() => useAuth(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <AuthProvider user={{ id: "u1", idioma: "pt-BR", support: null } as never} activeOrg={null}>
        {children}
      </AuthProvider>
    ),
  });
  sair = () => result.current.signOut();
}

beforeEach(() => {
  ordem.length = 0;
  vi.clearAllMocks();
  mocks.encerrar.mockImplementation(async () => {
    ordem.push("encerrar");
  });
  mocks.signOut.mockImplementation(async () => {
    ordem.push("signOut");
  });
});

describe("AuthProvider.signOut", () => {
  it("encerra o push do aparelho antes de chamar a action de saída", async () => {
    montar();
    await act(async () => {
      await sair();
    });
    expect(ordem).toEqual(["encerrar", "signOut"]);
  });

  it("a action só é chamada depois que o encerramento termina", async () => {
    let terminar: () => void = () => {};
    mocks.encerrar.mockImplementation(
      () =>
        new Promise<void>((r) => {
          terminar = () => {
            ordem.push("encerrar");
            r();
          };
        }),
    );
    montar();
    let saida: Promise<void> = Promise.resolve();
    await act(async () => {
      saida = sair();
      await Promise.resolve();
    });
    expect(mocks.signOut).not.toHaveBeenCalled();
    await act(async () => {
      terminar();
      await saida;
    });
    expect(ordem).toEqual(["encerrar", "signOut"]);
  });

  it("encerramento que não conseguiu nada (devolve sem lançar) não impede a saída", async () => {
    mocks.encerrar.mockResolvedValue(undefined);
    montar();
    await act(async () => {
      await sair();
    });
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
  });
});
