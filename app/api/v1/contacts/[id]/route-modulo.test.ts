/**
 * Token de módulo SEM `MODULE_JWT_PRIVATE_KEY` (Spec 33, F3 — issue #5085).
 *
 * A F2 emite o token do módulo como `viewer` (`mcp:read`, `role:viewer`, `actor:module:…`) e o papel
 * efetivo sem JWT de contexto é `min(papel do token, teto agent)`. Como o papel do token é `viewer`,
 * o módulo efetivo é `viewer`: a ficha (`GET /api/v1/contacts/[id]`), que cobra `agent` do token,
 * responde 403 `forbidden_role`; a leitura que cobra `viewer` (a timeline da mesma ficha) responde
 * 200. É o comportamento que a doc passou a declarar — não o teto `agent` que ela prometia.
 *
 * ─── SABOTAGEM (o que faz este arquivo ficar vermelho) ─────────────────────
 * - Trocar o papel do token de `role:viewer` para `role:agent` em `tokenDoModulo()`: o papel efetivo
 *   sem pessoa vira `agent`, a ficha deixa de recusar e o caso "403 forbidden_role" cai.
 * - Esvaziar a asserção do 403 (ou inverter para `toBe(200)`): cai do mesmo jeito.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getContactHandler } from "../_handler";

vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: vi.fn(async () => null),
  supportCallbackWriteAllowed: vi.fn(async () => true),
}));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(),
  orgAtivaDaApi: vi.fn(),
}));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("../_handler", () => ({
  getContactHandler: vi.fn(),
  patchContactHandler: vi.fn(),
  deleteContactHandler: vi.fn(),
}));

/**
 * Banco falso: serve o portão do módulo (token, instalação e vínculo com a organização) e as
 * leituras da timeline (contato, leads e atividades). `maybeSingle` devolve a linha da tabela e a
 * corrente é "aguardável" (`then`) para as consultas que terminam em `await …eq()`.
 */
const banco = vi.hoisted(() => ({
  linhas: {} as Record<string, Record<string, unknown> | null>,
  ORG: "22222222-2222-4222-8222-222222222222",
  CONTATO: "44444444-4444-4444-8444-444444444444",
}));
const ORG = banco.ORG;
const CONTATO = banco.CONTATO;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from(tabela: string) {
      const q: Record<string, unknown> = {};
      const resposta = () => {
        if (tabela === "contacts") {
          return { data: { id: "44444444-4444-4444-8444-444444444444", organization_id: ORG }, error: null };
        }
        if (tabela === "crm_leads" || tabela === "crm_lead_activities") {
          return { data: [], error: null };
        }
        return { data: banco.linhas[tabela] ?? null, error: null };
      };
      q.select = () => q;
      q.eq = () => q;
      q.in = () => q;
      q.order = () => q;
      q.limit = () => q;
      q.or = () => q;
      q.is = () => q;
      q.maybeSingle = async () => resposta();
      q.then = (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
        Promise.resolve(resposta()).then(ok, err);
      return q;
    },
  })),
}));

vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});
const { validateBearerToken } = await import("@/lib/mcp/auth");

const TOKEN = "aaaaaaaa-1111-4111-8111-111111111111";
const INST = "cccccccc-3333-4333-8333-333333333333";

/** O token como a F2 o emite: sem papel acima de `viewer`, sem JWT de contexto (sem a chave). */
function tokenDoModulo() {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: ORG,
    role: "viewer",
    actor: { type: "module", id: TOKEN, slug: "acme/comanda" },
    apiTokenId: TOKEN,
    scopes: ["mcp:read", "role:viewer", "actor:module:acme/comanda"],
  });
}

/** Pacote `connected` que DECLAROU e a organização CONSENTIU `area.contatos.leitura`. */
function pacoteConsentido() {
  banco.linhas = {
    api_tokens: { extension_installation_id: INST, module_slug: "acme/comanda", revoked_at: null },
    extension_installations: {
      publisher: "acme",
      name: "comanda",
      disabled_at: null,
      removed_at: null,
      extension_artifacts: {
        manifest: {
          profile: "connected",
          host_api: { min: 2, max: 2 },
          permissions: ["area.contatos.leitura"],
        },
      },
    },
    organization_extensions: { enabled: true, consented_areas: ["area.contatos.leitura"] },
  };
}

function reqGet(caminho: string) {
  return new NextRequest(`http://localhost${caminho}`, {
    headers: { authorization: "Bearer dsk_abc_def" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  pacoteConsentido();
  tokenDoModulo();
});

describe("token de módulo sem JWT de contexto — papel efetivo viewer", () => {
  it("GET /api/v1/contacts/[id] cobra agent do token: 403 forbidden_role, sem tocar o handler", async () => {
    const { GET } = await import("./route");
    const res = await GET(reqGet(`/api/v1/contacts/${CONTATO}`), {
      params: Promise.resolve({ id: CONTATO }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("forbidden_role");
    expect(body.error.message).toContain("'viewer'");
    expect(body.error.message).toContain("'agent'");
    expect(getContactHandler).not.toHaveBeenCalled();
  });

  it("GET /api/v1/contacts/[id]/timeline cobra só viewer: 200 com a área consentida", async () => {
    const { GET } = await import("./timeline/route");
    const res = await GET(reqGet(`/api/v1/contacts/${CONTATO}/timeline`), {
      params: Promise.resolve({ id: CONTATO }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; meta: { has_more: boolean } };
    expect(body.data).toEqual([]);
    expect(body.meta.has_more).toBe(false);
  });
});
