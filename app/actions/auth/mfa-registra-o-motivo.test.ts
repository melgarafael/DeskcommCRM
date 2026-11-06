/**
 * Issue #3161 — o motivo que o provedor devolve quando o cadastro do fator
 * (`enrollMfa`) ou a confirmação (`confirmMfaEnroll`) falham precisa ficar no
 * LOG DO SERVIDOR, no mesmo ponto em que a action devolve o erro genérico.
 *
 * O provedor aqui é um stub (listFactors/unenroll/enroll/challenge/verify). O
 * logger é o REAL (`@/lib/logger`) e a prova é a linha JSON que ele escreve no
 * `console.error` — espiar o `logger` mediria o mock, não o que a VPS mostra.
 *
 * O caso de CONTROLE (o que NÃO pode aparecer) tem segredo e código TOTP de
 * verdade no processo: um segredo em base32 vindo do cadastro que deu certo e o
 * código de 6 dígitos que chega a ser enviado ao provedor. Sem isso, "o segredo
 * não está no log" seria uma frase vazia — o segredo nunca teria existido.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { createClient } from "@/lib/supabase/server";

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => ({ get: () => null })) }));
vi.mock("@/lib/branding/saida", () => ({
  marcaDaSaida: vi.fn(async () => ({ nome: "Marca de Teste" })),
}));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => true,
}));
// Os códigos de recuperação só são gravados pelo client de serviço (0755).
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      delete: () => ({ eq: async () => ({ error: null }) }),
      insert: async () => ({ error: null }),
    }),
  }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn(async () => "data:image/png;base64,QR") },
}));

import { confirmMfaEnroll } from "./confirmMfaEnroll";
import { enrollMfa } from "./enrollMfa";

// ── o provedor, montado por opção ────────────────────────────────────────────

type ErroDoProvedor = { name: string; message: string; code: string; status: number };

/** Mesma forma do `AuthApiError` do `@supabase/auth-js`. */
function erro(message: string, code: string): ErroDoProvedor {
  return { name: "AuthApiError", message, code, status: 422 };
}

const FATOR_ANTIGO = { id: "f-antigo", factor_type: "totp", status: "unverified" };

type Opcoes = {
  fatores?: Array<{ id: string; factor_type: string; status: string }>;
  segredo?: string;
  falhaNoUnenroll?: ErroDoProvedor;
  falhaNoEnroll?: ErroDoProvedor;
  falhaNoChallenge?: ErroDoProvedor;
  falhaNoVerify?: ErroDoProvedor;
};

function provedor(opcoes: Opcoes) {
  const chamadas = {
    listFactors: vi.fn(),
    unenroll: vi.fn(),
    enroll: vi.fn(),
    challenge: vi.fn(),
    verify: vi.fn(),
  };

  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () => ({ data: { user: { id: "eu" } }, error: null }),
      mfa: {
        listFactors: async () => {
          chamadas.listFactors();
          return { data: { all: opcoes.fatores ?? [] }, error: null };
        },
        unenroll: async (args: { factorId: string }) => {
          chamadas.unenroll(args);
          return { data: null, error: opcoes.falhaNoUnenroll ?? null };
        },
        enroll: async (args: unknown) => {
          chamadas.enroll(args);
          if (opcoes.falhaNoEnroll) return { data: null, error: opcoes.falhaNoEnroll };
          return {
            data: {
              id: "f-novo",
              type: "totp",
              totp: {
                qr_code: "<svg/>",
                uri: "otpauth://totp/Marca%20de%20Teste:eu?secret=…",
                secret: opcoes.segredo ?? "SEGREDO-DE-TESTE",
              },
            },
            error: null,
          };
        },
        challenge: async (args: { factorId: string }) => {
          chamadas.challenge(args);
          if (opcoes.falhaNoChallenge) return { data: null, error: opcoes.falhaNoChallenge };
          return { data: { id: "c1" }, error: null };
        },
        verify: async (args: { factorId: string; challengeId: string; code: string }) => {
          chamadas.verify(args);
          if (opcoes.falhaNoVerify) return { data: null, error: opcoes.falhaNoVerify };
          return { data: { access_token: "token" }, error: null };
        },
      },
    },
    from: () => ({ insert: async () => ({ error: null }) }),
  } as never);

  return chamadas;
}

// ── o que o logger escreveu, lido linha por linha ────────────────────────────

