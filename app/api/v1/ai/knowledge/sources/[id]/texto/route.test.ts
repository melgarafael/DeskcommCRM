/**
 * PUT /api/v1/ai/knowledge/sources/[id]/texto — editar o texto de um material
 * criado a partir de TEXTO COLADO (#4596).
 *
 * Antes, só FAQ tinha "Editar conteúdo". Um documento colado só podia ser
 * apagado e criado de novo. A rota regrava o `.md` guardado e reindexa pelo
 * mesmo `emit_event` da criação. O que ela NÃO pode fazer: tocar em FAQ, em
 * arquivo enviado (PDF etc.), em material automático ou em arquivo de outra
 * organização.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const FONTE_ID = "66666666-6666-4666-8666-666666666666";
const BLOB = `${ORG_ID}/abc.md`;

type Fonte = {
  id: string;
  source_type: string;
  agent_id: string | null;
  status: string;
  is_active: boolean;
  source_metadata: Record<string, unknown> | null;
} | null;

const estado = vi.hoisted(() => ({
  fonte: null as unknown,
  filtros: [] as Array<[string, unknown]>,
  uploads: [] as Array<{ bucket: string; caminho: string; corpo: string; opcoes: unknown }>,
  escritas: [] as Array<{ tabela: string; operacao: string }>,
  rpcs: [] as Array<{ nome: string; args: Record<string, unknown> }>,
  papel: "" as string,
  uploadFalha: false,
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async (papel: string) => {
    estado.papel = papel;
    return { ok: true, user: { id: "u-1", idioma: "pt-BR" }, org: { orgId: ORG_ID } };
  }),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (col: string, v: unknown) => {
      estado.filtros.push([col, v]);
      return b;
    };
    b.maybeSingle = async () => ({ data: estado.fonte, error: null });
    return { from: () => b };
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const q: Record<string, unknown> = {};
      q.eq = () => q;
      q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(ok);
      for (const op of ["update", "delete", "insert", "upsert"]) {
        q[op] = () => {
          estado.escritas.push({ tabela, operacao: op });
          return q;
        };
      }
      return q;
    },
    storage: {
      from: (bucket: string) => ({
        upload: async (caminho: string, corpo: Buffer, opcoes: unknown) => {
          estado.uploads.push({ bucket, caminho, corpo: corpo.toString("utf8"), opcoes });
          return { error: estado.uploadFalha ? { message: "falhou" } : null };
        },
      }),
    },
    rpc: async (nome: string, args: Record<string, unknown>) => {
      estado.rpcs.push({ nome, args });
      return { error: null };
    },
  }),
}));

import { PUT } from "./route";

function colado(extra: Partial<NonNullable<Fonte>> = {}): Fonte {
  return {
    id: FONTE_ID,
    source_type: "documento",
    agent_id: null,
    status: "ready",
    is_active: true,
    source_metadata: { blob_path: BLOB, ext: "md", origem: "texto_colado" },
    ...extra,
  };
}

function put(corpo: unknown) {
  return PUT(
    new NextRequest(`http://localhost/api/v1/ai/knowledge/sources/${FONTE_ID}/texto`, {
      method: "PUT",
      body: JSON.stringify(corpo),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id: FONTE_ID }) },
  );
}

/** Escritas de material — a trilha de auditoria (`api_audit_log`) fica fora. */
const escritasDeMaterial = () => estado.escritas.filter((e) => e.tabela !== "api_audit_log");

function nadaGravado() {
  expect(estado.uploads).toEqual([]);
  expect(escritasDeMaterial()).toEqual([]);
  expect(estado.rpcs).toEqual([]);
}

beforeEach(() => {
  estado.fonte = colado();
  estado.filtros = [];
  estado.uploads = [];
  estado.escritas = [];
  estado.rpcs = [];
  estado.papel = "";
  estado.uploadFalha = false;
});

