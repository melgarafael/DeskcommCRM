/**
 * A PÁGINA DA FONTE DO LEAD ADS É A QUE O TOKEN LÊ, E SÓ QUEM ADMINISTRA A TROCA
 * (issue #3768, doc 300).
 *
 * O lead do formulário da Meta é roteado pela página (`webhooks/meta-lead-ads`).
 * Então a página gravada na fonte decide para qual empresa o lead vai, e ela só
 * pode ser gravada conferida pelo token daquela página (`GET /me`). Os casos:
 *  - quem não é admin não troca a página (o portão é o mesmo do token);
 *  - página digitada que o token não lê é recusada, e nada é gravado;
 *  - token novo com a página em branco grava a página que o token lê;
 *  - página sem token não se grava.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  papel: "admin" as "manager" | "admin",
  fonte: null as Record<string, unknown> | null,
  update: vi.fn(),
  paginaDoToken: vi.fn(),
  decifrar: vi.fn(),
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => {
  const RANK = { viewer: 1, agent: 2, manager: 3, admin: 4 } as const;
  return {
    requireRole: async (minimo: keyof typeof RANK) =>
      RANK[h.papel] >= RANK[minimo]
        ? { ok: true, user: { id: "user-1", idioma: "pt" }, org: { orgId: "org-1", role: h.papel } }
        : { ok: false, response: new Response(null, { status: 403 }) },
  };
});
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => cliente("servidor") }));
vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: async () => "\\x0cifrado",
  decryptWebhookSecret: h.decifrar,
}));
vi.mock("@/lib/leads/lead-ads/respostas-na-meta", () => ({ paginaDoToken: h.paginaDoToken }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => cliente("sessao") }));

/** O mesmo banco falso para os dois clientes; `h.update` diz QUEM escreveu. */
function cliente(quem: "sessao" | "servidor") {
  let gravado: Record<string, unknown> = {};
  const cadeia: Record<string, unknown> = {
    select: () => cadeia,
    eq: () => cadeia,
    update: (patch: Record<string, unknown>) => {
      h.update(patch, quem);
      gravado = patch;
      return cadeia;
    },
    maybeSingle: async () => ({ data: h.fonte, error: null }),
    single: async () => ({ data: { ...h.fonte, ...gravado }, error: null }),
  };
  return { from: () => cadeia };
}

import { PATCH } from "@/app/api/v1/webhook-sources/[id]/route";

const TOKEN = "EAAB".padEnd(64, "x");
const PAGINA = "1029384756";

function patch(corpo: Record<string, unknown>) {
  const req = new NextRequest("http://localhost/api/v1/webhook-sources/fonte-1", {
    method: "PATCH",
    body: JSON.stringify(corpo),
  });
  return PATCH(req, { params: Promise.resolve({ id: "fonte-1" }) });
}

beforeEach(() => {
  h.papel = "admin";
  h.update.mockReset();
  h.paginaDoToken.mockReset();
  h.decifrar.mockReset();
  h.fonte = {
    id: "fonte-1",
    authorize_ai_on_capture: false,
    update_existing_lead_on_capture: false,
    reuse_open_lead_on_capture: false,
    secret_encrypted: null,
    meta_page_id: null,
    meta_page_token_encrypted: null,
    meta_lead_retrieval: false,
  };
});

describe("a página da fonte do Lead Ads", () => {
  it("quem não é admin não troca a página — nem sem tocar no token", async () => {
    h.papel = "manager";
    const res = await patch({ meta_page_id: PAGINA });
    expect(res.status).toBe(403);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("o manager segue editando o resto da fonte", async () => {
    h.papel = "manager";
    const res = await patch({ name: "Landing" });
    expect(res.status).toBe(200);
    expect(h.update.mock.calls[0]![1]).toBe("sessao");
  });

  it("página que o token NÃO lê é recusada, e nada é gravado", async () => {
    h.paginaDoToken.mockResolvedValue({ ok: true, pageId: "5555555555" });
    const res = await patch({ meta_page_id: PAGINA, meta_page_token: TOKEN });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("page_mismatch");
    expect(h.update).not.toHaveBeenCalled();
  });

  it("token novo com a página em branco grava a página que o token lê", async () => {
    h.paginaDoToken.mockResolvedValue({ ok: true, pageId: PAGINA });
    const res = await patch({ meta_page_id: null, meta_page_token: TOKEN });
    expect(res.status).toBe(200);
    expect(h.paginaDoToken).toHaveBeenCalledWith(TOKEN);
    expect(h.update.mock.calls[0]![0]).toMatchObject({ meta_page_id: PAGINA });
    // Pela sessão o gatilho da 9320 recusaria: quem grava é o cliente do servidor.
    expect(h.update.mock.calls[0]![1]).toBe("servidor");
    const json = (await res.json()) as { data: Record<string, unknown> };
    expect(json.data.meta_page_id).toBe(PAGINA);
    expect(json.data.has_meta_page_token).toBe(true);
    expect(json.data).not.toHaveProperty("meta_page_token_encrypted");
  });

  it("página sem token gravado não se grava", async () => {
    const res = await patch({ meta_page_id: PAGINA });
    expect(res.status).toBe(422);
    expect(h.paginaDoToken).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it("trocar só a página confere contra o token JÁ gravado", async () => {
    h.fonte = { ...h.fonte, meta_page_token_encrypted: "\\x0cifrado" };
    h.decifrar.mockResolvedValue(TOKEN);
    h.paginaDoToken.mockResolvedValue({ ok: true, pageId: "5555555555" });
    const res = await patch({ meta_page_id: PAGINA });
    expect(res.status).toBe(422);
    expect(h.paginaDoToken).toHaveBeenCalledWith(TOKEN);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("token que a Meta não confirma é recusado", async () => {
    h.paginaDoToken.mockResolvedValue({ ok: false, motivo: "recusada_pela_meta", detalhe: "http_400" });
    const res = await patch({ meta_page_token: TOKEN });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("page_token_unverified");
    expect(h.update).not.toHaveBeenCalled();
  });

  it("remover o token deixando a página é recusado; remover os dois passa", async () => {
    h.fonte = { ...h.fonte, meta_page_id: PAGINA, meta_page_token_encrypted: "\\x0cifrado" };
    expect((await patch({ meta_page_token: null })).status).toBe(422);
    const res = await patch({ meta_page_token: null, meta_page_id: null, meta_lead_retrieval: false });
    expect(res.status).toBe(200);
    expect(h.update.mock.calls[0]![0]).toMatchObject({ meta_page_id: null, meta_page_token_encrypted: null });
  });
});
