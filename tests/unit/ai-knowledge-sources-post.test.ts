/**
 * POST /api/v1/ai/knowledge/sources — o que a rota responde quando o banco
 * recusa, e o que ela faz com conteúdo que não sabe ingerir (issue #265).
 *
 * A colisão do índice único saía como `500 internal_error` — quem reportou a
 * issue não tinha como descobrir que o motivo era o material que já existia. E
 * `items`/`markdown_blob` mandados para um tipo preenchido por rotina eram
 * ACEITOS e descartados em silêncio, criando material vazio com 201.
 *
 * ## O que mudou na 0181 (e o que NÃO mudou)
 *
 * O índice que colide passou a ser por NOME
 * (`ai_knowledge_sources_nome_unico_por_org`) e não mais por
 * `(agent_id, source_type)`: o acervo é da organização, e ela pode ter cinco
 * FAQs — o que ela não pode é ter duas com o mesmo nome, porque o nome é como a
 * pessoa as distingue na tela e no seletor do assistente.
 *
 * O tipo passa a ser CANONIZADO na borda: os nomes legados (`policy`,
 * `catalog`, `conversations`) continuam aceitos de quem integrou por API e
 * chegam ao banco como `documento`, `catalogo`, `conversas`. **A invariante da
 * issue #265 sobrevive inteira**: o tipo que a pessoa pediu é o tipo que é
 * gravado — um pedido de catálogo NUNCA vira `faq`, que era o defeito.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const KS_ID = "33333333-3333-4333-8333-333333333333";

const MARKDOWN = "## Pergunta: Qual o prazo?\n## Resposta: Dois dias.";

interface ErroDoBanco {
  code?: string;
  message: string;
}

/** Sessão manager válida — o gate de role não é o assunto deste arquivo. */
function sessaoOk(): void {
  const user = { id: "user-1", email: "u@example.com" } as unknown as AuthUser;
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role: "manager" },
  });
}

/**
 * Dubla os dois clients. `erroDoInsert` só afeta a escrita em
 * `ai_knowledge_sources` — é onde a colisão do índice acontece.
 */
