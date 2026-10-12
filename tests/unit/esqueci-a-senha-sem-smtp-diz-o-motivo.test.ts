/**
 * SEM SMTP, O "ESQUECI A SENHA" DIZ O MOTIVO — E COM SMTP, O GENÉRICO FICA.
 *
 * ─── O defeito (#2755) ─────────────────────────────────────────────────────
 *
 * Numa instalação single-server sem SMTP no CRM, o GoTrue não tem por onde
 * mandar e-mail (é o kit, `sincronizar_smtp_do_gotrue`, que leva o SMTP do CRM
 * até ele). A action devolvia `request_failed`, o mesmo código de QUALQUER
 * falha de infra, e a tela dizia "Tente novamente" — um gesto que nunca
 * funcionaria.
 *
 * ─── O que se guarda ───────────────────────────────────────────────────────
 *
 *   - single-server sem SMTP responde `smtp_not_configured` SEM chamar o
 *     GoTrue, e a resposta é a mesma qualquer que seja a resposta dele (200 ou
 *     500): depende da instalação, nunca do e-mail digitado;
 *   - host sem remetente não é SMTP usável (mesma régua do kit);
 *   - a catraca continua vencendo;
 *   - o banco que FALHA não vira "sem SMTP": segue o caminho de sempre;
 *   - fora do single-server (Supabase na nuvem ou separado) nada muda: o login
 *     tem e-mail próprio e "configure em /admin/email" não resolveria;
 *   - CONTROLE: com SMTP, o genérico de antes fica.
 *
 * O `lerSmtp` roda DE VERDADE: o dublê está no cliente do banco, na forma que
 * ele responde (`{ data, error }`, ou lançando), não na função que decide.
 *
 * Confira com: pnpm vitest run tests/unit/esqueci-a-senha-sem-smtp-diz-o-motivo.test.ts
 */
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

const LINHA_COM_SMTP: LinhaSmtp = {
  smtp_host: "smtp.revenda.com.br",
  smtp_port: 587,
  smtp_security: "starttls",
  smtp_username: "nao-responda@revenda.com.br",
  smtp_password_encrypted: null,
  from_email: "nao-responda@revenda.com.br",
  from_name: "Revenda",
};

const estado = {
  banco: { data: null, error: null } as RespostaBanco,
  envSmtpHost: "",
  envSmtpFrom: "",
  limitado: false,
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
  authRateLimited: async () => estado.limitado,
  AUTH_LIMITS: { reset: { ip: 30, id: 3, windowSec: 3600 } },
}));

const { requestPasswordReset } = await import("@/app/actions/auth/requestPasswordReset");

const EMAIL = "dono@revenda.test";
const falhaDoGoTrue = (status?: number) => ({
  error: { message: "Error sending recovery email", status },
});

beforeEach(() => {
  estado.banco = { data: null, error: null };
  estado.envSmtpHost = "";
  estado.envSmtpFrom = "";
  estado.limitado = false;
  estado.resposta = { error: null };
  estado.chamouGoTrue = 0;
  vi.stubEnv("SINGLE_SERVER", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("single-server SEM SMTP no CRM", () => {
  it.each([
    ["200 (e-mail sem conta)", { error: null }],
    ["500 (e-mail com conta)", falhaDoGoTrue(500)],
  ] as const)(
    "⭐ responde smtp_not_configured sem chamar o GoTrue — GoTrue responderia %s",
    async (_, resposta) => {
      estado.resposta = resposta;

      const r = await requestPasswordReset({ email: EMAIL });

      expect(r).toEqual({ ok: false, error: "smtp_not_configured" });
      expect(estado.chamouGoTrue).toBe(0);
    },
  );

  it("host SEM remetente não conta como SMTP (mesma régua do kit)", async () => {
    estado.banco = { data: { ...LINHA_COM_SMTP, from_email: null }, error: null };

    const r = await requestPasswordReset({ email: EMAIL });

    expect(r).toEqual({ ok: false, error: "smtp_not_configured" });
    expect(estado.chamouGoTrue).toBe(0);
  });

  it("a catraca continua vencendo a mensagem nova", async () => {
    estado.limitado = true;

    const r = await requestPasswordReset({ email: EMAIL });

    expect(r).toEqual({ ok: false, error: "rate_limited" });
  });

  it.each([
    ["devolve erro", { data: null, error: { message: "relation does not exist" } }],
    ["lança", "lanca"],
  ] as const)(
    "o banco que %s NÃO vira 'sem SMTP' — segue para o GoTrue, como antes",
    async (_, banco) => {
      estado.banco = banco;
      estado.resposta = falhaDoGoTrue(500);

      const r = await requestPasswordReset({ email: EMAIL });

      expect(r).toEqual({ ok: false, error: "request_failed" });
      expect(estado.chamouGoTrue).toBe(1);
    },
  );
});

describe("Supabase fora do single-server (nuvem ou separado)", () => {
  it("sem SMTP no CRM, o comportamento é o de antes: o login tem e-mail próprio", async () => {
    vi.stubEnv("SINGLE_SERVER", "");
    estado.resposta = { error: null };

    const r = await requestPasswordReset({ email: EMAIL });

    expect(r).toEqual({ ok: true });
    expect(estado.chamouGoTrue).toBe(1);
  });
});

describe("single-server COM SMTP", () => {
  it("⭐ CONTROLE — o genérico preservado: falha por outro motivo", async () => {
    estado.banco = { data: LINHA_COM_SMTP, error: null };
    estado.resposta = falhaDoGoTrue(500);

    const r = await requestPasswordReset({ email: EMAIL });

    expect(r).toEqual({ ok: false, error: "request_failed" });
    expect(estado.chamouGoTrue).toBe(1);
  });

  it("SMTP só no .env do CRM (sem linha da tela) também conta", async () => {
    estado.envSmtpHost = "smtp.revenda.com.br";
    estado.envSmtpFrom = "nao-responda@revenda.com.br";

    const r = await requestPasswordReset({ email: EMAIL });

    expect(r).toEqual({ ok: true });
    expect(estado.chamouGoTrue).toBe(1);
  });

  it("o caminho de sucesso continua como estava", async () => {
    estado.banco = { data: LINHA_COM_SMTP, error: null };

    const r = await requestPasswordReset({ email: EMAIL });

    expect(r).toEqual({ ok: true });
    expect(estado.chamouGoTrue).toBe(1);
  });
});