let cruas: string[] = [];

beforeEach(() => {
  vi.stubEnv("INTERNAL_SECRET", "segredo-da-instalacao");
  cruas = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    cruas.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** As linhas do logger estruturado, já parseadas (ignora o que não for JSON). */
function linhas(): Array<Record<string, unknown>> {
  return cruas
    .map((linha) => {
      try {
        return JSON.parse(linha) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((o): o is Record<string, unknown> => o !== null && typeof o.msg === "string");
}

/** As chaves que o envelope do logger usa, fora o contexto da linha. */
const CHAVES_DO_ENVELOPE = ["level", "msg", "ts"];
/** Os únicos campos de contexto que estas actions podem registrar (#3161). */
const CHAVES_DO_CONTEXTO = ["code", "error", "factor_id"];

// ── 1. o cadastro que falha ──────────────────────────────────────────────────

const MOTIVO_DO_ENROLL = 'A factor with the friendly name "Acesso 2026-10-21" already exists';

describe("enrollMfa — o motivo da falha fica no log do servidor", () => {
  it("o cadastro que falha registra o motivo do provedor e devolve o mesmo erro de antes", async () => {
    provedor({ falhaNoEnroll: erro(MOTIVO_DO_ENROLL, "mfa_factor_name_conflict") });

    const resultado = await enrollMfa();

    expect(resultado).toEqual({ ok: false, error: "enroll_failed", message: MOTIVO_DO_ENROLL });
    expect(linhas()).toEqual([
      expect.objectContaining({
        level: "error",
        msg: "[mfa-cadastro] o provedor recusou o cadastro do fator",
        code: "mfa_factor_name_conflict",
        error: MOTIVO_DO_ENROLL,
      }),
    ]);
  });

  it("o fator não confirmado que não pôde ser removido entra no log, em vez de ser engolido", async () => {
    const chamadas = provedor({
      fatores: [FATOR_ANTIGO],
      falhaNoUnenroll: erro("factor not found", "mfa_factor_not_found"),
    });

    const resultado = await enrollMfa();

    // O retorno do `unenroll` é lido: ele foi chamado para o fator certo…
    expect(chamadas.unenroll).toHaveBeenCalledWith({ factorId: "f-antigo" });
    // …e a falha dele virou linha de log, com o motivo que o "already exists"
    // seguinte esconderia (o #3156 mostra isso como frase genérica na tela).
    expect(linhas()).toEqual([
      expect.objectContaining({
        level: "error",
        msg: "[mfa-cadastro] o fator não confirmado não pôde ser removido",
        factor_id: "f-antigo",
        code: "mfa_factor_not_found",
        error: "factor not found",
      }),
    ]);
    // E o cadastro segue: a remoção do fator velho não é pré-requisito do novo.
    expect(resultado.ok).toBe(true);
  });

  it("sem falha, o log não ganha linha nenhuma (o log é da falha, não do caminho feliz)", async () => {
    provedor({ fatores: [] });

    expect((await enrollMfa()).ok).toBe(true);
    expect(linhas()).toEqual([]);
  });
});

// ── 2. a confirmação que falha ───────────────────────────────────────────────

describe("confirmMfaEnroll — o motivo da falha fica no log do servidor", () => {
  it("o desafio que falha registra o motivo do provedor", async () => {
    provedor({ falhaNoChallenge: erro("challenge failed", "mfa_challenge_failed") });

    const resultado = await confirmMfaEnroll("131313", "f-novo");

    expect(resultado).toEqual({
      ok: false,
      error: "challenge_failed",
      message: "challenge failed",
    });
    expect(linhas()).toEqual([
      expect.objectContaining({
        level: "error",
        msg: "[mfa-confirmacao] o provedor recusou o desafio do fator",
        factor_id: "f-novo",
        code: "mfa_challenge_failed",
        error: "challenge failed",
      }),
    ]);
  });

  it("o código recusado registra o motivo do provedor", async () => {
    provedor({ falhaNoVerify: erro("Invalid TOTP code entered", "mfa_verify_failed") });

    const resultado = await confirmMfaEnroll("131313", "f-novo");

    expect(resultado).toEqual({
      ok: false,
      error: "verify_failed",
      message: "Invalid TOTP code entered",
    });
    expect(linhas()).toEqual([
      expect.objectContaining({
        level: "error",
        msg: "[mfa-confirmacao] o provedor recusou o código do fator",
        factor_id: "f-novo",
        code: "mfa_verify_failed",
        error: "Invalid TOTP code entered",
      }),
    ]);
  });
});

// ── 3. o CONTROLE: o que não pode aparecer ───────────────────────────────────

const CODIGO_TOTP = "131313";
const SEGREDO = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

describe("o que NUNCA entra no log", () => {
  it("CONTROLE: nem o código TOTP nem o segredo aparecem em linha nenhuma", async () => {
    // 1) O cadastro que dá certo devolve o SEGREDO ao cliente — ele existe, de
    //    verdade, neste processo. Sem este passo o controle seria vazio.
    provedor({ fatores: [], segredo: SEGREDO });
    const cadastro = await enrollMfa();
    expect(cadastro).toEqual(expect.objectContaining({ ok: true, secret: SEGREDO }));

    // 2) As quatro falhas registram, com o segredo vivo e o código passando:
    provedor({
      fatores: [FATOR_ANTIGO],
      falhaNoUnenroll: erro("factor not found", "mfa_factor_not_found"),
      falhaNoEnroll: erro(MOTIVO_DO_ENROLL, "mfa_factor_name_conflict"),
    });
    expect((await enrollMfa()).ok).toBe(false);

    provedor({ falhaNoChallenge: erro("challenge failed", "mfa_challenge_failed") });
    expect((await confirmMfaEnroll(CODIGO_TOTP, "f-novo")).ok).toBe(false);

    const chamadas = provedor({
      falhaNoVerify: erro("Invalid TOTP code entered", "mfa_verify_failed"),
    });
    expect((await confirmMfaEnroll(CODIGO_TOTP, "f-novo")).ok).toBe(false);

    // O código chegou ao provedor: é o mesmo que passou pela action e sobrou na
    // memória quando a linha de log foi escrita.
    expect(chamadas.verify).toHaveBeenCalledWith({
      factorId: "f-novo",
      challengeId: "c1",
      code: CODIGO_TOTP,
    });

    const registradas = linhas();
    expect(registradas).toHaveLength(4);

    const tudo = cruas.join("\n");
    expect(tudo).not.toContain(CODIGO_TOTP);
    expect(tudo).not.toContain(SEGREDO);

    // E a forma é FECHADA: nenhuma chave fora do envelope e das três do
    // contexto. Um segredo só apareceria no log se houvesse campo para ele.
    for (const linha of registradas) {
      // O envelope do logger está lá…
      expect(linha.level).toBe("error");
      expect(typeof linha.msg).toBe("string");
      expect(typeof linha.ts).toBe("string");
      // …e nenhuma chave fora do envelope e das três do contexto.
      for (const chave of Object.keys(linha)) {
        expect([...CHAVES_DO_ENVELOPE, ...CHAVES_DO_CONTEXTO]).toContain(chave);
      }
    }
  });
});

// ── 4. a tela de hoje não regride ────────────────────────────────────────────

describe("a mensagem que a tela mostra hoje segue igual (#3156 não regride)", () => {
  it("os três erros continuam devolvendo o mesmo objeto, `message` inclusive", async () => {
    // O modal lê `res.message ?? t(…)`. O log entra AO LADO do retorno, não no
    // lugar dele: quem remover o `message` do retorno derruba este caso — é o
    // contrato do qual o #3156 depende para tirar o texto cru da TELA sem
    // perder o motivo no servidor.
    provedor({ falhaNoEnroll: erro(MOTIVO_DO_ENROLL, "mfa_factor_name_conflict") });
    expect(await enrollMfa()).toEqual({
      ok: false,
      error: "enroll_failed",
      message: MOTIVO_DO_ENROLL,
    });

    provedor({ falhaNoChallenge: erro("challenge failed", "mfa_challenge_failed") });
    expect(await confirmMfaEnroll(CODIGO_TOTP, "f-novo")).toEqual({
      ok: false,
      error: "challenge_failed",
      message: "challenge failed",
    });

    provedor({ falhaNoVerify: erro("Invalid TOTP code entered", "mfa_verify_failed") });
    expect(await confirmMfaEnroll(CODIGO_TOTP, "f-novo")).toEqual({
      ok: false,
      error: "verify_failed",
      message: "Invalid TOTP code entered",
    });
  });
});
