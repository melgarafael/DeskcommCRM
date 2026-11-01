/**
 * ENTRAR NÃO PODE FICAR PRESO NO BOTÃO DE CARREGANDO.
 *
 * Era o mesmo defeito de classe da tela de verificação em duas etapas:
 * `startTransition(async () => { await signInWithPassword() })` sem `catch` e
 * sem limite. Uma ação que demora ou lança deixava o botão em "Entrando…" para
 * sempre — sem mensagem, sem segunda tentativa, e com a pessoa do lado de fora
 * do sistema.
 *
 * O par deste arquivo vive em `MfaForm.test.tsx`, que cobre a mesma guarda na
 * outra ponta do login.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { startTransition, use, useEffect, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LoginForm } from "./LoginForm";
import { TETO_DA_ESPERA_MS } from "./teto-da-espera";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (value: string) => value }));
vi.mock("@/app/actions/auth/signInWithPassword", () => ({ signInWithPassword: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));

const { signInWithPassword } = await import("@/app/actions/auth/signInWithPassword");

const AVISO = "Não recebemos a resposta do servidor. Recarregue a página para tentar de novo.";

function preencherEEnviar() {
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "pessoa@exemplo.com" },
  });
  fireEvent.change(screen.getByLabelText("Senha"), { target: { value: "SenhaQueServe#1" } });
  fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
}

/**
 * O ROTEADOR IMITADO. O Next chama toda Server Action dentro de uma transição
 * do próprio roteador (`callServer` → `startTransition(dispatch)`), e o estado
 * do roteador vira uma promessa lida com `use()` — que fica suspensa enquanto
 * a resposta não chega. É isto que um teste com a ação pendurada SOZINHA não
 * reproduz: o `isPending` de um `useTransition` do formulário fica preso junto
 * com a transição do roteador, mesmo depois de o teto rejeitar. Sem este
 * imitador, voltar ao `useTransition` passava verde.
 */
let pendurarORoteador: () => void = () => {};

function Pendurado({ promessa }: { promessa: Promise<void> }) {
  use(promessa);
  return null;
}

function RoteadorImitado({ children }: { children: ReactNode }) {
  const [promessa, setPromessa] = useState<Promise<void> | null>(null);
  useEffect(() => {
    pendurarORoteador = () => startTransition(() => setPromessa(new Promise<void>(() => {})));
  }, []);
  return (
    <>
      {promessa && <Pendurado promessa={promessa} />}
      {children}
    </>
  );
}

describe("LoginForm — a espera tem teto", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(signInWithPassword).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("explica, em vez de ficar preso, quando a ação não responde", async () => {
    // A ação que NUNCA assenta — o estado que deixava o botão travado.
    vi.mocked(signInWithPassword).mockImplementation(() => new Promise(() => {}));

    render(<LoginForm />);
    await act(async () => {
      preencherEEnviar();
      await vi.advanceTimersByTimeAsync(TETO_DA_ESPERA_MS + 500);
    });

    expect(screen.getByText(AVISO)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Recarregar a página" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Entrar" })).toBeEnabled();
  });

  it("o botão volta mesmo com a transição do roteador suspensa, como no Next", async () => {
    vi.mocked(signInWithPassword).mockImplementation(() => {
      pendurarORoteador();
      return new Promise(() => {});
    });

    render(
      <RoteadorImitado>
        <LoginForm />
      </RoteadorImitado>,
    );
    await act(async () => {
      preencherEEnviar();
      await vi.advanceTimersByTimeAsync(TETO_DA_ESPERA_MS + 500);
    });

    expect(screen.getByText(AVISO)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Entrar" })).toBeEnabled();
  });

  it("o redirecionamento do servidor não vira aviso: a tela segue entrando", async () => {
    // O roteador do Next 16 rejeita a chamada com o sinal e navega sozinho.
    vi.mocked(signInWithPassword).mockRejectedValue(
      Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/app;307;" }),
    );

    render(<LoginForm />);
    await act(async () => {
      preencherEEnviar();
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(screen.queryByText(AVISO)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Entrando..." })).toBeDisabled();
  });

  it("senha errada continua dizendo que é senha errada, e não o texto do teto", async () => {
    // Controle de que o teto não sequestrou o caminho normal de recusa.
    vi.mocked(signInWithPassword).mockResolvedValue({
      ok: false,
      error: "invalid_credentials",
    });

    render(<LoginForm />);
    await act(async () => {
      preencherEEnviar();
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(screen.getByText("Email ou senha incorretos.")).toBeInTheDocument();
    expect(screen.queryByText(AVISO)).not.toBeInTheDocument();
  });
});
