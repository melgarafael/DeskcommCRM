// @vitest-environment node
/**
 * TIRAR DO ARQUIVO — `PATCH /api/v1/ai/knowledge/sources/[id]` com `{ status: 'active' }`.
 *
 * Arquivar era um caminho só de ida: o DELETE grava `status='archived'` +
 * `is_active=false` e nenhuma rota devolvia o material. Quem arquivava por
 * engano recriava tudo à mão — e o nome nem sempre estava livre, porque o
 * índice único `ai_knowledge_sources_nome_unico_por_org` (organization_id,
 * lower(btrim(name))) WHERE is_active só enxerga material ATIVO.
 *
 * O que este arquivo prova, e por quê:
 *
 *  - `is_active` volta JUNTO com `status`. Não é simetria: o rag-indexer pula a
 *    fonte com `!is_active || status === 'archived'` (workers/rag-indexer.ts:707).
 *    Um material "de volta" na tela e invisível para o agente é pior que o
 *    arquivo, porque some sem aviso — a sabotagem que apaga `is_active` do
 *    update deixa este teste vermelho.
 *  - o evento `knowledge_source.updated` é emitido: sem ele o worker não
 *    reindexa, e o material volta apontando para um índice velho (ou nenhum).
 *  - a colisão de nome responde 409 com o nome do conflito, não 500, e NÃO
 *    grava nada — nem linha, nem evento, nem trilha.
 *  - material de outra empresa é 404 (o escopo vem da sessão, nunca do path) e
 *    papel abaixo de manager é 403.
 */
import { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const FONTE_ID = "66666666-6666-4666-8666-666666666666";
const NOME = "FAQ da loja";

type Linha = {
  id: string;
  source_type: string;
  agent_id: string | null;
  name: string;
  status: string;
  is_active: boolean;
};

const estado = vi.hoisted(() => ({
  /** A linha que o cliente user-scoped (RLS) devolve. `null` = outra empresa. */
  fonte: null as null | {
    id: string;
    source_type: string;
    agent_id: string | null;
    name: string;
    status: string;
    is_active: boolean;
  },
  /** `false` = sessão com papel abaixo de manager. */
  papelOk: true,
  /** Erro que o `update` do admin devolve (ex.: 23505 do índice de nome). */
  erroNoUpdate: null as null | { code: string; message: string },
  /** O que o banco de mentira REALMENTE gravou — update recusado não grava. */
  gravadas: [] as Array<{ tabela: string; dados: Record<string, unknown> }>,
  eventos: [] as Array<Record<string, unknown>>,
  auditorias: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () =>
    estado.papelOk
      ? {
          ok: true,
          user: { id: "u-1", idioma: "pt-BR" },
          org: { orgId: ORG_ID, role: "manager" },
        }
      : {
          ok: false,
          response: NextResponse.json(
            { error: { code: "forbidden_role", message: "Você não tem permissão para esta ação." } },
            { status: 403 },
          ),
        },
  ),
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (entrada: Record<string, unknown>) => {
    estado.auditorias.push(entrada);
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.maybeSingle = async () => ({ data: estado.fonte, error: null });
    return { from: () => b };
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const q: Record<string, unknown> = {};
      q.eq = () => q;
      q.update = (dados: Record<string, unknown>) => {
        q.dados = dados;
        return q;
      };
      // Thenable: o `.update(...).eq(...).eq(...)` é awaited. Grava só quando o
      // banco aceita — é assim que "409 sem escrita" fica observável.
      q.then = (ok: (v: unknown) => unknown) => {
        if (q.dados && !estado.erroNoUpdate) {
          estado.gravadas.push({ tabela, dados: q.dados as Record<string, unknown> });
        }
        return Promise.resolve({ error: estado.erroNoUpdate }).then(ok);
      };
      return q;
    },
    rpc: async (nome: string, args: Record<string, unknown>) => {
      estado.eventos.push({ nome, ...args });
      return { error: null };
    },
  }),
}));

import { PATCH } from "./route";

function patch(corpo: unknown) {
  return PATCH(
    new NextRequest(`http://localhost/api/v1/ai/knowledge/sources/${FONTE_ID}`, {
      method: "PATCH",
      body: JSON.stringify(corpo),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id: FONTE_ID }) },
  );
}

const ARQUIVADA: Linha = {
  id: FONTE_ID,
  source_type: "faq",
  agent_id: null,
  name: NOME,
  status: "archived",
  is_active: false,
};

