import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { crmGetLead, crmUpdateLead } from "@/lib/mcp/tools/leads";
import type { McpContext } from "@/lib/mcp/types";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * ARQUIVO DE TRIAGEM (PR #194) — NÃO É PARA MERGE.
 *
 * O invariante do PR mede os HANDLERS (`getLeadHandler`, `updateLeadHandler`).
 * Este arquivo mede a camada acima — a FERRAMENTA que o agente realmente
 * invoca (`crm_get_lead`, `crm_update_lead`), que é o nome que o corpo do PR
 * usa ao declarar o defeito.
 *
 * A distinção não é acadêmica: na `main` 9249e6f2 o wrapper de `crm_get_lead`
 * já tinha uma checagem de organização depois de chamar o handler
 * (`lib/mcp/tools/leads.ts`, "Defesa em profundidade — service-role bypassa
 * RLS"). Se ela bastava, o furo de LEITURA não era alcançável pelo agente, e o
 * eixo da alegação está errado — que é exatamente o modo de falha que a
 * triagem existe para separar de "o defeito não existe".
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set");

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});
const db = pgComoSupabase(pool);

const ORG_A = "e194b000-0000-4000-8000-00000000000a";
const ORG_B = "e194b000-0000-4000-8000-00000000000b";
let leadDaVitima = "";

function ctxDeA(): McpContext {
  return {
    organizationId: ORG_A,
    role: "admin",
    actor: { type: "ai_agent", id: "run-de-a", role: "agent" },
    apiTokenId: "tok-de-a",
    requestId: "req-camada-ferramenta",
    supabase: db,
  } as McpContext;
}

async function semear(id: string, slug: string): Promise<{ pipeline: string; stage: string }> {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, $2, 'Tool LTDA', 'Tool') on conflict (id) do nothing`,
    [id, slug],
  );
  const { rows: p } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug, position)
     values ($1, 'Funil ' || $2, 'funil-' || $2, 100) returning id`,
    [id, slug],
  );
  const { rows: s } = await pool.query<{ id: string }>(
    `insert into crm_stages (organization_id, pipeline_id, name, slug, position)
     values ($1, $2, 'Etapa', 'etapa-' || $3, 1) returning id`,
    [id, p[0]!.id, slug],
  );
  return { pipeline: p[0]!.id, stage: s[0]!.id };
}

beforeAll(async () => {
  await semear(ORG_A, "tool-a");
  const b = await semear(ORG_B, "tool-b");
  const { rows } = await pool.query<{ id: string }>(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, title)
     values ($1, $2, $3, 'Negócio SECRETO da vítima') returning id`,
    [ORG_B, b.pipeline, b.stage],
  );
  leadDaVitima = rows[0]!.id;
});

afterAll(async () => {
  await pool.query("delete from organizations where id = any($1)", [[ORG_A, ORG_B]]);
  await pool.end();
});

describe("a FERRAMENTA que o agente invoca", () => {
  it("o cenário está montado — o lead alvo é da outra organização", async () => {
    const { rows } = await pool.query<{ organization_id: string }>(
      "select organization_id from crm_leads where id = $1",
      [leadDaVitima],
    );
    expect(rows[0]!.organization_id).toBe(ORG_B);
  });

  it("`crm_get_lead` NÃO devolve o negócio da outra organização", async () => {
    const r = await crmGetLead
      .handler({ lead_id: leadDaVitima } as never, ctxDeA())
      .catch(() => null);
    if (r) {
      const lead = (r as { lead?: { organization_id?: string } }).lead;
      expect(lead?.organization_id, "a ferramenta entregou o negócio de B").not.toBe(ORG_B);
    }
  });

  it("`crm_update_lead` NÃO reescreve o negócio da outra organização", async () => {
    await crmUpdateLead
      .handler(
        { lead_id: leadDaVitima, title: "INVADIDO pela ferramenta" } as never,
        ctxDeA(),
      )
      .catch(() => null);
    const { rows } = await pool.query<{ title: string }>(
      "select title from crm_leads where id = $1",
      [leadDaVitima],
    );
    expect(rows[0]!.title, "a ferramenta reescreveu o negócio de B").toBe(
      "Negócio SECRETO da vítima",
    );
  });
});
