/**
 * Dublê de banco das rotas de etapas (`app/api/v1/pipelines/[id]/stages/**`).
 *
 * Ele APLICA os filtros `eq`, a projeção do `select()`, o `order()` e o
 * `count`/`head` de verdade. Um stub de linha fixa deixaria "etapa de outra
 * organização → 404" passar mesmo com o `eq("organization_id", …)` apagado da
 * rota: mediria o dublê, não o handler.
 *
 * Ele também registra CADA escrita (update e insert) com seus filtros e com
 * marcas de início/fim, porque três garantias desta task são sobre a emissão em
 * si: "nenhuma escrita quando é 404", "desmarcar antes de marcar" e "mover os
 * negócios antes de arquivar a etapa".
 */
import { vi } from "vitest";

import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";

export const ORG_ID = "22222222-2222-4222-8222-222222222222";
export const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
export const USER_ID = "11111111-1111-4111-8111-111111111111";
export const PIPE = "44444444-4444-4444-8444-444444444444";

export interface StageRow {
  id: string;
  name: string;
  slug: string;
  position: number;
  is_won: boolean;
  is_lost: boolean;
  is_archived: boolean;
  agent_stage_hint: string | null;
  pipeline_id: string;
  organization_id: string;
  resets_context: boolean;
  context_reset_after_days: number;
}

export function etapa(over: Partial<StageRow> & { id: string; name: string }): StageRow {
  return {
    slug: over.id,
    position: 1,
    is_won: false,
    is_lost: false,
    is_archived: false,
    agent_stage_hint: null,
    pipeline_id: PIPE,
    organization_id: ORG_ID,
    // Default de fábrica da migration 0100 — org nova não tem etapa marcada.
    resets_context: false,
    context_reset_after_days: 7,
    ...over,
  };
}

export interface LeadRow {
  id: string;
  stage_id: string;
  pipeline_id: string;
  organization_id: string;
  contact_id: string | null;
}

export function negocio(id: string, stageId: string, over: Partial<LeadRow> = {}): LeadRow {
  return {
    id,
    stage_id: stageId,
    pipeline_id: PIPE,
    organization_id: ORG_ID,
    contact_id: null,
    ...over,
  };
}

export interface Escrita {
  tipo: "update" | "insert";
  table: string;
  /** O corpo como a rota o mandou: linha no update/insert simples, ARRAY no insert multi-linha. */
  patch: Record<string, unknown> | Record<string, unknown>[];
  filtros: Array<[string, unknown]>;
}

export interface DbOpts {
  /** Org dona do pipeline — troque para simular funil de outro tenant. */
  pipelineOrg?: string;
  stages?: StageRow[];
  leads?: LeadRow[];
  /** Erro do banco na n-ésima escrita (1-based), como o PostgREST devolveria. */
  writeError?: (n: number, table: string) => { code: string; message: string } | null;
}

type Linha = Record<string, unknown>;

export interface Registro {
  escritas: Escrita[];
  eventos: string[];
  rpcs: Array<{ nome: string; args: unknown }>;
  /** As tabelas DEPOIS das escritas — é aqui que se confere que os negócios andaram. */
  tabelas: {
    crm_pipelines: Linha[];
    crm_stages: Linha[];
    crm_leads: Linha[];
    crm_lead_activities: Linha[];
  };
}

