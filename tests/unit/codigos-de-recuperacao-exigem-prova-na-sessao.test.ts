/**
 * Emitir códigos de recuperação — regenerar, ou cadastrar um fator novo, que
 * também os emite — exige o fator provado NESTA sessão (`aal2` exato).
 *
 * Ter fator cadastrado é política de cadastro; provar o fator é política de
 * sessão. As três ações conferiam só a primeira. O provedor e a sessão são
 * dublês: `nivel` é o `currentLevel` da sessão, `fatores` o que o provedor lista.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createClient } from "@/lib/supabase/server";

const estado = vi.hoisted(() => ({
  nivel: "aal1" as "aal1" | "aal2" | null,
  fatores: [] as Array<{ id: string; factor_type: string; status: string }>,
  escritas: [] as string[],
  provedor: [] as string[],
  servico: true,
  listaFalha: false,
}));

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => ({ get: () => null })) }));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: vi.fn(async () => ({ nome: "Marca" })) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: () => estado.servico }));
// O client de serviço anota com prefixo: a tabela de códigos só aceita escrita dele (0755).
const tabela = (quem: string) => () => ({
  delete: () => ({ eq: async () => { estado.escritas.push(`${quem}:delete`); return { error: null }; } }),
  insert: async () => { estado.escritas.push(`${quem}:insert`); return { error: null }; },
});
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: tabela("servico") }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ sessionAal: async () => estado.nivel }));
vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn(async () => "data:image/png;base64,QR") } }));

import { regenerateRecoveryCodes } from "@/app/actions/settings/regenerateRecoveryCodes";
import { enrollMfa } from "@/app/actions/auth/enrollMfa";
import { confirmMfaEnroll } from "@/app/actions/auth/confirmMfaEnroll";

const VERIFICADO = { id: "f1", factor_type: "totp", status: "verified" };
const NAO_CONFIRMADO = { id: "f2", factor_type: "totp", status: "unverified" };

beforeEach(() => {
  vi.stubEnv("INTERNAL_SECRET", "segredo-da-instalacao");
  estado.nivel = "aal1";
  estado.fatores = [];
  estado.escritas = [];
  estado.provedor = [];
  estado.servico = true;
  estado.listaFalha = false;
  const anota = (nome: string) => async () => {
    estado.provedor.push(nome);
    return nome === "enroll"
      ? { data: { id: "f-novo", totp: { uri: "otpauth://x", secret: "S" } }, error: null }
      : { data: { id: "c1" }, error: null };
  };
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () => ({ data: { user: { id: "eu" } }, error: null }),
      mfa: {
        listFactors: async () =>
          estado.listaFalha
            ? { data: null, error: { message: "indisponível" } }
            : {
                data: { all: estado.fatores, totp: estado.fatores.filter((f) => f.factor_type === "totp") },
                error: null,
              },
        unenroll: anota("unenroll"),
        enroll: anota("enroll"),
        challenge: anota("challenge"),
        verify: anota("verify"),
      },
    },
    from: tabela("usuario"),
  } as never);
});

describe("regenerar códigos de recuperação", () => {
  it("sessão aal1 com fator verificado é recusada com mfa_required e nada é gravado", async () => {
    estado.fatores = [VERIFICADO];
    expect(await regenerateRecoveryCodes()).toEqual({ ok: false, error: "mfa_required" });
    expect(estado.escritas).toEqual([]);
  });

  it("sessão sem nível conhecido também é recusada", async () => {
    estado.fatores = [VERIFICADO];
    estado.nivel = null;
    expect(await regenerateRecoveryCodes()).toEqual({ ok: false, error: "mfa_required" });
    expect(estado.escritas).toEqual([]);
  });

  it("sessão aal2 gera 10 códigos e troca os antigos", async () => {
    estado.fatores = [VERIFICADO];
    estado.nivel = "aal2";
    const r = await regenerateRecoveryCodes();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.recovery_codes).toHaveLength(10);
    expect(estado.escritas).toEqual(["servico:delete", "servico:insert"]);
  });

  it("sem o client de serviço, recusa com service_unavailable e não grava pelo client do usuário", async () => {
    estado.fatores = [VERIFICADO];
    estado.nivel = "aal2";
    estado.servico = false;
    expect(await regenerateRecoveryCodes()).toEqual({ ok: false, error: "service_unavailable" });
    expect(estado.escritas).toEqual([]);
  });

  it("sem fator verificado segue mfa_not_enrolled", async () => {
    estado.nivel = "aal2";
    expect(await regenerateRecoveryCodes()).toEqual({ ok: false, error: "mfa_not_enrolled" });
  });
});

describe("cadastrar um fator novo", () => {
  it("com fator verificado, sessão aal1 é recusada antes de tocar o provedor", async () => {
    estado.fatores = [VERIFICADO, NAO_CONFIRMADO];
    expect(await enrollMfa()).toEqual({ ok: false, error: "mfa_required" });
    expect(estado.provedor).toEqual([]);
  });

  it("com fator verificado, sessão aal2 cadastra", async () => {
    estado.fatores = [VERIFICADO];
    estado.nivel = "aal2";
    expect((await enrollMfa()).ok).toBe(true);
    expect(estado.provedor).toContain("enroll");
  });

  it("sem a lista de fatores, recusa em vez de tratar como primeiro cadastro", async () => {
    estado.listaFalha = true;
    expect((await enrollMfa()).ok).toBe(false);
    expect(estado.provedor).toEqual([]);
  });

  it("primeiro cadastro (nenhum fator verificado) segue em aal1", async () => {
    estado.fatores = [NAO_CONFIRMADO];
    expect((await enrollMfa()).ok).toBe(true);
    expect(estado.provedor).toEqual(["unenroll", "enroll"]);
  });
});

describe("confirmar um fator novo", () => {
  it("com fator verificado, sessão aal1 é recusada sem desafio e sem códigos", async () => {
    estado.fatores = [VERIFICADO, NAO_CONFIRMADO];
    expect(await confirmMfaEnroll("123456", "f2")).toEqual({ ok: false, error: "mfa_required" });
    expect(estado.provedor).toEqual([]);
    expect(estado.escritas).toEqual([]);
  });

  it("com fator verificado, sessão aal2 confirma e emite códigos", async () => {
    estado.fatores = [VERIFICADO, NAO_CONFIRMADO];
    estado.nivel = "aal2";
    const r = await confirmMfaEnroll("123456", "f2");
    expect(r.ok).toBe(true);
    expect(estado.escritas).toEqual(["servico:delete", "servico:insert"]);
  });

  it("sem o client de serviço, recusa antes do desafio e não grava pelo client do usuário", async () => {
    estado.fatores = [NAO_CONFIRMADO];
    estado.servico = false;
    expect(await confirmMfaEnroll("123456", "f2")).toEqual({ ok: false, error: "service_unavailable" });
    expect(estado.provedor).toEqual([]);
    expect(estado.escritas).toEqual([]);
  });

  it("sem a lista de fatores, recusa sem desafio e sem códigos", async () => {
    estado.listaFalha = true;
    expect((await confirmMfaEnroll("123456", "f2")).ok).toBe(false);
    expect(estado.provedor).toEqual([]);
    expect(estado.escritas).toEqual([]);
  });

  it("primeiro cadastro confirma em aal1", async () => {
    estado.fatores = [NAO_CONFIRMADO];
    const r = await confirmMfaEnroll("123456", "f2");
    expect(r.ok).toBe(true);
    expect(estado.provedor).toEqual(["challenge", "verify"]);
  });
});
