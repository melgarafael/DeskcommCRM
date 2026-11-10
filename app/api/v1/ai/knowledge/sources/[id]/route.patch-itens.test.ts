/**
 * PATCH /api/v1/ai/knowledge/sources/[id] com `items` num material que não é FAQ.
 *
 * `items` só tem efeito em `faq`. Para `catalogo` e `conversas` a rota já
 * recusa com 422; para `documento` (que aceita texto colado na CRIAÇÃO) ela
 * respondia 200 sem fazer nada. E a recusa vinha DEPOIS do `update` de
 * `name`/`source_metadata`: o 422 deixava o nome novo gravado.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const FONTE_ID = "66666666-6666-4666-8666-666666666666";

const estado = vi.hoisted(() => ({
  tipo: "faq",
  escritas: [] as Array<{ tabela: string; operacao: string; dados?: unknown }>,
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "u-1", idioma: "pt-BR" },
    org: { orgId: ORG_ID },
  })),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.maybeSingle = async () => ({
      data: { id: FONTE_ID, source_type: estado.tipo, agent_id: null },
      error: null,
    });
    return { from: () => b };
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const q: Record<string, unknown> = {};
      q.eq = () => q;
      q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(ok);
      q.update = (dados: unknown) => {
        estado.escritas.push({ tabela, operacao: "update", dados });
        return q;
      };
      q.delete = () => {
        estado.escritas.push({ tabela, operacao: "delete" });
        return q;
      };
      q.insert = (dados: unknown) => {
        estado.escritas.push({ tabela, operacao: "insert", dados });
        return Promise.resolve({ error: null });
      };
      return q;
    },
    rpc: async () => ({ error: null }),
  }),
}));

import { PATCH } from "./route";

const ITENS = [{ question: "Troca?", answer: "Em 7 dias." }];

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

beforeEach(() => {
  estado.tipo = "faq";
  estado.escritas = [];
});

/**
 * As escritas de MATERIAL — `api_audit_log` fora.
 *
 * O `audit` é o de verdade (não mockado) de propósito: assim os casos de recusa
 * provam que NADA foi gravado, nem a linha de auditoria. Aqui, nos controles, o
 * que interessa é a escrita do material.
 */
const escritasDeMaterial = () => estado.escritas.filter((e) => e.tabela !== "api_audit_log");

describe("PATCH de material com `items`", () => {
  it("documento: recusa 422 e não grava nada (hoje: 200 sem efeito)", async () => {
    estado.tipo = "documento";
    const res = await patch({ items: ITENS });

    expect(res.status).toBe(422);
    expect(estado.escritas).toEqual([]);
  });

  it("catalogo com { name, items }: recusa 422 e o nome NÃO é gravado", async () => {
    estado.tipo = "catalogo";
    const res = await patch({ name: "Nome novo", items: ITENS });

    expect(res.status).toBe(422);
    expect(estado.escritas).toEqual([]);
  });

  it("controle: faq com items troca os pares (200)", async () => {
    estado.tipo = "faq";
    const res = await patch({ items: ITENS });

    expect(res.status).toBe(200);
    expect((await res.json()).data.items_count).toBe(1);
    expect(escritasDeMaterial().map((e) => `${e.tabela}:${e.operacao}`)).toEqual([
      "ai_faq_items:delete",
      "ai_faq_items:insert",
    ]);
  });

  it("controle: documento só com { name } renomeia (200)", async () => {
    estado.tipo = "documento";
    const res = await patch({ name: "Manual novo" });

    expect(res.status).toBe(200);
    expect(escritasDeMaterial()).toEqual([
      { tabela: "ai_knowledge_sources", operacao: "update", dados: { name: "Manual novo" } },
    ]);
  });
});