function dublarBanco(opts: { agenteExiste?: boolean; erroDoInsert?: ErroDoBanco | null } = {}) {
  const { agenteExiste = true, erroDoInsert = null } = opts;

  const cadeiaDeLeitura = {
    select: () => cadeiaDeLeitura,
    eq: () => cadeiaDeLeitura,
    maybeSingle: async () => ({ data: agenteExiste ? { id: AGENT_ID } : null, error: null }),
  };
  vi.mocked(createClient).mockResolvedValue({
    from: () => cadeiaDeLeitura,
  } as unknown as Awaited<ReturnType<typeof createClient>>);

  const escritas: Array<{ tabela: string; linhas: unknown }> = [];
  const admin = {
    from: (tabela: string) => ({
      insert: (linhas: unknown) => {
        escritas.push({ tabela, linhas });
        const erro = tabela === "ai_knowledge_sources" ? erroDoInsert : null;
        const resultado = { data: erro ? null : { id: KS_ID }, error: erro };
        return {
          select: () => ({ single: async () => resultado }),
          // `ai_faq_items` é aguardado direto, sem `.select()`.
          then: (f: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(f),
        };
      },
    }),
    rpc: async () => ({ error: null }),
  };
  vi.mocked(createAdminClient).mockReturnValue(admin as unknown as ReturnType<typeof createAdminClient>);

  return { escritas };
}

function req(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/v1/ai/knowledge/sources", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/ai/knowledge/sources — colisão do índice único", () => {
  it("23505 vira 409 knowledge_source_name_in_use, em português e sem texto do Postgres", async () => {
    sessaoOk();
    dublarBanco({
      erroDoInsert: {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "ai_knowledge_sources_nome_unico_por_org"',
      },
    });
    const { POST } = await import("@/app/api/v1/ai/knowledge/sources/route");
    const res = await POST(
      req({ agent_id: AGENT_ID, source_type: "faq", name: "FAQ da loja", markdown_blob: MARKDOWN }),
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("knowledge_source_name_in_use");
    expect(body.error.message).toContain("FAQ da loja");
    // Sem esta metade, um 500 devolvendo a mensagem crua do Postgres também
    // citaria o nome e passaria.
    expect(body.error.message).not.toContain("unique");
    expect(body.error.message).not.toContain("constraint");
    expect(body.error.message).not.toContain("duplicate");
  });

  it("outro erro do banco continua 500 — a tradução é só do conflito", async () => {
    sessaoOk();
    dublarBanco({ erroDoInsert: { code: "08006", message: "connection failure" } });
    const erroDoConsole = vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await import("@/app/api/v1/ai/knowledge/sources/route");
    const res = await POST(
      req({ agent_id: AGENT_ID, source_type: "faq", name: "FAQ da loja", markdown_blob: MARKDOWN }),
    );
    erroDoConsole.mockRestore();

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("internal_error");
  });
});

describe("POST /api/v1/ai/knowledge/sources — tipo pedido é o tipo gravado", () => {
  it("grava o tipo PEDIDO (canonizado), nunca outro", async () => {
    sessaoOk();
    const { escritas } = dublarBanco();
    const { POST } = await import("@/app/api/v1/ai/knowledge/sources/route");
    const res = await POST(
      req({ agent_id: AGENT_ID, source_type: "faq", name: "FAQ da loja", markdown_blob: MARKDOWN }),
    );

    expect(res.status).toBe(201);
    expect(escritas[0]).toMatchObject({
      tabela: "ai_knowledge_sources",
      linhas: { source_type: "faq", organization_id: ORG_ID, agent_id: AGENT_ID },
    });
    expect(escritas[1]?.tabela).toBe("ai_faq_items");
  });

  it("nome legado é traduzido, e não silenciosamente trocado por outro tipo", async () => {
    sessaoOk();
    const { escritas } = dublarBanco();
    const { POST } = await import("@/app/api/v1/ai/knowledge/sources/route");
    const res = await POST(
      req({ agent_id: AGENT_ID, source_type: "conversations", name: "Conversas" }),
    );

    expect(res.status).toBe(201);
    // `conversations` → `conversas`. O que NÃO pode acontecer é virar `faq`,
    // que é o defeito da #265 e o motivo deste arquivo existir.
    expect(escritas[0]).toMatchObject({ linhas: { source_type: "conversas" } });
  });

  it("tipo desconhecido é RECUSADO com a lista do que existe, não convertido", async () => {
    sessaoOk();
    const { escritas } = dublarBanco();
    const { POST } = await import("@/app/api/v1/ai/knowledge/sources/route");
    const res = await POST(req({ source_type: "planilha", name: "Tabela de preços" }));

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("faq");
    expect(escritas).toHaveLength(0);
  });

  it("tipo sem ingestão de texto + conteúdo colado → 422, e NADA é gravado", async () => {
    sessaoOk();
    const { escritas } = dublarBanco();
    const { POST } = await import("@/app/api/v1/ai/knowledge/sources/route");
    const res = await POST(
      req({ agent_id: AGENT_ID, source_type: "catalog", name: "Catálogo", markdown_blob: MARKDOWN }),
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("unprocessable_entity");
    expect(body.error.message.toLowerCase()).toContain("catálogo");
    // O defeito antigo era 201 com fonte vazia: recusar sem gravar é o ponto.
    expect(escritas).toHaveLength(0);
  });

  it("tipo sem ingestão de texto e SEM conteúdo continua podendo ser criado", async () => {
    sessaoOk();
    const { escritas } = dublarBanco();
    const { POST } = await import("@/app/api/v1/ai/knowledge/sources/route");
    const res = await POST(req({ agent_id: AGENT_ID, source_type: "catalog", name: "Catálogo" }));

    expect(res.status).toBe(201);
    expect(escritas[0]).toMatchObject({ linhas: { source_type: "catalogo" } });
  });
});
