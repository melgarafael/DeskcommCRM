import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { loadAuthUser } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { GET, PATCH } from "./route";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

/** No molde de `ai-access/route.test.ts`: a irmã que esta rota copia.
 * A linha não tem nome de sessão: a escolha é gravada e a resposta diz
 * `aplicado: false` (vale na próxima reconexão) — a conversa com o canal é
 * oportunista e não é o que esta rota prova. */
const org = "11111111-1111-4111-8111-111111111111";
const canal = "22222222-2222-4222-8222-222222222222";
const filters: Record<string, unknown> = {};
const update = vi.fn();
const row = { id: canal, organization_id: org, archived_at: null, metadata: { ai_gate: "allowlist" } };
const context = (id = canal) => ({ params: Promise.resolve({ id }) });
const req = (body: unknown = {}) => new NextRequest("http://localhost/api/v1/channel-sessions/" + canal + "/acervo", { method: "PATCH", body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadAuthUser).mockResolvedValue(null);
  for (const k of Object.keys(filters)) delete filters[k];
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: org }, org: { orgId: org, role: "admin" } } as Awaited<ReturnType<typeof requireRole>>);
  const bate = () => Object.entries(filters).every(([k, v]) => row[k as keyof typeof row] === v);
  const query = {
    select: () => query,
    update: (patch: unknown) => { update(patch); return query; },
    eq: (k: string, v: unknown) => { filters[k] = v; return query; },
    is: (k: string, v: unknown) => { filters[k] = v; return query; },
    maybeSingle: async () => ({ data: bate() ? row : null, error: null }),
  };
  vi.mocked(createAdminClient).mockReturnValue({ from: () => query } as unknown as ReturnType<typeof createAdminClient>);
});

describe("a opção de acervo por conexão (#999)", () => {
  it("exige admin para ler e para escrever, sem tocar no banco se negado", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: fail("forbidden", "Acesso negado.", 403) });
    expect((await GET(req(), context())).status).toBe(403);
    expect((await PATCH(req({ guardar_historico: true }), context())).status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("admin", expect.objectContaining({ allowPlatformAdmin: true }));
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("canal de outra organização responde 404 e não grava nem audita", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: org }, org: { orgId: canal, role: "admin" } } as Awaited<ReturnType<typeof requireRole>>);
    expect((await GET(req(), context())).status).toBe(404);
    expect((await PATCH(req({ guardar_historico: true }), context())).status).toBe(404);
    expect(update).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("corpo ou id inválido responde 422 sem gravar", async () => {
    for (const body of [{}, { guardar_historico: "sim" }, { guardar_historico: null }]) {
      expect((await PATCH(req(body), context())).status).toBe(422);
    }
    expect((await PATCH(req({ guardar_historico: true }), context("nao-e-uuid"))).status).toBe(422);
    expect(update).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("grava a chave preservando o resto do metadata, com escopo de org, e audita", async () => {
    const response = await PATCH(req({ guardar_historico: true, organization_id: canal }), context());
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ guardar_historico: true, aplicado: false });
    expect(update).toHaveBeenCalledWith({ metadata: { ai_gate: "allowlist", guardar_historico: true } });
    expect(filters).toMatchObject({ organization_id: org, id: canal, archived_at: null });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "channel.acervo_updated", organizationId: org, resourceId: canal,
      metadata: { guardar_historico: true, aplicado: false },
    }));
  });
});
