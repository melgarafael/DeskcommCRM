/**
 * A API da chave de Mapas: a chave entra cifrada, nunca volta ao browser, nunca
 * vai para a auditoria, e só admin grava/testa/remove.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  role: vi.fn(),
  support: vi.fn(),
  audit: vi.fn(),
  admin: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.support }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: deps.admin }));

import { DELETE, GET, PUT } from "@/app/api/v1/ai/mapas/route";
import { POST as TESTAR } from "@/app/api/v1/ai/mapas/testar/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const EU = "22222222-2222-4222-8222-222222222222";
const CHAVE = "AIzaSyTESTE_chave-de-mapas-0123456789";

/** Banco de mentira: uma linha (ou nenhuma) em `map_provider_credentials`. */
function bancoFalso(opcoes: { linha?: { api_key_last4: string } | null; cifra?: boolean } = {}) {
  let linha: Record<string, unknown> | null = opcoes.linha
    ? { ...opcoes.linha, api_key_encrypted: "\\xcifrada", updated_at: "2026-09-28T00:00:00Z" }
    : null;
  const upserts: Record<string, unknown>[] = [];
  const admin = {
    upserts,
    rpc: vi.fn(async (nome: string, args: Record<string, string>) => {
      if (nome === "fn_encrypt_oauth") return opcoes.cifra === false ? { data: null, error: { message: "sem GUC" } } : { data: `\\xENC(${(args.plaintext ?? "").length})`, error: null };
      if (nome === "fn_decrypt_oauth") return { data: CHAVE, error: null };
      return { data: null, error: null };
    }),
    from(tabela: string) {
      if (tabela === "organizations") {
        const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { locale: "es" }, error: null }) };
        return q;
      }
      let apagar = false;
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: linha, error: null }),
        upsert: async (v: Record<string, unknown>) => {
          upserts.push(v);
          linha = { ...v, updated_at: "2026-09-28T01:00:00Z" };
          return { error: null };
        },
        delete: () => {
          apagar = true;
          return q;
        },
        then: (ok: (r: unknown) => unknown) => {
          const havia = linha ? [{ id: "x" }] : [];
          if (apagar) linha = null;
          return ok({ data: havia, error: null });
        },
      };
      return q;
    },
  };
  return admin;
}

const put = (body: unknown) =>
  new Request("http://localhost/api/v1/ai/mapas", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const testar = (body: unknown) =>
  new Request("http://localhost/api/v1/ai/mapas/testar", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  deps.support.mockResolvedValue(null);
  deps.role.mockResolvedValue({ ok: true, user: { id: EU, idioma: "pt-BR" }, org: { orgId: ORG } });
});
afterEach(() => vi.restoreAllMocks());

describe("GET — o estado, nunca a chave", () => {
  it("sem chave e com chave: só configurada e os 4 últimos", async () => {
    deps.admin.mockReturnValue(bancoFalso());
    expect((await (await GET()).json()).data).toMatchObject({ configurada: false, ultimos4: null });

    deps.admin.mockReturnValue(bancoFalso({ linha: { api_key_last4: "6789" } }));
    const corpo = JSON.stringify(await (await GET()).json());
    expect(JSON.parse(corpo).data).toMatchObject({ configurada: true, ultimos4: "6789" });
    expect(corpo).not.toContain("cifrada");
  });
});