describe("PUT /sources/[id]/texto", () => {
  it("documento de texto colado: regrava o .md no mesmo lugar e reindexa", async () => {
    const res = await put({ texto: "# Trocas\nEm até 30 dias." });

    expect(res.status).toBe(200);
    expect(estado.papel).toBe("manager");
    // A organização vem da sessão, nunca do pedido.
    expect(estado.filtros).toContainEqual(["organization_id", ORG_ID]);
    expect(estado.uploads).toEqual([
      {
        bucket: "ai-policy",
        caminho: BLOB,
        corpo: "# Trocas\nEm até 30 dias.",
        opcoes: { contentType: "text/markdown", upsert: true },
      },
    ]);
    // Nenhuma coluna do material muda: o arquivo é a fonte da verdade.
    expect(escritasDeMaterial()).toEqual([]);
    expect(estado.rpcs).toEqual([
      {
        nome: "emit_event",
        args: {
          p_event_type: "knowledge_source.updated",
          p_entity_kind: "ai_knowledge_source",
          p_entity_id: FONTE_ID,
          p_payload: { knowledge_source_id: FONTE_ID, agent_id: null, source_type: "documento" },
          p_organization_id: ORG_ID,
        },
      },
    ]);
  });

  it("aceita o nome legado `policy` do mesmo documento colado", async () => {
    estado.fonte = colado({ source_type: "policy" });
    const res = await put({ texto: "novo" });
    expect(res.status).toBe(200);
    expect(estado.uploads).toHaveLength(1);
  });

  it("arquivo enviado (PDF): recusa 422 e não toca no arquivo", async () => {
    estado.fonte = colado({
      source_metadata: { blob_path: `${ORG_ID}/x.pdf`, ext: "pdf", filename: "manual.pdf" },
    });
    const res = await put({ texto: "sobrescrever o PDF" });
    expect(res.status).toBe(422);
    nadaGravado();
  });

  it("origem forjada num PDF (ext pdf): recusa 422", async () => {
    estado.fonte = colado({
      source_metadata: { blob_path: `${ORG_ID}/x.pdf`, ext: "pdf", origem: "texto_colado" },
    });
    const res = await put({ texto: "x" });
    expect(res.status).toBe(422);
    nadaGravado();
  });

  it("FAQ: recusa 422 — o caminho do FAQ continua sendo o PATCH com items", async () => {
    estado.fonte = colado({ source_type: "faq", source_metadata: {} });
    const res = await put({ texto: "x" });
    expect(res.status).toBe(422);
    nadaGravado();
  });

  it("catálogo: recusa 422", async () => {
    estado.fonte = colado({ source_type: "catalogo", source_metadata: {} });
    const res = await put({ texto: "x" });
    expect(res.status).toBe(422);
    nadaGravado();
  });

  it("blob_path fora da pasta da organização da sessão: recusa e não escreve", async () => {
    estado.fonte = colado({
      source_metadata: { blob_path: `${OUTRA_ORG}/abc.md`, ext: "md", origem: "texto_colado" },
    });
    const res = await put({ texto: "x" });
    expect(res.status).toBe(422);
    nadaGravado();
  });

  it("material arquivado: recusa 409 (o indexador ignora arquivado)", async () => {
    estado.fonte = colado({ status: "archived", is_active: false });
    const res = await put({ texto: "x" });
    expect(res.status).toBe(409);
    nadaGravado();
  });

  it("texto vazio: recusa 422 — salvar vazio apagaria o material", async () => {
    const res = await put({ texto: "   \n " });
    expect(res.status).toBe(422);
    nadaGravado();
  });

  it("material de outra organização / inexistente: 404", async () => {
    estado.fonte = null;
    const res = await put({ texto: "x" });
    expect(res.status).toBe(404);
    nadaGravado();
  });

  it("falha ao gravar o arquivo: 500 e não reindexa", async () => {
    estado.uploadFalha = true;
    const res = await put({ texto: "x" });
    expect(res.status).toBe(500);
    expect(estado.rpcs).toEqual([]);
  });
});
