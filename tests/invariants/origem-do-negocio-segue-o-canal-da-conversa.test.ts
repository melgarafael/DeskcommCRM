/**
 * A CORREÇÃO DO PASSADO (migration 0531) TROCA SÓ O QUE ESTAVA ERRADO.
 *
 * Antes do conserto, todo negócio aberto por uma conversa do Instagram ou do
 * Facebook nascia com `crm_leads.source = 'whatsapp'`. A 0531 corrige os que já
 * existem, e o critério é o vínculo exato que `garantirLeadDaConversa` grava: a
 * atividade `lead_created` de `source_module = 'canal.ingest'`, cuja
 * `source_id` é a conversa que fez o negócio nascer.
 *
 * O que se prova aqui, num banco de verdade:
 *   - o negócio do Instagram e o do Facebook passam a dizer a rede;
 *   - o negócio do WhatsApp continua WhatsApp;
 *   - a origem de anúncio (`meta_ads`) não é atropelada pelo canal;
 *   - um negócio sem a atividade de nascimento da conversa não é tocado;
 *   - a correção não atravessa organização: a atividade de B que aponta para o
 *     id de uma conversa de A não casa;
 *   - a segunda execução não muda nada (o `update.sh` reaplica o baseline).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error(
    "TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)",
  );
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    [
      "exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres",
      "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-",
    ],
    { input: script, encoding: "utf8" },
  ).trim();
}

const P = "eeeeeeee-0531-4000-8000-";
const ORG_A = `${P}00000000000a`;
const ORG_B = `${P}00000000000b`;
const SESSAO_A = `${P}0000000005a0`;
const SESSAO_B = `${P}0000000005b0`;
const FUNIL_A = `${P}0000000001a0`;
const FUNIL_B = `${P}0000000001b0`;
const ETAPA_A = `${P}0000000002a0`;
const ETAPA_B = `${P}0000000002b0`;

/** Um negócio por caso: [id, org, canal da conversa, source inicial, source_module]. */
const CASOS = {
  instagram: { lead: `${P}0000000003a1`, org: ORG_A, canal: "instagram", source: "whatsapp", modulo: "canal.ingest" },
  whatsapp: { lead: `${P}0000000003a2`, org: ORG_A, canal: "whatsapp", source: "whatsapp", modulo: "canal.ingest" },
  anuncio: { lead: `${P}0000000003a3`, org: ORG_A, canal: "instagram", source: "meta_ads", modulo: "canal.ingest" },
  outroModulo: { lead: `${P}0000000003a4`, org: ORG_A, canal: "instagram", source: "whatsapp", modulo: "manual" },
  facebook: { lead: `${P}0000000003b1`, org: ORG_B, canal: "facebook", source: "whatsapp", modulo: "canal.ingest" },
} as const;

/** Negócio de B cuja atividade aponta para o id da conversa do caso `instagram` (de A). */
const LEAD_B_APONTA_PARA_A = `${P}0000000003b2`;

const conversaDe = (lead: string): string => lead.replace(/0000000003(..)$/, "0000000004$1");
const contatoDe = (lead: string): string => lead.replace(/0000000003(..)$/, "0000000006$1");

const CORRECAO = (() => {
  const arquivo = readFileSync(
    "supabase/migrations/20261003170000_0531_origem_do_negocio_segue_o_canal_da_conversa.sql",
    "utf8",
  );
  return arquivo.slice(arquivo.indexOf("update public.crm_leads l"));
})();

const sourceDe = (lead: string): string =>
  sql(`select source from public.crm_leads where id = '${lead}';`);

function limpar(): void {
  sql(`
    delete from public.crm_lead_activities where organization_id in ('${ORG_A}', '${ORG_B}');
    delete from public.crm_leads where organization_id in ('${ORG_A}', '${ORG_B}');
    delete from public.conversations where organization_id in ('${ORG_A}', '${ORG_B}');
    delete from public.contacts where organization_id in ('${ORG_A}', '${ORG_B}');
    delete from public.crm_stages where organization_id in ('${ORG_A}', '${ORG_B}');
    delete from public.crm_pipelines where organization_id in ('${ORG_A}', '${ORG_B}');
    delete from public.channel_sessions where organization_id in ('${ORG_A}', '${ORG_B}');
    delete from public.organizations where id in ('${ORG_A}', '${ORG_B}');
  `);
}

