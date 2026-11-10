import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  set: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  filtros: [] as Array<[string, string, unknown]>,
  linhas: [] as Array<{ id: string }>,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (k: string) => (m.jar.has(k) ? { value: m.jar.get(k) } : undefined),
    set: (k: string, v: string, o: unknown) => {
      m.jar.set(k, v);
      m.set(k, v, o);
    },
  }),
}));
vi.mock("@/lib/supabase/cookie-secure", () => ({ cookieSecure: () => true }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const q = {
        delete: () => q,
        insert: async (v: unknown) => {
          m.insert(v);
          return { error: null };
        },
        update: (v: unknown) => {
          m.update(v);
          return q;
        },
        eq: (c: string, v: unknown) => (m.filtros.push(["eq", c, v]), q),
        gt: (c: string, v: unknown) => (m.filtros.push(["gt", c, v]), q),
        lt: async () => ({ error: null }),
        select: async () => ({ data: m.linhas, error: null }),
      };
      return q;
    },
  }),
}));

import {
  COOKIE_DISPOSITIVO_CONFIAVEL,
  confiarNesteDispositivo,
  reconhecerDispositivoConfiavel,
} from "./dispositivo-confiavel";

const jwtCom = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;

beforeEach(() => {
  vi.clearAllMocks();
  m.jar.clear();
  m.filtros.length = 0;
  m.linhas = [];
});

describe("confiarNesteDispositivo", () => {
  it("o banco guarda o HASH; o cookie leva o token, httpOnly, Lax e por 30 dias", async () => {
    await confiarNesteDispositivo("u1", "f1", "Firefox");
    const [nome, token, opcoes] = m.set.mock.calls[0]!;
    expect(nome).toBe(COOKIE_DISPOSITIVO_CONFIAVEL);
    expect(opcoes).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, maxAge: 30 * 86_400 });
    const linha = m.insert.mock.calls[0]![0] as {
      user_id: string;
      factor_id: string;
      token_hash: string;
      expires_at: string;
    };
    expect(linha.user_id).toBe("u1");
    expect(linha.factor_id).toBe("f1");
    expect(linha.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(linha.token_hash).not.toContain(token);
    const dias = (new Date(linha.expires_at).getTime() - Date.now()) / 86_400_000;
    expect(dias).toBeGreaterThan(29.9);
    expect(dias).toBeLessThanOrEqual(30);
  });
});

describe("reconhecerDispositivoConfiavel", () => {
  it("sem cookie, não reconhece nem toca o banco", async () => {
    expect(await reconhecerDispositivoConfiavel("u1", "f1", jwtCom({ session_id: "s1" }))).toBe(false);
    expect(m.update).not.toHaveBeenCalled();
  });

  it("amarra a sessão do token à confiança DESTA pessoa, pelo hash e dentro do prazo", async () => {
    m.jar.set(COOKIE_DISPOSITIVO_CONFIAVEL, "tok");
    m.linhas = [{ id: "d1" }];
    expect(await reconhecerDispositivoConfiavel("u1", "f1", jwtCom({ session_id: "s1" }))).toBe(true);
    expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ session_id: "s1" }));
    expect(m.filtros).toEqual(
      expect.arrayContaining([
        ["eq", "token_hash", createHash("sha256").update("tok").digest("hex")],
        ["eq", "user_id", "u1"],
        ["eq", "factor_id", "f1"],
        ["gt", "expires_at", expect.any(String)],
      ]),
    );
  });

  it("nenhuma linha casou (outra pessoa, vencida, esquecida): não reconhece", async () => {
    m.jar.set(COOKIE_DISPOSITIVO_CONFIAVEL, "tok");
    expect(await reconhecerDispositivoConfiavel("u1", "f1", jwtCom({ session_id: "s1" }))).toBe(false);
  });

  it("token sem session_id: não reconhece", async () => {
    m.jar.set(COOKIE_DISPOSITIVO_CONFIAVEL, "tok");
    m.linhas = [{ id: "d1" }];
    expect(await reconhecerDispositivoConfiavel("u1", "f1", jwtCom({ sub: "u1" }))).toBe(false);
    expect(m.update).not.toHaveBeenCalled();
  });
});
