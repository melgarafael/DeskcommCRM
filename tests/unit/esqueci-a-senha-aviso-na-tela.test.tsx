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
 * ─── O absoluto que sobrou (#3039) ─────────────────────────────────────────
 *
 * A frase do #2755 dizia "sem SMTP configurado não sai e-mail nenhum", e isso
 * é MAIS do que a instalação sabe. O CRM enxerga o SMTP dele (`lerSmtp()`, na
 * base) — não o `.env` do GoTrue: quem pôs SMTP direto lá tem e-mail saindo
 * com o CRM sem SMTP nenhum (o limite está escrito em `lib/email/estado.ts`).
 * O #2853 tirou o absoluto do painel de atualização e deixou esta tela.
 *
 * A frase nova afirma só o que a régua mede: o CRM está sem SMTP configurado,
 * e NESTA instalação (servidor único, a única em que a action devolve
 * `smtp_not_configured`) o e-mail de recuperação depende dele. O caso de
 * controle do absoluto é a negativa — a tela não pode voltar a dizer "nenhum
 * e-mail".
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

import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

const estado = vi.hoisted(() => ({ idioma: "pt-BR" as string }));

const requestPasswordReset = vi.fn();
vi.mock("@/app/actions/auth/requestPasswordReset", () => ({
  requestPasswordReset: (...args: unknown[]) => requestPasswordReset(...args),
}));

// Tradutor de produção, idioma trocável: o teste em espanhol passa pelo mesmo
// `traduzir` que a tela usa — chave sem espanhol cai no português e reprova.
vi.mock("@/hooks/i18n/useT", () => ({
  useT: () => (texto: string) => traduzir(texto, estado.idioma as Idioma),
}));

import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";

const AVISO_NOVO = /O CRM está sem SMTP configurado/i;
const AVISO_ES = /El CRM está sin SMTP configurado/i;
/** O absoluto do #2755/#3039: a instalação não sabe disto, e a tela não afirma. */
const ABSOLUTO = /não sai e-mail nenhum|nenhum e-mail/i;
const ABSOLUTO_ES = /no sale ningún correo|ningún correo/i;
const GENERICO = /Não foi possível enviar o e-mail\. Tente novamente\./i;

async function enviar(email = "dono@revenda.test") {
  const emEspanhol = estado.idioma === "es";
  const user = userEvent.setup();
  render(<ForgotPasswordForm />);
  await user.type(screen.getByLabelText(emEspanhol ? /^Correo$/i : /^Email$/i), email);
  await user.click(
    screen.getByRole("button", {
      name: emEspanhol ? /enviar enlace de restablecimiento/i : /enviar link de redefinição/i,
    }),
  );
}

beforeEach(() => {
  estado.idioma = "pt-BR";
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

  it("⭐ sem SMTP: o absoluto 'não sai e-mail nenhum' saiu da frase", async () => {
    requestPasswordReset.mockResolvedValue({ ok: false, error: "smtp_not_configured" });

    await enviar();

    const alerta = await screen.findByRole("alert");
    expect(
      alerta.textContent,
      "o CRM lê o SMTP dele, não o .env do GoTrue: 'nenhum e-mail sai' é mais do que a instalação sabe",
    ).not.toMatch(ABSOLUTO);
  });

  it("⭐ sem SMTP, em espanhol: a frase sai em espanhol e sem o absoluto", async () => {
    estado.idioma = "es";
    requestPasswordReset.mockResolvedValue({ ok: false, error: "smtp_not_configured" });

    await enviar();

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toMatch(AVISO_ES);
    expect(alerta.textContent).not.toMatch(ABSOLUTO_ES);
    expect(
      alerta.textContent,
      "chave espanhola em português: quem escolheu espanhol lê a tela em português",
    ).not.toMatch(AVISO_NOVO);
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
