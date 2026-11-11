import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { McpContext } from "@/lib/mcp/types";
import { crmGetProspectingSiteAudit } from "@/lib/mcp/tools/prospeccao-site";
import { prospectingConversationContext } from "@/lib/prospecting/context";
import { pgComoSupabase } from "../pg-como-supabase";
import {
  COMPLEMENTO_SEM_SITE, COMPLEMENTO_TRES, criarFixtureDeOfertas, limparFixtureDeOfertas, mudarOfertas,
  type FixtureDeOfertas,
} from "../support/prospeccao-ofertas-fixture";

if (!process.env.TEST_DB_CONTAINER) throw new Error("Esta prova exige o Postgres efêmero de test:db.");
const pool = new pg.Pool({
  host: "127.0.0.1", port: Number(process.env.TEST_DB_PORT ?? 54329),
  user: "postgres", password: "postgres", database: "postgres", max: 2,
  statement_timeout: 5000,
});
const db = pgComoSupabase(pool);
const orgs = [randomUUID(), randomUUID()];
let a: FixtureDeOfertas;
let b: FixtureDeOfertas;

function contexto(org: string, contato: string, agente: string): McpContext {
  return {
    organizationId: org, contatoDoTurno: contato, role: "ai_operator",
    actor: { type: "ai_agent", id: agente, agent_id: agente, role: "ai_operator" },
    apiTokenId: randomUUID(), requestId: randomUUID(), supabase: db,
  };
}

beforeAll(async () => {
  for (const org of orgs) {
    await pool.query(
      "insert into organizations(id,slug,legal_name,display_name) values($1,$2,'Ofertas QA','Ofertas QA')",
      [org, `ofertas-qa-${org}`],
    );
  }
  a = await criarFixtureDeOfertas(pool, orgs[0]!);
  b = await criarFixtureDeOfertas(pool, orgs[1]!, ["automacao_n8n"]);
  await pool.query(
    "update prospecting_campaigns set config=jsonb_set(config,'{instruction}',to_jsonb($3::text)) where organization_id=$1 and id=$2",
    [b.org, b.campaign, "MARCADOR EXCLUSIVO B: confirmar informações sem copiar para outra empresa."],
  );
});

afterAll(async () => {
  try {
    if (a) await limparFixtureDeOfertas(pool, a);
    if (b) await limparFixtureDeOfertas(pool, b);
    // As organizações são novas e exclusivas deste arquivo; nenhum seed compartilhado sai.
    for (const org of orgs) await pool.query("delete from organizations where id=$1", [org]);
  } finally {
    await pool.end();
  }
});

describe("ofertas reais da campanha no contexto e na tool, com organizações A/B", () => {
  it("A recebe suas três ofertas, em ordem, e seu complemento; B recebe somente a própria oferta", async () => {
    const diretoA = await crmGetProspectingSiteAudit.handler({}, contexto(a.org, a.contact, a.agent));
    const diretoB = await crmGetProspectingSiteAudit.handler({}, contexto(b.org, b.contact, b.agent));
    expect(diretoA).toMatchObject({
      disponivel: true,
      ofertas_da_campanha: ["Site profissional", "Automação do atendimento (CRM)", "Automações e integrações (N8N)"],
      estrategia_de_abordagem: { complementar: COMPLEMENTO_TRES },
    });
    expect(diretoB).toMatchObject({
      disponivel: true,
      ofertas_da_campanha: ["Automações e integrações (N8N)"],
      estrategia_de_abordagem: { complementar: "As automações tiram o trabalho repetido, sem trocar ninguém da equipe." },
    });
    const textoA = await prospectingConversationContext(pool, a.org, a.conversation);
    const textoB = await prospectingConversationContext(pool, b.org, b.conversation);
    expect(textoA).toContain("em ordem: Site profissional; Automação do atendimento (CRM); Automações e integrações (N8N).");
    expect(textoA).not.toContain("MARCADOR EXCLUSIVO B");
    expect(textoB).toContain("MARCADOR EXCLUSIVO B");
    expect(textoB).toContain("em ordem: Automações e integrações (N8N).");
    expect(textoB).not.toContain("Site profissional");
  });

  it("A com contato ou conversa de B não lê a campanha vizinha", async () => {
    expect(await crmGetProspectingSiteAudit.handler({}, contexto(a.org, b.contact, a.agent)))
      .toEqual({ disponivel: false, motivo: "sem_auditoria" });
    expect(await prospectingConversationContext(pool, a.org, b.conversation)).toBe("");
    // Positivos no mesmo banco impedem um verde que bloqueie tudo.
    expect(await crmGetProspectingSiteAudit.handler({}, contexto(a.org, a.contact, a.agent)))
      .toMatchObject({ disponivel: true });
    expect(await crmGetProspectingSiteAudit.handler({}, contexto(b.org, b.contact, b.agent)))
      .toMatchObject({ disponivel: true });
  });

  it("site-only não tem complemento e a seleção sem site não ganha o prefixo de site", async () => {
    try {
      await mudarOfertas(pool, a, ["site"]);
      expect(await crmGetProspectingSiteAudit.handler({}, contexto(a.org, a.contact, a.agent)))
        .toMatchObject({ ofertas_da_campanha: ["Site profissional"], estrategia_de_abordagem: { complementar: null } });
      await pool.query(
        "update prospecting_campaigns set config=config-'ofertas' where organization_id=$1 and id=$2",
        [a.org, a.campaign],
      );
      expect(await crmGetProspectingSiteAudit.handler({}, contexto(a.org, a.contact, a.agent)))
        .toMatchObject({ ofertas_da_campanha: ["Site profissional"], estrategia_de_abordagem: { complementar: null } });
      expect(await prospectingConversationContext(pool, a.org, a.conversation))
        .not.toContain("O que esta campanha vende");
      await mudarOfertas(pool, a, ["automacao_crm", "automacao_n8n"]);
      expect(await crmGetProspectingSiteAudit.handler({}, contexto(a.org, a.contact, a.agent)))
        .toMatchObject({
          ofertas_da_campanha: ["Automação do atendimento (CRM)", "Automações e integrações (N8N)"],
          estrategia_de_abordagem: { complementar: COMPLEMENTO_SEM_SITE },
        });
    } finally {
      await mudarOfertas(pool, a, ["site", "automacao_crm", "automacao_n8n"]);
    }
  });
});
