/**
 * A TELA DO CADASTRO NÃO PODE MANDAR ESPERAR UM E-MAIL QUE NÃO VAI CHEGAR.
 *
 * Par do `app/actions/auth/signUp.test.ts`: lá se guarda que a action DIZ que a
 * sessão veio aberta; aqui, que a tela AGE sobre isso. Separados de propósito —
 * a action podia devolver `sessao_ativa` certinho e o formulário continuar
 * mostrando "confirme seu e-mail", que era exatamente o defeito medido, e um
 * teste só do lado da action ficaria verde com a pessoa presa do mesmo jeito.
 *
 * Medido na `origin/main` @ `4d50f63f` com `GOTRUE_MAILER_AUTOCONFIRM=true`: a
 * tela dizia "Enviamos um link de confirmação para …" enquanto o cookie de
 * sessão já estava no browser e o usuário não tinha organização nenhuma.
 * Achado de @KIRAzinx566, com um cliente real travado nessa tela.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SignupForm } from "@/components/auth/SignupForm";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}));

const signUp = vi.fn();
vi.mock("@/app/actions/auth/signUp", () => ({ signUp: (...a: unknown[]) => signUp(...a) }));

async function preencherEEnviar(comEmpresa = true) {
  const user = userEvent.setup();
  if (comEmpresa) await user.type(screen.getByLabelText(/Nome da empresa/i), "Plata Iphones");
  await user.type(screen.getByLabelText(/^Email$/i), "dono@plata.test");
  await user.type(screen.getByLabelText(/^Senha$/i), "SenhaForte!2026");
  await user.type(screen.getByLabelText(/Confirmar senha/i), "SenhaForte!2026");
  await user.click(screen.getByRole("button", { name: /criar conta/i }));
}

describe("cadastro quando o provedor já abriu a sessão", () => {
  beforeEach(() => {
    replace.mockClear();
    signUp.mockReset();
  });

  it("⭐ sessão já aberta: leva à saída em vez de mandar abrir o e-mail", async () => {
    signUp.mockResolvedValue({ ok: true, sessao_ativa: true });
    render(<SignupForm />);
    await preencherEEnviar();

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/get-started"));
    // A instrução impossível não pode sobrar na tela junto do desvio.
    expect(screen.queryByText(/Enviamos um link de confirmação/i)).toBeNull();
  });

  it("⭐ sessão já aberta COM convite: vai aceitar o convite, não abrir empresa", async () => {
    // Dar organização própria a quem foi convidado é o erro que
    // `decidirConviteDoSignup` existe para evitar. Um desvio que mandasse todo
    // mundo para `/get-started` ficaria verde no caso acima e recriaria esse
    // erro aqui.
    signUp.mockResolvedValue({ ok: true, sessao_ativa: true });
    render(<SignupForm convite={{ token: "tok-123", email: "convidado@plata.test" }} />);
    await preencherEEnviar(false);

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/team/accept-invite/tok-123"),
    );
  });

  it("CONTROLE — confirmação LIGADA: a tela do e-mail continua aparecendo", async () => {
    // Sem este caso, "sempre redireciona" ficaria verde e tiraria da tela a
    // única instrução correta para quem de fato precisa confirmar o e-mail.
    signUp.mockResolvedValue({ ok: true, sessao_ativa: false });
    render(<SignupForm />);
    await preencherEEnviar();

    await waitFor(() =>
      expect(screen.getByText(/Enviamos um link de confirmação/i)).toBeTruthy(),
    );
    expect(replace).not.toHaveBeenCalled();
  });
});
