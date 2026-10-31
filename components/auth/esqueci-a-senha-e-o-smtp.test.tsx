/**
 * A TELA DE "ESQUECI A SENHA" NÃO RECUSA UMA RECUPERAÇÃO QUE FUNCIONARIA.
 *
 * ─── A medição (#3039), feita ANTES do conserto ─────────────────────────────
 *
 * Instalação de servidor único (`SINGLE_SERVER=1`) com o SMTP posto direto no
 * `.env` do Supabase — `.runtime/supabase/.env`, o arquivo que o GoTrue lê
 * (`hostgator-setup-kit/_common.sh:411` diz onde ele mora) — e NADA em
 * `/admin/email`:
 *
 *   - a régua da instalação diz "sem SMTP": `lib/email/estado.ts:40`
 *     (`semSmtpNaInstalacao`), porque o app não enxerga aquele arquivo. É o
 *     limite que o cabeçalho dela mesma declara (`lib/email/estado.ts:35`);
 *   - o GoTrue desta instalação, esse sim, TEM por onde enviar: o e-mail sai.
 *
 * Antes do conserto, a decisão (`app/actions/auth/requestPasswordReset.ts:54`)
 * devolvia `smtp_not_configured` ANTES de perguntar ao GoTrue, e a tela exibia
 * `components/auth/ForgotPasswordForm.tsx:47` ("sem SMTP configurado não sai
 * e-mail nenhum", chave em `lib/i18n/dicionario.ts:10034`) — afirmação falsa
 * neste caso, e recuperação bloqueada.
 *
 * VEREDITO MEDIDO: RECUSA. Por isso o conserto é no ponto da decisão, e a
 * frase acompanha: `smtp_not_configured` passa a ser a resposta do GoTrue
 * quando ELE diz que não conseguiu enviar (`/error sending/i`, mesma medida de
 * `app/actions/auth/signUp.ts:296`), nunca uma recusa antecipada.
 *
 * ─── O que este arquivo prende ──────────────────────────────────────────────
 *
 *   1. a régua da instalação continua dizendo "sem SMTP" no caso-limite (o
 *      limite declarado não se moveu) E a recuperação NÃO é recusada — quem
 *      decide é a resposta do GoTrue;
 *   2. sem SMTP nenhum, a tela continua avisando com honestidade e apontando
 *      `/admin/email` — o que o #2755 entregou não se perdeu;
 *   3. no caso-limite a tela não afirma que não sai e-mail: nenhum aviso
 *      aparece, e o dicionário não guarda mais a frase absoluta, em idioma
 *      nenhum;
 *   4. a frase nova tem espanhol (o gate `tests/unit/i18n-espanhol-cobre-a-tela.test.ts`
 *      cobra toda chave usada em `t()`).
 *
 * O formulário chama a ACTION DE VERDADE: os dublês estão nas dependências
 * dela (o banco que o `lerSmtp` lê, o cliente do GoTrue, o env), nunca na
 * função que decide — o caminho medido é o da tela até a decisão.
 *
 * Confira com: npx vitest run components/auth/esqueci-a-senha-e-o-smtp.test.tsx
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RespostaGoTrue = { error: { message: string; status?: number } | null };
type LinhaSmtp = {
  smtp_host: string | null;
  smtp_port: number;
  smtp_security: "starttls";
  smtp_username: string | null;
  smtp_password_encrypted: string | null;
  from_email: string | null;
  from_name: string | null;
};
type RespostaBanco =
  | { data: LinhaSmtp | null; error: null }
  | { data: null; error: { message: string } }
  | "lanca";

const estado = {
  banco: { data: null, error: null } as RespostaBanco,
  envSmtpHost: "",
  envSmtpFrom: "",
  resposta: { error: null } as RespostaGoTrue,
  chamouGoTrue: 0,
};

vi.mock("next/headers", () => ({ headers: async () => ({ get: () => null }) }));
vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_APP_URL: "https://crm.revenda.test",
    get SMTP_HOST() {
      return estado.envSmtpHost;
    },
    SMTP_PORT: 587,
    SMTP_SECURITY: "starttls",
    SMTP_USERNAME: "",
    SMTP_PASSWORD: "",
    get SMTP_FROM_EMAIL() {
      return estado.envSmtpFrom;
    },
    SMTP_FROM_NAME: "",
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (estado.banco === "lanca") throw new Error("conexão recusada");
            return estado.banco;
          },
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: async () => "",
  encryptWebhookSecret: async () => "",
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      resetPasswordForEmail: async () => {
        estado.chamouGoTrue += 1;
        return estado.resposta;
      },
    },
  }),
}));
vi.mock("@/lib/audit", () => ({
  audit: async () => {},
  hashEmail: (email: string) => `hash:${email}`,
}));
vi.mock("@/lib/auth/rate-limit", () => ({
  authRateLimited: async () => false,
  AUTH_LIMITS: { reset: { ip: 30, id: 3, windowSec: 3600 } },
}));

import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";
import { semSmtpNaInstalacao } from "@/lib/email/estado";
import { DICIONARIO } from "@/lib/i18n/dicionario";

const EMAIL = "dono@revenda.test";
const FRASE_ANTIGA =
  "A recuperação de senha não está disponível nesta instalação: sem SMTP configurado não sai e-mail nenhum. Contate o administrador para configurar em /admin/email.";
const FRASE_NOVA =
  "A recuperação de senha não está disponível nesta instalação: o serviço de login não conseguiu enviar o e-mail — não há SMTP configurado. Contate o administrador para configurar em /admin/email.";

/** O erro cru do GoTrue sem SMTP: 500 "Error sending recovery email" (medido numa VPS v1.85.0; ver `hostgator-setup-kit/_common.sh:486`). */
const GOtrue_SEM_SMTP = { error: { message: "Error sending recovery email", status: 500 } };

