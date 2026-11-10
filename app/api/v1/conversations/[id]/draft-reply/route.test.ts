/**
 * O GET do rascunho de resposta lê as sugestões pelo helper
 * `listarSugestoesDaConversa`, com a organização de quem pediu e a conversa
 * conferida nessa organização. Aqui prova-se a LIGAÇÃO: a rota chama o helper
 * com esses três argumentos e não consulta quando a conversa é de outra org.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({
  requireRole: vi.fn(),
  createClient: vi.fn(),
  pool: vi.fn(),
  listar: vi.fn(),
  maybeSingle: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.requireRole }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/supabase/server", () => ({ createClient: deps.createClient }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: deps.pool }));
vi.mock("@/lib/agent-engine/agent/request-deps", () => ({ requestTurnDeps: () => ({}) }));
vi.mock("@/lib/agent-engine/agent/reply-drafts", () => ({ generateReplyDraft: vi.fn() }));
vi.mock("@/lib/agent-engine/agent/sugestoes-da-conversa", () => ({
  listarSugestoesDaConversa: deps.listar,
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/i18n/dicionario", () => ({ traduzir: (texto: string) => texto }));

import { GET } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "22222222-2222-4222-8222-222222222222";

function req() {
  return new NextRequest(`http://localhost/api/v1/conversations/${CONVERSA}/draft-reply`);
}

function ctx(id = CONVERSA) {
  return { params: Promise.resolve({ id }) };
}

/** O tipo do GET admite `undefined` (o `response` do contexto é opcional); o teste exige resposta. */
async function chamarGet() {
  const res = await GET(req(), ctx());
  if (!res) throw new Error("o GET não devolveu resposta");
  return res;
}

/** Cadeia do Supabase que a rota usa: from().select().eq().eq().maybeSingle(). */
function conversaNoBanco(encontrada: boolean) {
  const eq = vi.fn(() => chain);
  const chain = { select: vi.fn(() => chain), eq, maybeSingle: deps.maybeSingle };
  deps.createClient.mockResolvedValue({ from: vi.fn(() => chain) });
  deps.maybeSingle.mockResolvedValue({
    data: encontrada ? { id: CONVERSA, contact_id: "c1", channel_session_id: "s1" } : null,
    error: null,
  });
  return eq;
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.requireRole.mockResolvedValue({
    ok: true,
    user: { id: "user-1", idioma: "pt-BR" },
    org: { orgId: ORG },
  });
  deps.pool.mockReturnValue({ tag: "pool" });
});

describe("GET /api/v1/conversations/[id]/draft-reply", () => {
  it("devolve as sugestões da conversa lidas com a organização de quem pediu", async () => {
    const eq = conversaNoBanco(true);
    const linhas = [{ id: "d1", status: "failed" }];
    deps.listar.mockResolvedValue(linhas);

    const res = await chamarGet();

    expect(res.status).toBe(200);
    expect(eq).toHaveBeenCalledWith("organization_id", ORG);
    expect(eq).toHaveBeenCalledWith("id", CONVERSA);
    expect(deps.listar).toHaveBeenCalledTimes(1);
    expect(deps.listar).toHaveBeenCalledWith({ tag: "pool" }, ORG, CONVERSA);
    expect(await res.json()).toEqual({ data: { drafts: linhas } });
  });

  it("conversa de outra organização responde 404 e não consulta as sugestões", async () => {
    conversaNoBanco(false);

    const res = await chamarGet();

    expect(res.status).toBe(404);
    expect(deps.listar).not.toHaveBeenCalled();
  });
});