export function makeDb(opts: DbOpts = {}): Registro {
  const registro: Registro = {
    escritas: [],
    eventos: [],
    rpcs: [],
    tabelas: {
      crm_pipelines: [{ id: PIPE, name: "Pedidos", organization_id: opts.pipelineOrg ?? ORG_ID }],
      crm_stages: (opts.stages ?? []) as unknown as Linha[],
      crm_leads: (opts.leads ?? []) as unknown as Linha[],
      crm_lead_activities: [],
    },
  };
  const tables = registro.tabelas as unknown as Record<string, Linha[] | undefined>;
  let nEscrita = 0;

  function builder(table: string) {
    const filtros: Array<[string, unknown]> = [];
    let patch: Record<string, unknown> | null = null;
    let nova: Record<string, unknown> | Record<string, unknown>[] | null = null;
    let colunas: string[] | null = null;
    let ordem: string | null = null;
    let contar = false;
    let head = false;

    const casam = () => (tables[table] ?? []).filter((r) => filtros.every(([c, v]) => r[c] === v));

    /** Ordena e projeta como o PostgREST faria. */
    const lidos = () => {
      const rows = [...casam()];
      if (ordem) rows.sort((a, b) => Number(a[ordem!]) - Number(b[ordem!]));
      if (!colunas) return rows;
      return rows.map((r) => Object.fromEntries(colunas!.map((c) => [c, r[c]])));
    };

    async function escreve(
      tipo: "update" | "insert",
      corpo: Record<string, unknown> | Record<string, unknown>[],
      aplica: () => void,
    ): Promise<{ data: unknown; error: unknown; count: number | null }> {
      const i = nEscrita++;
      registro.escritas.push({ tipo, table, patch: corpo, filtros: [...filtros] });
      registro.eventos.push(`start:${table}:${i}`);
      // Folga real: sem ela, escritas disparadas em paralelo teriam o mesmo
      // intercalamento de um laço sequencial e o teste de ordem não mediria nada.
      await new Promise((r) => setTimeout(r, 0));
      registro.eventos.push(`end:${table}:${i}`);
      const err = opts.writeError?.(i + 1, table) ?? null;
      if (err) return { data: null, error: err, count: null };
      aplica();
      return { data: null, error: null, count: null };
    }

    async function run(): Promise<{ data: unknown; error: unknown; count: number | null }> {
      if (patch) {
        const alvos = casam();
        const r = await escreve("update", patch, () => {
          for (const linha of alvos) Object.assign(linha, patch);
        });
        return r.error ? r : { ...r, data: alvos.map((l) => ({ ...l })) };
      }
      if (nova) {
        // `insert` aceita linha OU array — a rota de arquivamento grava as
        // atividades num ÚNICO insert multi-linha, e um dublê que só entende
        // linha solta esconderia justamente isso.
        const linhas = (Array.isArray(nova) ? nova : [nova]).map((l, k) => ({
          id: `novo-${nEscrita + 1}-${k}`,
          ...l,
        }));
        const r = await escreve("insert", nova, () => {
          (tables[table] ??= []).push(...linhas);
        });
        return r.error ? r : { ...r, data: linhas };
      }
      // `head: true` NÃO traz linhas; `count` sozinho traz linhas E contagem —
      // é assim que o PostgREST responde, e a diferença não é acadêmica: o dublê
      // devolvendo `data: null` para `select(..., { count })` fez a emissão de
      // atividades do arquivamento sumir com a suíte verde.
      if (head) return { data: null, error: null, count: casam().length };
      if (contar) return { data: lidos(), error: null, count: casam().length };
      return { data: lidos(), error: null, count: null };
    }

    const b = {
      select: (cols?: string, o?: { count?: string; head?: boolean }) => {
        colunas = cols ? cols.split(",").map((c) => c.trim()) : null;
        if (o?.count) contar = true;
        if (o?.head) head = true;
        return b;
      },
      insert: (r: Record<string, unknown> | Record<string, unknown>[]) => {
        nova = r;
        return b;
      },
      update: (p: Record<string, unknown>) => {
        patch = p;
        return b;
      },
      eq: (c: string, v: unknown) => {
        filtros.push([c, v]);
        return b;
      },
      order: (col: string) => {
        ordem = col;
        return b;
      },
      maybeSingle: async () => {
        const r = await run();
        return { data: (r.data as unknown[] | null)?.[0] ?? null, error: r.error };
      },
      single: async () => {
        const r = await run();
        const linha = (r.data as unknown[] | null)?.[0] ?? null;
        if (!r.error && !linha) {
          return { data: null, error: { code: "PGRST116", message: "no rows" } };
        }
        return { data: linha, error: r.error };
      },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => run().then(res, rej),
    };
    return b;
  }

  // `rpc` só existe para o aviso de atividade perdida (`emit_event`): sem ele, a
  // rota estouraria no caminho de falha e o teste mediria um TypeError em vez do
  // comportamento ("o arquivamento não é desfeito por causa do rastro").
  const rpc = async (nome: string, args: unknown) => {
    registro.rpcs.push({ nome, args });
    return { data: null, error: null };
  };

  vi.mocked(createClient).mockResolvedValue({ from: builder, rpc } as never);
  return registro;
}

export function authOk(role: "manager" | "admin" = "manager"): void {
  const user: AuthUser = {
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role }],
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role },
  });
}

/**
 * Funil de trabalho: duas etapas comuns, uma de ganho e uma de perda.
 *
 * DE PROPÓSITO fora da ordem de `position` — se a tabela já viesse ordenada, o
 * `.order("position")` da rota poderia sumir com a suíte verde enquanto a tela
 * mostra as etapas embaralhadas (e a etapa nova nasceria no meio do funil).
 */
export function funil(): StageRow[] {
  return [
    etapa({ id: "e3", name: "Pago", slug: "pago", position: 3000, is_won: true }),
    etapa({ id: "e1", name: "Novo", slug: "novo", position: 1000 }),
    etapa({ id: "e4", name: "Cancelado", slug: "cancelado", position: 4000, is_lost: true }),
    etapa({ id: "e2", name: "Proposta", slug: "proposta", position: 2000 }),
  ];
}
