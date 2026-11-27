import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as AuditModuleNs from "@/lib/audit";
import { atorDaIntervencao } from "@/lib/followup/intervencao";
import { motivoDoCancelamentoPelaFila } from "@/lib/followup/retorno-crm";
import { buildLeadActivityRow } from "@/lib/leads/activity-emitter";
import { createClient } from "@/lib/supabase/server";
import { insereAtividadeDoLead } from "@/lib/tarefas/atividade";

/**
 * A ATIVIDADE FEITA POR TOKEN DIZ QUAL INTEGRAÇÃO AGIU (#5160, item 2).
 *
 * ─── O defeito, medido na main `c45028c9c` ─────────────────────────────────
 *
 * Um token de API move o card ou edita o negócio e a atividade nasce com
 * `actor_kind = 'system'` (`actorParaAtividade`), sem nada na linha que diga
 * QUAL token agiu. O painel "Atividade" da conversa (`CRMSidePanel`) lê o
 * `crm-summary` e desenha "Sistema" — o mesmo rótulo da plataforma agindo
 * sozinha. O `api_audit_log` já guarda `actor_api_token_id`, mas nenhuma tela
 * de lead o lê.
 *
 * ─── O que estes testes prendem ────────────────────────────────────────────
 *
 *  1. ESCRITA: a linha de um token leva `metadata.actor_api_token_id`; a linha
 *     dos outros atores não ganha `metadata` (nada muda para eles, nem para os
 *     escritores por `pg` que listam as colunas).
 *  2. LEITURA: o `crm-summary` pede só o id (`metadata->>actor_api_token_id`,
 *     nunca o `metadata` inteiro), resolve `api_tokens.name` com o tenant no
 *     filtro e devolve `integracao: { nome }`; token que não existe nesta
 *     organização e linha que não é de token, `integracao: null`.
 *  3. Os escritores internos que usam o ator `api_token` com um rótulo no `id`
 *     (`cron:proposal-expiry`, `amigo-sync`…) não viram integração, e um valor
 *     desses numa linha não derruba a leitura dos nomes da janela.
 *  4. O escritor por `pg` das tarefas grava a mesma coluna, e a IA autenticada
 *     por token (`actor:ai_agent`) não é reconstruída como `api_token` nas
 *     intervenções de follow-up.
 */

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/users/nome-do-atendente", () => ({ nomesDosAtendentes: async () => new Map() }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: async () => ({ id: "user-1", idioma: "pt-BR" }) }));
vi.mock("@/lib/auth/require-role", () => ({
  orgAtivaDaApi: async () => ({ ok: true, org: { orgId: "org-1", name: "Org 1" } }),
}));

const admin = vi.hoisted(() => ({
  tokens: [] as Array<Record<string, unknown>>,
  filtros: [] as Array<[string, unknown]>,
  falha: false,
}));
vi.mock("@/lib/audit", async (orig) => ({
  ...(await orig<typeof AuditModuleNs>()),
  isServiceRoleConfigured: () => true,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      let linhas = tabela === "api_tokens" ? [...admin.tokens] : [];
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          admin.filtros.push([col, val]);
          linhas = linhas.filter((l) => l[col] === val);
          return chain;
        },
        in: (col: string, vals: unknown[]) => {
          admin.filtros.push([col, vals]);
          linhas = linhas.filter((l) => vals.includes(l[col]));
          return chain;
        },
        is: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: linhas[0] ?? null, error: null }),
        then: (res: (v: unknown) => unknown) =>
          Promise.resolve(
            admin.falha ? { data: null, error: { message: "leitura caiu" } } : { data: linhas, error: null },
          ).then(res),
      };
      return chain;
    },
    rpc: async () => ({ data: [], error: null }),
  }),
}));

const ORG = "org-1";
const CONTATO = "c0000000-0000-4000-8000-000000000001";
const TOKEN = "70000000-0000-4000-8000-000000000001";
const TOKEN_SEM_LINHA = "70000000-0000-4000-8000-000000000002";

