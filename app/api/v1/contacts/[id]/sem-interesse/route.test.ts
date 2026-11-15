import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { loadAuthUser } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { desfazerSemInteresse, registrarSemInteresse } from "@/lib/lgpd/registrar-sem-interesse";

import { DELETE, POST } from "./route";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/lgpd/registrar-sem-interesse", () => ({
  registrarSemInteresse: vi.fn(),
  desfazerSemInteresse: vi.fn(),
}));

/**
 * "Não tem interesse" pela ficha (decisão D3). A regra e os efeitos são de
 * `lib/lgpd/registrar-sem-interesse.ts` (medidos em
 * `tests/unit/sem-interesse-so-na-conversa-de-prospeccao.test.ts`); aqui se prova a porta:
 * quem pode, de que organização, e o que cada desfecho responde.
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * - Trocar "admin" por "agent" no DELETE: o caso do desfazer acusa.
 * - Ler a organização do corpo: o caso "organização da sessão" acusa.
 */
const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const USUARIO = "44444444-4444-4444-8444-444444444444";

const contexto = (id = CONTATO) => ({ params: Promise.resolve({ id }) });
const req = (method: "POST" | "DELETE", body?: unknown) =>
  new NextRequest(`http://localhost/api/v1/contacts/${CONTATO}/sem-interesse`, {
    method,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadAuthUser).mockResolvedValue(null);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USUARIO, idioma: "pt-BR" },
    org: { orgId: ORG, role: "agent" },
  } as Awaited<ReturnType<typeof requireRole>>);
  vi.mocked(registrarSemInteresse).mockResolvedValue({ gravado: true, negociosFechados: 1, followupsEncerrados: 0 });
  vi.mocked(desfazerSemInteresse).mockResolvedValue({ desfeito: true });
});

describe("POST — marcar sem interesse", () => {
  it("atendente marca, com a organização da SESSÃO (nunca do corpo)", async () => {
    const r = await POST(req("POST", { organization_id: "99999999-9999-4999-8999-999999999999" }), contexto());
    expect(r.status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith("agent", expect.objectContaining({ resource: "contacts" }));
    expect(registrarSemInteresse).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG,
        contactId: CONTATO,
        origem: "ficha",
        actor: { type: "user", id: USUARIO },
      }),
    );
    expect(await r.json()).toMatchObject({ data: { gravado: true, negocios_fechados: 1 } });
  });

  it("sem papel, 403 sem gravar nada", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: fail("forbidden", "Acesso negado.", 403) });
    expect((await POST(req("POST"), contexto())).status).toBe(403);
    expect(registrarSemInteresse).not.toHaveBeenCalled();
  });

  it("suporte só-leitura nega antes de qualquer efeito", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue({
      id: USUARIO,
      is_platform_admin: true,
      support: { organization_id: ORG, status: "active", access_mode: "support_readonly" },
    } as Awaited<ReturnType<typeof loadAuthUser>>);
    expect((await POST(req("POST"), contexto())).status).toBe(403);
    expect((await DELETE(req("DELETE"), contexto())).status).toBe(403);
    expect(registrarSemInteresse).not.toHaveBeenCalled();
    expect(desfazerSemInteresse).not.toHaveBeenCalled();
  });

  it("id fora do formato morre em 422", async () => {
    expect((await POST(req("POST"), contexto("nao-e-uuid"))).status).toBe(422);
    expect(registrarSemInteresse).not.toHaveBeenCalled();
  });

  it.each([
    ["nao_encontrado", 404],
    ["anonimizado", 403],
    ["erro", 500],
  ] as const)("desfecho %s → %i", async (motivo, status) => {
    vi.mocked(registrarSemInteresse).mockResolvedValue({ gravado: false, motivo });
    expect((await POST(req("POST"), contexto())).status).toBe(status);
  });

  it("recusa que já existe responde 200 sem gravar outra (idempotente)", async () => {
    vi.mocked(registrarSemInteresse).mockResolvedValue({ gravado: false, motivo: "ja_recusado", negociosFechados: 0, followupsEncerrados: 0 });
    const r = await POST(req("POST"), contexto());
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ data: { gravado: false } });
  });
});

describe("DELETE — desfazer a recusa (aba LGPD)", () => {
  it("só administrador desfaz", async () => {
    const r = await DELETE(req("DELETE"), contexto());
    expect(r.status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith("admin", expect.objectContaining({ resource: "contacts" }));
    expect(desfazerSemInteresse).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: ORG, contactId: CONTATO }),
    );
  });

  it("sem recusa para desfazer, 200 sem efeito; contato de fora, 404", async () => {
    vi.mocked(desfazerSemInteresse).mockResolvedValue({ desfeito: false, motivo: "sem_recusa" });
    expect((await DELETE(req("DELETE"), contexto())).status).toBe(200);
    vi.mocked(desfazerSemInteresse).mockResolvedValue({ desfeito: false, motivo: "nao_encontrado" });
    expect((await DELETE(req("DELETE"), contexto())).status).toBe(404);
  });
});