describe("PUT — gravar", () => {
  it("⭐ grava CIFRADA, com os 4 últimos; a chave não aparece no banco, na resposta nem na auditoria", async () => {
    const admin = bancoFalso();
    deps.admin.mockReturnValue(admin);
    const res = await PUT(put({ api_key: CHAVE }) as never);
    expect(res.status).toBe(200);
    const corpo = JSON.stringify(await res.json());

    expect(admin.upserts).toHaveLength(1);
    expect(admin.upserts[0]).toMatchObject({ organization_id: ORG, provider: "google_maps", api_key_last4: "6789", updated_by: EU });
    expect(JSON.stringify(admin.upserts[0])).not.toContain(CHAVE);
    expect(corpo).not.toContain(CHAVE);
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "ai.maps_credential_saved", organizationId: ORG }));
    expect(JSON.stringify(deps.audit.mock.calls)).not.toContain(CHAVE);
  });

  it("recusa o que não parece chave, sem gravar", async () => {
    const admin = bancoFalso();
    deps.admin.mockReturnValue(admin);
    for (const api_key of ["curta", "tem espaço no meio da chave AIza1234", "x".repeat(201)]) {
      expect((await PUT(put({ api_key }) as never)).status).toBe(422);
    }
    expect((await PUT(put({ api_key: CHAVE, extra: 1 }) as never)).status).toBe(422);
    expect(admin.upserts).toHaveLength(0);
  });

  it("sem cifra, não grava texto claro", async () => {
    const admin = bancoFalso({ cifra: false });
    deps.admin.mockReturnValue(admin);
    expect((await PUT(put({ api_key: CHAVE }) as never)).status).toBe(500);
    expect(admin.upserts).toHaveLength(0);
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("papel e suporte temporário barram antes de qualquer efeito", async () => {
    const admin = bancoFalso();
    deps.admin.mockReturnValue(admin);
    deps.role.mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 403 }) });
    expect((await PUT(put({ api_key: CHAVE }) as never)).status).toBe(403);
    expect(deps.role).toHaveBeenCalledWith("admin", expect.anything());

    deps.support.mockResolvedValueOnce(new Response(null, { status: 423 }));
    expect((await PUT(put({ api_key: CHAVE }) as never)).status).toBe(423);
    expect(admin.upserts).toHaveLength(0);
  });
});

describe("DELETE — remover", () => {
  it("remove e audita; sem chave, não audita remoção que não houve", async () => {
    deps.admin.mockReturnValue(bancoFalso({ linha: { api_key_last4: "6789" } }));
    expect((await (await DELETE()).json()).data).toMatchObject({ configurada: false, removida: true });
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "ai.maps_credential_removed" }));

    deps.audit.mockClear();
    deps.admin.mockReturnValue(bancoFalso());
    expect((await (await DELETE()).json()).data).toMatchObject({ removida: false });
    expect(deps.audit).not.toHaveBeenCalled();
  });
});

describe("POST /testar — o botão Testar", () => {
  it("⭐ testa a chave colada ANTES de gravar, e diz o endereço do ponto de teste", async () => {
    deps.admin.mockReturnValue(bancoFalso());
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "OK",
          results: [{ address_components: [{ long_name: "São Paulo", types: ["locality"] }, { long_name: "São Paulo", types: ["administrative_area_level_1"] }] }],
        }),
        { status: 200 },
      ),
    );
    const res = await TESTAR(testar({ api_key: CHAVE }) as never);
    const corpo = await res.json();
    expect(corpo.data).toEqual({ ok: true, endereco: "São Paulo" });
    const url = new URL(String(f.mock.calls[0]![0]));
    expect(url.searchParams.get("key")).toBe(CHAVE);
    expect(url.searchParams.get("language")).toBe("es");
    expect(JSON.stringify(corpo)).not.toContain(CHAVE);
  });

  it("sem chave colada, usa a gravada; sem nenhuma, pede uma", async () => {
    deps.admin.mockReturnValue(bancoFalso());
    expect((await TESTAR(testar({}) as never)).status).toBe(422);

    deps.admin.mockReturnValue(bancoFalso({ linha: { api_key_last4: "6789" } }));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "REQUEST_DENIED", error_message: "This API is not activated on your API project." }), { status: 200 }),
    );
    const corpo = await (await TESTAR(testar({}) as never)).json();
    expect(corpo.data).toMatchObject({ ok: false, motivo: "api_desativada" });
  });

  it("só admin testa — o teste gasta a cota da chave da organização", async () => {
    deps.admin.mockReturnValue(bancoFalso());
    deps.role.mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 403 }) });
    expect((await TESTAR(testar({ api_key: CHAVE }) as never)).status).toBe(403);
    expect(deps.role).toHaveBeenCalledWith("admin", expect.anything());
  });
});