type Linha = Record<string, unknown>;

function bancoFalso(tabelas: Record<string, Linha[]>) {
  const selects: Record<string, string[]> = {};
  const from = (tabela: string) => {
    let linhas = [...(tabelas[tabela] ?? [])];
    let limite = Infinity;
    const chain = {
      select: (cols: string) => (((selects[tabela] ??= []).push(cols)), chain),
      eq: (col: string, val: unknown) => ((linhas = linhas.filter((l) => l[col] === val)), chain),
      in: () => chain,
      is: () => chain,
      not: () => chain,
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
    selects,
  };
}

/** A linha como o PostgREST a devolve para o `select` da rota (alias incluído). */
function atividade(id: string, extra: Linha): Linha {
  return {
    id,
    organization_id: ORG,
    contact_id: CONTATO,
    type: "stage_changed",
    source_module: "crm",
    performed_at: "2026-11-20T12:00:00.000Z",
    payload: {},
    reason: "Movido de A para B",
    actor_kind: "system",
    performed_by_user_id: null,
    actor_api_token_id: null,
    ...extra,
  };
}

const base = {
  organizationId: ORG,
  leadId: "lead-1",
  type: "stage_changed" as const,
  sourceModule: "crm",
  reason: "Movido de A para B",
};

beforeEach(() => {
  admin.tokens = [];
  admin.filtros = [];
  admin.falha = false;
});

describe("#5160 — escrita: a linha do token guarda qual token agiu", () => {
  it("ator api_token: metadata.actor_api_token_id é o id do token", () => {
    const linha = buildLeadActivityRow({ ...base, actor: { type: "api_token", id: TOKEN } }) as unknown as Linha;
    expect(linha.actor_kind).toBe("system");
    expect(linha.metadata).toEqual({ actor_api_token_id: TOKEN });
  });

  it("ator api_token com rótulo interno no id (não é token): sem metadata", () => {
    for (const id of ["cron:proposal-expiry", "proposal:send", "amigo-sync", "amigo-reminder-check"]) {
      const linha = buildLeadActivityRow({ ...base, actor: { type: "api_token", id } }) as unknown as Linha;
      expect(Object.prototype.hasOwnProperty.call(linha, "metadata")).toBe(false);
    }
  });

  it("o escritor por pg das tarefas leva o metadata do token ao INSERT", async () => {
    const chamadas: Array<{ sql: string; params: unknown[] }> = [];
    const db = { query: async (sql: string, params: unknown[]) => (chamadas.push({ sql, params }), { rows: [] }) };
    const r = await insereAtividadeDoLead(db as never, {
      ...base,
      type: "task_created",
      sourceModule: "tarefas",
      actor: { type: "api_token", id: TOKEN },
    });
    expect(r.ok).toBe(true);
    const [insert] = chamadas;
    expect(insert?.sql).toContain("metadata");
    expect(insert?.params).toContainEqual({ actor_api_token_id: TOKEN });
  });

  it("intervenção de follow-up por token de IA não vira integração", () => {
    const ia = { type: "ai_agent", id: "run-1", role: "admin", api_token_id: TOKEN } as const;
    const ator = atorDaIntervencao({ userId: null, apiTokenId: TOKEN, actor: ia } as never);
    expect(ator).toEqual(ia);
    const linha = buildLeadActivityRow({ ...base, actor: ator }) as unknown as Linha;
    expect(Object.prototype.hasOwnProperty.call(linha, "metadata")).toBe(false);
  });

  it("retorno desmarcado pela fila por token não diz «por uma pessoa da equipe»", () => {
    expect(motivoDoCancelamentoPelaFila({ type: "user", id: "u-1" })).toBe("desmarcado por uma pessoa da equipe");
    expect(motivoDoCancelamentoPelaFila({ type: "api_token", id: TOKEN })).toBe("desmarcado por uma integração");
    expect(
      motivoDoCancelamentoPelaFila({ type: "ai_agent", id: "run-1", role: "admin", api_token_id: TOKEN }),
    ).toBe("desmarcado pelo agente de IA");
  });

  it("os outros atores não ganham metadata", () => {
    const atores = [
      { type: "user", id: "u-1" },
      { type: "ai_agent", id: "ag-1", agent_id: "ag-1", role: "agent" },
      { type: "webhook_source", id: "src-1" },
    ] as const;
    for (const actor of atores) {
      const linha = buildLeadActivityRow({ ...base, actor: actor as never }) as unknown as Linha;
      expect(Object.prototype.hasOwnProperty.call(linha, "metadata")).toBe(false);
    }
  });
});

describe("#5160 — leitura: o crm-summary devolve o nome da integração", () => {
  async function ler(atividades: Linha[]) {
    const banco = bancoFalso({
      contacts: [{ id: CONTATO, organization_id: ORG }],
      crm_lead_activities: atividades,
    });
    vi.mocked(createClient).mockResolvedValue(banco as never);
    const { GET } = await import("@/app/api/v1/contacts/[id]/crm-summary/route");
    const res = await GET(new NextRequest(`http://x/api/v1/contacts/${CONTATO}/crm-summary`), {
      params: Promise.resolve({ id: CONTATO }),
    });
    const body = (await res.json()) as { data: { activities: Linha[] } };
    expect(res.status).toBe(200);
    return { banco, atividades: body.data.activities };
  }

  it("token com nome: integracao.nome é o api_tokens.name, lido com o tenant no filtro", async () => {
    admin.tokens = [{ id: TOKEN, organization_id: ORG, name: "Zapier" }];
    const { banco, atividades } = await ler([atividade("a-1", { actor_api_token_id: TOKEN })]);

    expect(atividades[0]?.integracao).toEqual({ nome: "Zapier" });
    // Só o id sai do banco; o metadata inteiro não vai para o navegador.
    expect((banco.selects.crm_lead_activities ?? []).join("|")).toContain("metadata->>actor_api_token_id");
    expect(atividades[0]).not.toHaveProperty("metadata");
    // R3 da cerca do cliente admin: leitura por chave carrega o tenant.
    expect(admin.filtros).toContainEqual(["organization_id", ORG]);
  });

  it("token que não existe nesta organização: integracao é null (segue «Sistema»)", async () => {
    admin.tokens = [{ id: TOKEN_SEM_LINHA, organization_id: "org-2", name: "De outra empresa" }];
    const { atividades } = await ler([atividade("a-1", { actor_api_token_id: TOKEN_SEM_LINHA })]);
    expect(atividades[0]?.integracao).toBeNull();
  });

  it("leitura dos nomes caída: a linha de token diz «Integração» sem nome, não «Sistema»", async () => {
    admin.tokens = [{ id: TOKEN, organization_id: ORG, name: "Zapier" }];
    admin.falha = true;
    const { atividades } = await ler([atividade("a-1", { actor_api_token_id: TOKEN })]);
    expect(atividades[0]?.integracao).toEqual({ nome: null });
  });

  it("valor que não é UUID na linha não entra na consulta e não derruba os outros nomes", async () => {
    admin.tokens = [{ id: TOKEN, organization_id: ORG, name: "Zapier" }];
    const { atividades } = await ler([
      atividade("a-1", { actor_api_token_id: "cron:proposal-expiry" }),
      atividade("a-2", { actor_api_token_id: TOKEN }),
    ]);
    expect(atividades.map((a) => a.integracao)).toEqual([null, { nome: "Zapier" }]);
    const ids = admin.filtros.find(([col]) => col === "id")?.[1];
    expect(ids).toEqual([TOKEN]);
  });

  it("linha que não é de token: integracao é null", async () => {
    const { atividades } = await ler([atividade("a-1", {})]);
    expect(atividades[0]?.integracao).toBeNull();
  });
});