beforeAll(() => {
  limpar();
  const sessao = (org: string) => (org === ORG_A ? SESSAO_A : SESSAO_B);
  const funil = (org: string) => (org === ORG_A ? FUNIL_A : FUNIL_B);
  const etapa = (org: string) => (org === ORG_A ? ETAPA_A : ETAPA_B);

  let seed = `
    insert into public.organizations (id, slug, display_name, legal_name)
      values ('${ORG_A}', 'org-0531-a', 'Org A', 'Org A'),
             ('${ORG_B}', 'org-0531-b', 'Org B', 'Org B');
    insert into public.channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
      values ('${SESSAO_A}', '${ORG_A}', 'sessao-0531-a', 'WORKING', '\\x00'::bytea),
             ('${SESSAO_B}', '${ORG_B}', 'sessao-0531-b', 'WORKING', '\\x00'::bytea);
    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${FUNIL_A}', '${ORG_A}', 'Funil', 'funil-0531-a'),
             ('${FUNIL_B}', '${ORG_B}', 'Funil', 'funil-0531-b');
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${ETAPA_A}', '${ORG_A}', '${FUNIL_A}', 'Entrada', 'entrada', 1),
             ('${ETAPA_B}', '${ORG_B}', '${FUNIL_B}', 'Entrada', 'entrada', 1);
  `;
  for (const c of Object.values(CASOS)) {
    seed += `
      insert into public.contacts (id, organization_id, display_name)
        values ('${contatoDe(c.lead)}', '${c.org}', 'Contato');
      insert into public.conversations (id, organization_id, contact_id, channel_session_id, status, is_group, channel)
        values ('${conversaDe(c.lead)}', '${c.org}', '${contatoDe(c.lead)}', '${sessao(c.org)}', 'open', false, '${c.canal}');
      insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title, source)
        values ('${c.lead}', '${c.org}', '${funil(c.org)}', '${etapa(c.org)}', '${contatoDe(c.lead)}', 'Negócio', '${c.source}');
      insert into public.crm_lead_activities (organization_id, lead_id, contact_id, source_module, source_id, type)
        values ('${c.org}', '${c.lead}', '${contatoDe(c.lead)}', '${c.modulo}', '${conversaDe(c.lead)}', 'lead_created');
    `;
  }
  seed += `
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, source)
      values ('${LEAD_B_APONTA_PARA_A}', '${ORG_B}', '${FUNIL_B}', '${ETAPA_B}', 'Negócio', 'whatsapp');
    insert into public.crm_lead_activities (organization_id, lead_id, source_module, source_id, type)
      values ('${ORG_B}', '${LEAD_B_APONTA_PARA_A}', 'canal.ingest', '${conversaDe(CASOS.instagram.lead)}', 'lead_created');
  `;
  sql(seed);
});

afterAll(() => {
  limpar();
});

describe("correção da origem do negócio pelo canal da conversa (0531)", () => {
  it("troca só o que estava errado, e não atravessa organização", () => {
    sql(CORRECAO);

    expect(sourceDe(CASOS.instagram.lead), "Instagram continuou WhatsApp").toBe("instagram");
    expect(sourceDe(CASOS.facebook.lead), "Facebook continuou WhatsApp").toBe("facebook");
    expect(sourceDe(CASOS.whatsapp.lead), "o negócio do WhatsApp mudou").toBe("whatsapp");
    expect(sourceDe(CASOS.anuncio.lead), "a origem de anúncio foi atropelada").toBe("meta_ads");
    expect(sourceDe(CASOS.outroModulo.lead), "tocou negócio que não nasceu da conversa").toBe(
      "whatsapp",
    );
    expect(
      sourceDe(LEAD_B_APONTA_PARA_A),
      "a correção casou a atividade de B com a conversa de A",
    ).toBe("whatsapp");
  });

  it("segunda execução não muda mais nada — o baseline é reaplicado em todo update", () => {
    const todos = [...Object.values(CASOS).map((c) => c.lead), LEAD_B_APONTA_PARA_A];
    const antes = todos.map(sourceDe);
    sql(CORRECAO);
    expect(todos.map(sourceDe)).toEqual(antes);
  });

  it("o apêndice do baseline traz a MESMA correção — é ela que chega a quem instalou", () => {
    const baseline = readFileSync("supabase/baseline.sql", "utf8");
    const bloco = baseline.slice(baseline.lastIndexOf("(migration 0531)"));
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    expect(norm(bloco)).toContain(norm(CORRECAO));
  });
});
