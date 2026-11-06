// @vitest-environment node
/**
 * AS ROTAS DE MATERIAL DO ACERVO DEIXAM REGISTRO NA AUDITORIA.
 *
 * Toda mutação POST/PATCH/DELETE bem-sucedida gera uma entrada em
 * `api_audit_log` (CLAUDE.md, "Audit log"). As cinco rotas do acervo (criar,
 * enviar arquivo, editar, arquivar, reindexar) não chamavam `audit(...)`:
 * ninguém respondia "quem apagou o FAQ de trocas?". O registro leva só ids e
 * contagens no `metadata`, nunca o texto do material.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const KS_ID = "66666666-6666-4666-8666-666666666666";

const estado = vi.hoisted(() => ({
  fonteExiste: true,
  auditorias: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (entrada: Record<string, unknown>) => {
    estado.auditorias.push(entrada);
  }),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({
  orgAtivaDaApi: vi.fn(),
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: USER_ID, idioma: "pt-BR" },
    org: { orgId: ORG_ID, role: "manager" },
  })),
}));
vi.mock("@/lib/ai/embeddings/chave", () => ({ temChaveDeEmbedding: vi.fn(async () => true) }));
vi.mock("@/lib/ai/rag/ingest/documento", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  extrairTextoDoArquivo: vi.fn(async () => "texto"),
}));

/** Cliente de mentira encadeável: qualquer cadeia termina em `{ id }`, sem erro. */
function cadeia(dados: unknown): unknown {
  const resultado = { data: dados, error: null };
  const proxy: unknown = new Proxy(() => undefined, {
    get: (_alvo, nome) => {
      if (nome === "then") return (ok: (v: unknown) => unknown) => Promise.resolve(resultado).then(ok);
      if (nome === "single" || nome === "maybeSingle") return async () => resultado;
      return () => proxy;
    },
  });
  return proxy;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: () =>
      cadeia(estado.fonteExiste ? { id: KS_ID, source_type: "faq", agent_id: null } : null),
  })),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => cadeia({ id: KS_ID }),
    rpc: async () => ({ error: null }),
    storage: { from: () => ({ upload: async () => ({ error: null }), remove: async () => ({ error: null }) }) },
  }),
}));

import { POST as criar } from "./route";
import { PATCH as editar, DELETE as arquivar } from "./[id]/route";
import { POST as reindexar } from "./[id]/reindex/route";
import { POST as enviarArquivo } from "./upload/route";

const ctxId = { params: Promise.resolve({ id: KS_ID }) };

function json(metodo: string, corpo?: unknown) {
  return new NextRequest(`http://localhost/api/v1/ai/knowledge/sources/${KS_ID}`, {
    method: metodo,
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
}

const TEXTO_SECRETO = "Aceitamos troca em 7 dias com a etiqueta";

function esperaUmRegistro(acao: string) {
  expect(estado.auditorias).toHaveLength(1);
  expect(estado.auditorias[0]).toMatchObject({
    action: acao,
    organizationId: ORG_ID,
    actorUserId: USER_ID,
    resourceType: "ai_knowledge_source",
    resourceId: KS_ID,
  });
  // O texto do material nunca entra no registro (a tabela é append-only).
  expect(JSON.stringify(estado.auditorias[0])).not.toContain(TEXTO_SECRETO);
}

beforeEach(() => {
  estado.fonteExiste = true;
  estado.auditorias = [];
});

describe("auditoria das rotas de material do acervo", () => {
  it("criar: registra ai.knowledge_source_created", async () => {
    const res = await criar(
      new NextRequest("http://localhost/api/v1/ai/knowledge/sources", {
        method: "POST",
        body: JSON.stringify({
          source_type: "faq",
          name: "FAQ de trocas",
          items: [{ question: "Troca?", answer: TEXTO_SECRETO }],
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(201);
    esperaUmRegistro("ai.knowledge_source_created");
  });

  it("criar com corpo inválido (422): não registra", async () => {
    const res = await criar(
      new NextRequest("http://localhost/api/v1/ai/knowledge/sources", {
        method: "POST",
        body: JSON.stringify({ source_type: "faq" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(422);
    expect(estado.auditorias).toEqual([]);
  });

  it("enviar arquivo: registra ai.knowledge_source_created", async () => {
    const form = new FormData();
    form.set("name", "Política de troca");
    form.set("file", new File([TEXTO_SECRETO], "politica.md", { type: "text/markdown" }));
    const res = await enviarArquivo(
      new NextRequest("http://localhost/api/v1/ai/knowledge/sources/upload", { method: "POST", body: form }),
    );
    expect(res.status).toBe(201);
    esperaUmRegistro("ai.knowledge_source_created");
  });

  it("editar: registra ai.knowledge_source_updated", async () => {
    const res = await editar(json("PATCH", { name: "Nome novo" }), ctxId);
    expect(res.status).toBe(200);
    esperaUmRegistro("ai.knowledge_source_updated");
  });

  it("editar material que não existe (404): não registra", async () => {
    estado.fonteExiste = false;
    const res = await editar(json("PATCH", { name: "Nome novo" }), ctxId);
    expect(res.status).toBe(404);
    expect(estado.auditorias).toEqual([]);
  });

  it("arquivar: registra ai.knowledge_source_archived", async () => {
    const res = await arquivar(json("DELETE"), ctxId);
    expect(res.status).toBe(200);
    esperaUmRegistro("ai.knowledge_source_archived");
  });

  it("arquivar material que não existe (404): não registra", async () => {
    estado.fonteExiste = false;
    const res = await arquivar(json("DELETE"), ctxId);
    expect(res.status).toBe(404);
    expect(estado.auditorias).toEqual([]);
  });

  it("reindexar: registra ai.knowledge_source_reindexed", async () => {
    const res = await reindexar(json("POST"), ctxId);
    expect(res.status).toBe(200);
    esperaUmRegistro("ai.knowledge_source_reindexed");
  });
});
