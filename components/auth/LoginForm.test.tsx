/**
 * ENTRAR NÃO PODE FICAR PRESO NO BOTÃO DE CARREGANDO.
 *
 * Era o mesmo defeito de classe da tela de verificação em duas etapas:
 * `startTransition(async () => { await signInWithPassword() })` sem `catch` e
 * sem limite. Como a transição só sai de `isPending` quando a promessa assenta,
 * uma ação que demora ou lança deixava o botão em "Entrando…" para sempre — sem
 * mensagem, sem segunda tentativa, e com a pessoa do lado de fora do sistema.
 *
 * O caso de baixo prova que a tela SAI do estado preso. O par dele vive em
 * `MfaForm.test.tsx`, que cobre a mesma guarda na outra ponta do login.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LoginForm } from "./LoginForm";
import { TETO_DA_ESPERA_MS } from "./teto-da-espera";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (value: string) => value }));
vi.mock("@/app/actions/auth/signInWithPassword", () => ({ signInWithPassword: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));

const { signInWithPassword } = await import("@/app/actions/auth/signInWithPassword");

function preencherEEnviar() {
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "pessoa@exemplo.com" },
  });
  fireEvent.change(screen.getByLabelText("Senha"), { target: { value: "SenhaQueServe#1" } });
  fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
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

    expect(screen.getByText("Não consegui concluir agora. Tente novamente.")).toBeInTheDocument();
    // E o botão voltou: sem isso não há segunda tentativa.
    expect(screen.getByRole("button", { name: "Entrar" })).toBeEnabled();
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
  });
});
