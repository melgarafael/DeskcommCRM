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
 *
 * ⚠️ O dublê resolve `crm_pipelines.is_archived` por CAMINHO dentro da linha,
 * com ou sem `!inner` — e o `!inner` é a metade load-bearing do conserto. No
 * PostgREST real, filtro em recurso EMBUTIDO sem `!inner` não derruba a linha-
 * pai: ele anula o embed. Sem a asserção sobre a string do `select`, apagar o
 * `!inner` devolveria o lead de funil arquivado à lista — agora com
 * `funil_nome: null`, pior que o estado de antes — e este arquivo ficaria
 * verde. Por isso o `select` é espionado. Mesmo padrão de
 * `app/api/v1/ai/evolution/route.test.ts`, que assere sobre os pares de `.eq`.
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
  const selects: string[] = [];
  /**
   * Sequência de chamadas POR TABELA. Uma trilha global não serviria: as três
   * consultas da rota são montadas no mesmo `Promise.all`, uma depois da outra,
   * então o `.eq` de `orders` cairia DEPOIS do `.limit` de `crm_leads` e a
   * asserção de ordem falharia sem nenhum defeito no código.
   */
  const trilhas: Record<string, string[]> = {};
  const from = (tabela: string) => {
    const trilha = (trilhas[tabela] ??= []);
    let linhas = [...(tabelas[tabela] ?? [])];
    let limite = Infinity;
    const chain = {
      select: (cols: string) => (selects.push(cols), trilha.push("select"), chain),
      eq: (col: string, val: unknown) => ((linhas = linhas.filter((l) => valor(l, col) === val)), trilha.push("eq"), chain),
      is: (col: string, val: unknown) => ((linhas = linhas.filter((l) => (valor(l, col) ?? null) === val)), chain),
      not: (col: string, _op: string, val: unknown) => ((linhas = linhas.filter((l) => (valor(l, col) ?? null) !== val)), chain),
      order: () => chain,
      limit: (n: number) => ((limite = n), trilha.push("limit"), chain),
      maybeSingle: async () => ({ data: linhas[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: linhas.slice(0, limite), error: null }).then(res),
    };
    return chain;
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "u-1" } }, error: null }) },
    from,
    selects,
    trilhas,
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
    const banco = bancoFalso({
      contacts: [{ id: CONTATO, organization_id: ORG }],
      crm_leads: [
        lead("lead-arquivado", { name: "Funil antigo", is_archived: true }, "Novo"),
        lead("lead-ativo", { name: "GMN Advogados", is_archived: false }, "Novo"),
      ],
    });
    vi.mocked(createClient).mockResolvedValue(banco as never);

    const { GET } = await import("@/app/api/v1/contacts/[id]/crm-summary/route");
    const res = await GET(new NextRequest(`http://x/api/v1/contacts/${CONTATO}/crm-summary`), {
      params: Promise.resolve({ id: CONTATO }),
    });
    const body = (await res.json()) as { data: { leads: Linha[] } };

    expect(res.status).toBe(200);
    expect(body.data.leads.map((l) => [l.id, l.funil_nome, l.etapa_nome])).toEqual([
      ["lead-ativo", "GMN Advogados", "Novo"],
    ]);
    // Sem `!inner` o PostgREST real não derruba o lead: anula o embed.
    expect(banco.selects.join("|")).toContain("crm_pipelines!inner");
    // A etapa é o dado NOVO da linha (#943) e o dublê a serve da fixture, com
    // ou sem o embed pedido: sem esta asserção, apagar o embed da etapa do
    // `select` deixa o arquivo verde e a tela volta a dizer só o funil.
    // Nomeado pela FK desde a 0426: `lost_from_stage_id` é a SEGUNDA FK de
    // `crm_leads` para `crm_stages`, e o `crm_stages(name)` sem dica vira
    // PGRST201 no PostgREST real — a rota inteira em 500 e o painel dizendo
    // "Não consegui ler estes dados". O dublê não modela a ambiguidade; esta
    // asserção é quem a vigia.
    expect(banco.selects.join("|")).toContain("crm_stages!crm_leads_stage_id_fkey(name)");
    // Filtrar NO BANCO, antes do `limit(3)`, é a metade que o comentário da
    // rota declara — e que nenhuma asserção sobre o RESULTADO alcança, porque
    // com dois leads os dois arranjos devolvem a mesma lista. Mover o `.eq` do
    // funil arquivado para depois do `.limit` faria a rota pedir os 3 mais
    // recentes e SÓ ENTÃO descartar os arquivados: quem tem lead velho em funil
    // arquivado veria a lista encolher em vez de completar.
    const trilha = banco.trilhas.crm_leads ?? [];
    expect(trilha.lastIndexOf("eq")).toBeLessThan(trilha.indexOf("limit"));
  });
});