/**
 * O que "de volta ao acervo" significa para quem consome a linha.
 *
 * A régua é a do rag-indexer (`workers/rag-indexer.ts:707`): `status` tem de
 * ser `active` E `is_active` tem de ser `true`. Só um dos dois passa na tela e
 * não passa no agente.
 */
function devolveAConsulta(dados: Record<string, unknown>): boolean {
  return dados.status === "active" && dados.is_active === true;
}

beforeEach(() => {
  estado.fonte = { ...ARQUIVADA };
  estado.papelOk = true;
  estado.erroNoUpdate = null;
  estado.gravadas = [];
  estado.eventos = [];
  estado.auditorias = [];
});

describe("PATCH { status: 'active' } — tirar do arquivo", () => {
  it("restauração feliz: status e is_active voltam, evento emitido, trilha de/para gravada", async () => {
    const res = await patch({ status: "active" });

    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ id: FONTE_ID, status: "active", restored: true });

    // `gravadas` é o que o "banco" aceitou, não o que a rota pediu.
    expect(estado.gravadas).toHaveLength(1);
    const gravada = estado.gravadas[0]!;
    expect(gravada.tabela).toBe("ai_knowledge_sources");
    expect(devolveAConsulta(gravada.dados)).toBe(true);

    // Sem o evento o worker não reindexa: o material volta apontando para um
    // índice velho, ou para nenhum.
    expect(estado.eventos).toHaveLength(1);
    expect(estado.eventos[0]).toMatchObject({
      nome: "emit_event",
      p_event_type: "knowledge_source.updated",
      p_entity_kind: "ai_knowledge_source",
      p_entity_id: FONTE_ID,
      p_organization_id: ORG_ID,
      p_payload: { knowledge_source_id: FONTE_ID, source_type: "faq", triggered_by: "restored" },
    });

    // De/para: "quem tirou do arquivo" não se responde com a linha atual.
    expect(estado.auditorias).toHaveLength(1);
    expect(estado.auditorias[0]).toMatchObject({
      action: "ai.knowledge_source_restored",
      actorUserId: "u-1",
      organizationId: ORG_ID,
      resourceType: "ai_knowledge_source",
      resourceId: FONTE_ID,
      metadata: {
        source_type: "faq",
        de: { status: "archived", is_active: false },
        para: { status: "active", is_active: true },
      },
    });
  });

  it("nome já ocupado por outro material ativo: 409 com o conflito, e nada é escrito", async () => {
    estado.erroNoUpdate = {
      code: "23505",
      message:
        'duplicate key value violates unique constraint "ai_knowledge_sources_nome_unico_por_org"',
    };

    const res = await patch({ status: "active" });

    expect(res.status).toBe(409);
    const corpo = (await res.json()) as { error: { code: string; message: string } };
    expect(corpo.error.code).toBe("knowledge_source_name_in_use");
    // A mensagem diz QUAL é o conflito e o que fazer — 500 não diria nada disso.
    expect(corpo.error.message).toContain(NOME);
    expect(corpo.error.message).toContain("existe um material ativo");

    expect(estado.gravadas).toEqual([]);
    expect(estado.eventos).toEqual([]);
    expect(estado.auditorias).toEqual([]);
  });

  it("material de outra empresa: 404 (o escopo vem da sessão) e nada é escrito", async () => {
    // A RLS devolve `null` porque o `eq("organization_id", orgDaSessao)` não
    // casa: o id existe, mas na organização do vizinho.
    estado.fonte = null;

    const res = await patch({ status: "active" });

    expect(res.status).toBe(404);
    expect(estado.gravadas).toEqual([]);
    expect(estado.eventos).toEqual([]);
    expect(estado.auditorias).toEqual([]);
  });

  it("papel abaixo de manager: 403 sem tocar no material", async () => {
    estado.papelOk = false;

    const res = await patch({ status: "active" });

    expect(res.status).toBe(403);
    expect(estado.gravadas).toEqual([]);
    expect(estado.eventos).toEqual([]);
    expect(estado.auditorias).toEqual([]);
  });

  it("material que já está no acervo: nada a escrever, nada a auditar", async () => {
    estado.fonte = { ...ARQUIVADA, status: "ready", is_active: true };

    const res = await patch({ status: "active" });

    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ status: "active", restored: false });
    expect(estado.gravadas).toEqual([]);
    expect(estado.eventos).toEqual([]);
    expect(estado.auditorias).toEqual([]);
  });

  it("corpo misto ({ status, name }): 422 antes de qualquer escrita", async () => {
    const res = await patch({ status: "active", name: "Outro nome" });

    expect(res.status).toBe(422);
    expect(estado.gravadas).toEqual([]);
    expect(estado.auditorias).toEqual([]);
  });
});
