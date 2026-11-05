import { generateKeyPairSync, randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Rota que entrega o JWT de contexto à tela do módulo (spec 33, F3, tarefa 4): só sessão, só módulo
 * ligado na organização da sessão, 503 claro sem a chave, e o JWT entregue identifica a pessoa da
 * sessão com validade curta.
 */

const mocks = vi.hoisted(() => ({
  env: { MODULE_JWT_PRIVATE_KEY: "" },
  auth: null as unknown,
  suporte: null as unknown,
  vinculo: null as unknown,
  instalacao: null as unknown,
}));

vi.mock("@/lib/env", () => ({ env: mocks.env }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: async () => mocks.auth }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => mocks.suporte }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: async () => null }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = () => c;
      c.maybeSingle = async () => ({
        data: tabela === "organization_extensions" ? mocks.vinculo : mocks.instalacao,
        error: null,
      });
      return c;
    },
  }),
}));

const PESSOA = randomUUID();
const ORG = randomUUID();
const INST = randomUUID();

function pem(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

async function chamar(id = INST) {
  const { POST } = await import("./route");
  const res = await POST(new Request(`http://localhost/api/v1/extensions/${id}/contexto`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
  return { res, corpo: (await res.json()) as { data?: { jwt: string; expires_at: string }; error?: { code: string; message: string } } };
}

beforeEach(() => {
  mocks.env.MODULE_JWT_PRIVATE_KEY = pem();
  mocks.suporte = null;
  mocks.auth = { ok: true, user: { id: PESSOA }, org: { orgId: ORG, role: "viewer" } };
  mocks.vinculo = { enabled: true };
  mocks.instalacao = { disabled_at: null, removed_at: null };
});

describe("POST /api/v1/extensions/[id]/contexto", () => {
  it("entrega jwt e expires_at (sem cache), com a pessoa da SESSÃO e validade de até 5 minutos", async () => {
    const { res, corpo } = await chamar();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const { decodeJwt } = await import("jose");
    const p = decodeJwt(corpo.data!.jwt);
    expect(p).toMatchObject({ sub: PESSOA, org: ORG, inst: INST });
    expect(p.exp! - p.iat!).toBeLessThanOrEqual(300);
    expect(corpo.data!.expires_at).toBe(new Date(p.exp! * 1000).toISOString());
  });

  it("sem MODULE_JWT_PRIVATE_KEY: 503 com mensagem clara", async () => {
    mocks.env.MODULE_JWT_PRIVATE_KEY = "";
    const { res, corpo } = await chamar();
    expect(res.status).toBe(503);
    expect(corpo.error?.code).toBe("module_context_unavailable");
    expect(corpo.error?.message).toContain("MODULE_JWT_PRIVATE_KEY");
    expect(corpo.data).toBeUndefined();
  });

  it("módulo não ligado nesta organização, desligado ou removido: 404, sem JWT", async () => {
    for (const [vinculo, instalacao] of [
      [null, { disabled_at: null, removed_at: null }],
      [{ enabled: false }, { disabled_at: null, removed_at: null }],
      [{ enabled: true }, { disabled_at: "2026-11-01T00:00:00Z", removed_at: null }],
      [{ enabled: true }, { disabled_at: null, removed_at: "2026-11-01T00:00:00Z" }],
      [{ enabled: true }, null],
    ]) {
      mocks.vinculo = vinculo;
      mocks.instalacao = instalacao;
      const { res, corpo } = await chamar();
      expect(res.status).toBe(404);
      expect(corpo.data).toBeUndefined();
    }
  });

  it("sem sessão: devolve a recusa do requireRole e nada é emitido", async () => {
    mocks.auth = {
      ok: false,
      response: new Response(JSON.stringify({ error: { code: "unauthenticated" } }), { status: 401 }),
    };
    const { res, corpo } = await chamar();
    expect(res.status).toBe(401);
    expect(corpo.data).toBeUndefined();
  });

  it("acompanhamento restrito: barrado antes de qualquer coisa", async () => {
    mocks.suporte = new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403 });
    const { res } = await chamar();
    expect(res.status).toBe(403);
  });

  it("id que não é UUID: 404", async () => {
    const { res } = await chamar("nao-e-uuid");
    expect(res.status).toBe(404);
  });

  it("a rota é de sessão: não está em lib/auth/public-paths", async () => {
    const { isPublicPath } = await import("@/lib/auth/public-paths");
    expect(isPublicPath(`/api/v1/extensions/${INST}/contexto`)).toBe(false);
  });
});