async function enviar(email = EMAIL) {
  const user = userEvent.setup();
  render(<ForgotPasswordForm />);
  await user.type(screen.getByLabelText(/^Email$/i), email);
  await user.click(screen.getByRole("button", { name: /enviar link de redefinição/i }));
}

beforeEach(() => {
  // O CASO-LIMITE da #3039: servidor único, banco respondeu "ninguém
  // configurou pela tela", `.env` do CRM sem SMTP — e o SMTP mora no `.env` do
  // Supabase, onde o app não alcança.
  estado.banco = { data: null, error: null };
  estado.envSmtpHost = "";
  estado.envSmtpFrom = "";
  estado.resposta = { error: null };
  estado.chamouGoTrue = 0;
  vi.stubEnv("SINGLE_SERVER", "1");
  cleanup();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("A MEDIÇÃO (#3039): SMTP só no .env do Supabase", () => {
  it("⭐ a régua da instalação DIZ 'sem SMTP' neste caso — é o limite declarado em lib/email/estado.ts:35", async () => {
    await expect(semSmtpNaInstalacao()).resolves.toBe(true);
  });

  it("⭐ e mesmo assim a recuperação NÃO é recusada: o GoTrue envia pelo SMTP que só ele enxerga", async () => {
    await enviar();

    await waitFor(() => expect(screen.getByText(/Verifique seu e-mail/i)).toBeTruthy());
    expect(estado.chamouGoTrue, "quem decide tem de perguntar ao GoTrue").toBe(1);
    expect(screen.queryByRole("alert"), "nenhuma recusa, nenhum aviso de instalação").toBeNull();
  });

  it("CONTROLE — a régua continua sendo a mesma pergunta no caso em que o CRM TEM SMTP", async () => {
    estado.banco = {
      data: {
        smtp_host: "smtp.revenda.com.br",
        smtp_port: 587,
        smtp_security: "starttls",
        smtp_username: "nao-responda@revenda.com.br",
        smtp_password_encrypted: null,
        from_email: "nao-responda@revenda.com.br",
        from_name: "Revenda",
      },
      error: null,
    };

    await expect(semSmtpNaInstalacao()).resolves.toBe(false);
  });
});

describe("sem SMTP NENHUM: o aviso honesto do #2755 continua", () => {
  it("⭐ o GoTrue recusa, e a tela diz o motivo apontando /admin/email — nunca 'tente novamente'", async () => {
    estado.resposta = GOtrue_SEM_SMTP;

    await enviar();

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toMatch(/A recuperação de senha não está disponível nesta instalação/);
    expect(alerta.textContent, "o caminho do administrador continua na frase").toMatch("/admin/email");
    expect(
      alerta.textContent,
      "mandar repetir um gesto que não vai funcionar é o defeito do #2755",
    ).not.toMatch(/Tente novamente/i);
  });
});

describe("o texto, no caso-limite", () => {
  it("⭐ a tela não afirma que 'não sai e-mail nenhum'", async () => {
    await enviar();

    await waitFor(() => expect(screen.getByText(/Verifique seu e-mail/i)).toBeTruthy());
    expect(
      screen.queryByText(/não sai e-mail nenhum/i),
      "no caso-limite o e-mail SAI, e a tela não pode dizer o contrário",
    ).toBeNull();
  });

  it("a frase absoluta não existe mais no dicionário, em idioma nenhum", () => {
    const tudo = JSON.stringify(DICIONARIO);
    expect(tudo).not.toContain("não sai e-mail nenhum");
    expect(tudo, "a tradução carregava o mesmo absoluto").not.toContain(
      "no sale ningún correo",
    );
  });
});

describe("o idioma que o gate cobra (tests/unit/i18n-espanhol-cobre-a-tela.test.ts)", () => {
  it("a frase nova tem espanhol, e o português é a própria chave", () => {
    expect(DICIONARIO[FRASE_NOVA]?.es, `sem espanhol para: ${FRASE_NOVA}`).toBeTruthy();
    expect(DICIONARIO[FRASE_NOVA]?.es).not.toBe(FRASE_NOVA);
  });

  it("a frase antiga saiu do dicionário", () => {
    expect(DICIONARIO[FRASE_ANTIGA]).toBeUndefined();
  });
});
