import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

import type { McpContext } from "@/lib/mcp/types";
import { crmGetProspectingSiteAudit } from "@/lib/mcp/tools/prospeccao-site";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * A ANÁLISE DO SITE DE UMA ORGANIZAÇÃO NÃO CHEGA AO AGENTE DE OUTRA.
 *
 * A ferramenta roda com service role (ctx.supabase), que ignora RLS. O que a
 * segura é o filtro `organization_id` em toda consulta. Este caso monta duas
 * organizações, cada uma com um candidato auditado, e prova que a consulta da
 * organização A, mesmo recebendo o contato da B no `contatoDoTurno`, não devolve
 * a auditoria da B.
 *
 * O contato do turno é contexto de confiança, então "forjar" aqui é o pior caso
 * que o próprio teste aceita: o filtro de organização tem de segurar sozinho.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  host: "127.0.0.1",
  port: PORT,
  user: "postgres",
  password: "postgres",
  database: "postgres",
});
const db = pgComoSupabase(pool);
afterAll(() => pool.end());

function siteGravado(classe: string) {
  return {
    ver: 1,
    classe,
    problemas: [],
    checklist: { tem: [], falta: [] },
    final_url: null,
    http_status: null,
    tempo_ms: 0,
    conteudo_resumo: null,
    pagespeed: null,
    verificado_em: "2026-10-03T10:00:00.000Z",
    provisorio: false,
    tentativas: 0,
  };
}

async function organizacaoComCandidato(classe: string) {
  const org = randomUUID();
  const contato = randomUUID();
  const campanha = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1,$2,'Análise','Análise')",
    [org, `site-${org.slice(0, 8)}`],
  );
  await pool.query(
    "insert into contacts(id,organization_id,name,phone_number) values($1,$2,'Contato',$3)",
    [contato, org, `+55119${Math.floor(10000000 + Math.random() * 89999999)}`],
  );
  await pool.query(
    "insert into prospecting_campaigns(id,organization_id,request_id,name,search,config,status) values($1,$2,$3,'c',$4,'{}','paused')",
    [campanha, org, randomUUID(), JSON.stringify({ niche: "Clínicas" })],
  );
  await pool.query(
    `insert into prospecting_candidates(id,organization_id,campaign_id,place_id,data,status,contact_id)
     values($1,$2,$3,$4,$5,'sent',$6)`,
    [
      randomUUID(),
      org,
      campanha,
      `place-${org.slice(0, 8)}`,
      JSON.stringify({ name: "Empresa", website: "https://x.com.br", site: siteGravado(classe) }),
      contato,
    ],
  );
  return { org, contato };
}

function ctxDe(org: string, contatoDoTurno: string): McpContext {
  return {
    organizationId: org,
    contatoDoTurno,
    supabase: db,
  } as unknown as McpContext;
}

describe("crm_get_prospecting_site_audit — isolamento entre organizações", () => {
  it("a organização A, com o contato da B forjado no turno, não lê a auditoria da B", async () => {
    const a = await organizacaoComCandidato("sem-site");
    const b = await organizacaoComCandidato("fora-do-ar");

    const r = await crmGetProspectingSiteAudit.handler({}, ctxDe(a.org, b.contato));

    // A B tem auditoria "fora-do-ar". Se o filtro de organização faltasse, a
    // resposta seria disponível com esse tipo.
    expect(r).toEqual({ disponivel: false, motivo: "sem_auditoria" });
  });

  it("controle: a própria organização lê a sua auditoria (o caso não é vazio)", async () => {
    const a = await organizacaoComCandidato("sem-site");
    const r = await crmGetProspectingSiteAudit.handler({}, ctxDe(a.org, a.contato));
    expect(r).toMatchObject({ disponivel: true, classe_do_site: "sem-site" });
  });

  it("controle: a B lê a auditoria da B, com o tipo dela", async () => {
    const b = await organizacaoComCandidato("fora-do-ar");
    const r = await crmGetProspectingSiteAudit.handler({}, ctxDe(b.org, b.contato));
    expect(r).toMatchObject({ disponivel: true, tipo_do_site: "Site fora do ar" });
  });
});
