/**
 * QUEM ESCOLHEU "ESQUECI A SENHA" NUMA INSTALAÇÃO SEM SMTP VÊ O MOTIVO — E NÃO
 * "TENTE NOVAMENTE".
 *
 * ─── O defeito (#2755) ─────────────────────────────────────────────────────
 *
 * A action já distinguia o caso, mas a TELA não: todo erro virava "Não foi
 * possível enviar o e-mail. Tente novamente." Numa instalação sem SMTP isso é
 * instrução impossível — o e-mail não sai nunca, e a pessoa repete o gesto sem
 * ter como perceber que o problema é da instalação, não dela. O único lugar
 * que sabia o motivo era o log do update.sh, do lado oposto do produto.
 *
 * ─── Por que testar a tela e não só a action ───────────────────────────────
 *
 * Par do `tests/unit/esqueci-a-senha-sem-smtp-diz-o-motivo.test.ts`, pelo mesmo
 * motivo do par de `cadastro-sem-confirmacao-nao-manda-esperar-email`: a action
 * podia devolver `smtp_not_configured` certinho e o formulário continuar com o
 * `else` genérico — verde nos dois lados, pessoa travada do jeito antigo. Só o
 * caso da tela prende o ramo.
 *
 * O caso de CONTROLE é o outro lado da pinça: com `request_failed` (SMTP
 * presente, caiu por outro motivo), a tela continua dizendo o de sempre. Sem
 * ele, apagar o `else` genérico e mandar tudo para a frase nova passaria aqui.
 *
 * Confira com: pnpm vitest run tests/unit/esqueci-a-senha-aviso-na-tela.test.tsx
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const requestPasswordReset = vi.fn();
vi.mock("@/app/actions/auth/requestPasswordReset", () => ({
  requestPasswordReset: (...args: unknown[]) => requestPasswordReset(...args),
}));

import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";

const AVISO_NOVO = /A recuperação de senha não está disponível nesta instalação/i;
const GENERICO = /Não foi possível enviar o e-mail\. Tente novamente\./i;

async function enviar(email = "dono@revenda.test") {
  const user = userEvent.setup();
  render(<ForgotPasswordForm />);
  await user.type(screen.getByLabelText(/^Email$/i), email);
  await user.click(screen.getByRole("button", { name: /enviar link de redefinição/i }));
}

beforeEach(() => {
  requestPasswordReset.mockReset();
  cleanup();
});

describe("a tela de esqueci a senha", () => {
  it("⭐ sem SMTP: o aviso diz que a instalação não envia e-mail, e não manda tentar de novo", async () => {
    requestPasswordReset.mockResolvedValue({ ok: false, error: "smtp_not_configured" });

    await enviar();

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toMatch(AVISO_NOVO);
    expect(alerta.textContent, "mandar repetir um gesto que nunca funciona").not.toMatch(
      /Tente novamente/i,
    );
  });

  it("⭐ CONTROLE — request_failed (tem SMTP): o genérico continua como estava", async () => {
    requestPasswordReset.mockResolvedValue({ ok: false, error: "request_failed" });

    await enviar();

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toMatch(GENERICO);
    expect(alerta.textContent).not.toMatch(AVISO_NOVO);
  });

  it("CONTROLE — rate_limited: a catraca continua dizendo a catraca", async () => {
    requestPasswordReset.mockResolvedValue({ ok: false, error: "rate_limited" });

    await enviar();

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toMatch(/Muitas tentativas/i);
    expect(alerta.textContent).not.toMatch(AVISO_NOVO);
  });

  it("CONTROLE — sucesso: o painel de 'verifique seu e-mail' não muda", async () => {
    requestPasswordReset.mockResolvedValue({ ok: true });

    await enviar();

    await waitFor(() => expect(screen.getByText(/Verifique seu e-mail/i)).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
