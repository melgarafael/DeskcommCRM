import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";

/**
 * "Leads recentes" do painel do Inbox mostrava lead de funil ARQUIVADO (issue #943).
 * Arquivar só marca `crm_pipelines.is_archived`; o lead segue `open` e a rota
 * `crm-summary` o devolvia como qualquer outro. Mesma causa do Radar (#940).
 *
 * O banco falso APLICA os filtros, inclusive o do recurso embutido
 * (`crm_pipelines.is_archived`): um dublê que os ignorasse passaria com ou sem
 * o conserto. E o filtro precisa estar NO BANCO, antes do `limit(3)`: filtrar
 * depois esvaziaria a lista de quem tem leads antigos em funil arquivado.
 */

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/users/nome-do-atendente", () => ({ nomesDosAtendentes: async () => new Map() }));

const ORG = "org-1";
const CONTATO = "c0000000-0000-4000-8000-000000000001";

type Linha = Record<string, unknown>;

function valor(linha: Linha, caminho: string): unknown {
  return caminho.split(".").reduce<unknown>((acc, parte) => (acc as Linha | null)?.[parte], linha);
}

function bancoFalso(tabelas: Record<string, Linha[]>) {
  const from = (tabela: string) => {
    let linhas = [...(tabelas[tabela] ?? [])];
    let limite = Infinity;
    const chain = {
      select: () => chain,
      eq: (col: string, val: unknown) => ((linhas = linhas.filter((l) => valor(l, col) === val)), chain),
      is: (col: string, val: unknown) => ((linhas = linhas.filter((l) => (valor(l, col) ?? null) === val)), chain),
      not: (col: string, _op: string, val: unknown) => ((linhas = linhas.filter((l) => (valor(l, col) ?? null) !== val)), chain),
      order: () => chain,
      limit: (n: number) => ((limite = n), chain),
      maybeSingle: async () => ({ data: linhas[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: linhas.slice(0, limite), error: null }).then(res),
    };
    return chain;
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "u-1" } }, error: null }) },
    from,
  };
}

function lead(id: string, funil: { name: string; is_archived: boolean }, etapa: string): Linha {
  return {
    id, organization_id: ORG, contact_id: CONTATO, title: "Felipe", status: "open",
    value_cents: null, currency: null, updated_at: "2026-09-15T12:00:00.000Z",
    pipeline_id: `p-${id}`, custom_fields: {},
    crm_pipelines: { ...funil, settings: {} },
    crm_stages: { name: etapa },
  };
}

describe("crm-summary: leads recentes", () => {
  it("não devolve lead de funil arquivado e diz funil e etapa dos outros", async () => {
    vi.mocked(createClient).mockResolvedValue(bancoFalso({
      contacts: [{ id: CONTATO, organization_id: ORG }],
      crm_leads: [
        lead("lead-arquivado", { name: "Funil antigo", is_archived: true }, "Novo"),
        lead("lead-ativo", { name: "GMN Advogados", is_archived: false }, "Novo"),
      ],
    }) as never);

    const { GET } = await import("@/app/api/v1/contacts/[id]/crm-summary/route");
    const res = await GET(new NextRequest(`http://x/api/v1/contacts/${CONTATO}/crm-summary`), {
      params: Promise.resolve({ id: CONTATO }),
    });
    const body = (await res.json()) as { data: { leads: Linha[] } };

    expect(res.status).toBe(200);
    expect(body.data.leads.map((l) => [l.id, l.funil_nome, l.etapa_nome])).toEqual([
      ["lead-ativo", "GMN Advogados", "Novo"],
    ]);
  });
});
