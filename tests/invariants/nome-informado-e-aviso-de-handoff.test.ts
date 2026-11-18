/**
 * O SQL NOVO DO #3784 CONTRA POSTGRES DE VERDADE: o nome informado e o aviso de
 * transferência.
 *
 * Os testes unitários do autor provam o contrato com dublês; o que só o banco
 * prova é o próprio SQL: que o nome nunca sobrescreve uma ficha preenchida, que
 * a organização do id filtra a leitura E a escrita, que gravação e auditoria
 * saem juntas, e que o evento do aviso nasce UMA vez por episódio — inclusive
 * depois da poda do `event_log` — e só com o Aviso de caso E a opção das
 * transferências ligados.
 *
 * SABOTAGEM medida na triagem: tirar `and metadata->>$7::text is distinct from
 * $5::text` de `performHumanHandoff` derruba o caso do episódio (1 failed).
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { performHumanHandoff } from "@/lib/agent-engine/agent/human-handoff";
import { registrarNomeInformado } from "@/lib/contacts/nome-informado";

import { GOV_ORG, GOV_SESSION, seedGov, sql } from "./gov-helpers";

const OUTRA_ORG = "dddddddd-3784-4000-8000-0000000000f1";
const C_VAZIO = "dddddddd-3784-4000-8000-0000000000a1";
const C_CHEIO = "dddddddd-3784-4000-8000-0000000000a2";
const V_VAZIO = "dddddddd-3784-4000-8000-0000000000b1";
const V_CHEIO = "dddddddd-3784-4000-8000-0000000000b2";
const M_VAZIO = "dddddddd-3784-4000-8000-0000000000c1";
const M_CHEIO = "dddddddd-3784-4000-8000-0000000000c2";
const C_H = "dddddddd-3784-4000-8000-0000000000a3";
const V_H = "dddddddd-3784-4000-8000-0000000000b3";
const C_H2 = "dddddddd-3784-4000-8000-0000000000a4";
const V_H2 = "dddddddd-3784-4000-8000-0000000000b4";
const C_H3 = "dddddddd-3784-4000-8000-0000000000a5";
const V_H3 = "dddddddd-3784-4000-8000-0000000000b5";

const PORTA = process.env.TEST_DB_PORT ?? "54329";
const pool = new pg.Pool({ connectionString: `postgres://postgres:postgres@127.0.0.1:${PORTA}/postgres`, max: 2 });
const logMudo = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Parameters<typeof performHumanHandoff>[2]["log"];
const nada = async () => undefined;

function flag(v: boolean, chave = "nome_informado_no_atendimento") {
  sql(`update public.organizations set settings = coalesce(settings,'{}'::jsonb) || jsonb_build_object('crm', coalesce(settings->'crm','{}'::jsonb) || jsonb_build_object('${chave}', ${v})) where id = '${GOV_ORG}';`);
}
const AVISO_LIGADO = `insert into public.config_aviso_de_caso (organization_id, channel_session_id, telefone_destino, ligado) values ('${GOV_ORG}','${GOV_SESSION}','+5531998966398',true) on conflict (organization_id) do update set ligado=true;`;
async function nome(id: string) {
  const { rows } = await pool.query<{ name: string | null }>(`select name from contacts where id=$1`, [id]);
  return rows[0]?.name ?? null;
}
async function audits(id: string) {
  const { rows } = await pool.query<{ n: string }>(`select count(*)::text n from api_audit_log where action='contact.field_auto_applied' and resource_id=$1`, [id]);
  return Number(rows[0]?.n);
}
const ids = (contactId: string, conversationId: string, messageId: string, organizationId = GOV_ORG) =>
  ({ organizationId, contactId, conversationId, messageId, serviceRevision: 1 });

let settingsAntes: unknown = {};
let avisoAntes: unknown = null;

beforeAll(async () => {
  seedGov();
  settingsAntes = (await pool.query(`select coalesce(settings,'{}'::jsonb) s from organizations where id=$1`, [GOV_ORG])).rows[0]?.s ?? {};
  avisoAntes = (await pool.query(`select row_to_json(a) r from config_aviso_de_caso a where organization_id=$1`, [GOV_ORG])).rows[0]?.r ?? null;
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values ('${OUTRA_ORG}','tri-3784-viz','Viz','Viz') on conflict do nothing;
    insert into public.contacts (id, organization_id, display_name, name) values
      ('${C_VAZIO}','${GOV_ORG}','Apelido WA',null), ('${C_CHEIO}','${GOV_ORG}','Apelido WA','Ana Humana'),
      ('${C_H}','${GOV_ORG}','H',null), ('${C_H2}','${GOV_ORG}','H2',null), ('${C_H3}','${GOV_ORG}','H3',null) on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status) values
      ('${V_VAZIO}','${GOV_ORG}','${C_VAZIO}','${GOV_SESSION}','ai_handling'),
      ('${V_CHEIO}','${GOV_ORG}','${C_CHEIO}','${GOV_SESSION}','ai_handling'),
      ('${V_H}','${GOV_ORG}','${C_H}','${GOV_SESSION}','ai_handling'),
      ('${V_H2}','${GOV_ORG}','${C_H2}','${GOV_SESSION}','ai_handling'),
      ('${V_H3}','${GOV_ORG}','${C_H3}','${GOV_SESSION}','ai_handling') on conflict do nothing;
    insert into public.messages (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, body, service_revision) values
      ('${M_VAZIO}','${GOV_ORG}','${V_VAZIO}','${GOV_SESSION}','${C_VAZIO}','text','inbound','Meu nome é Maria Silva',1),
      ('${M_CHEIO}','${GOV_ORG}','${V_CHEIO}','${GOV_SESSION}','${C_CHEIO}','text','inbound','Maria Silva',1);
  `);
  const { rows } = await pool.query(`select service_revision from messages where id=$1`, [M_VAZIO]);
  if (rows[0]?.service_revision == null) throw new Error("sonda: messages.service_revision não ficou 1 — instrumento inválido");
});
afterAll(async () => {
  // Devolve o que outros invariantes podem ter deixado: settings e aviso da org.
  await pool.query(`update organizations set settings=$2::jsonb where id=$1`, [GOV_ORG, JSON.stringify(settingsAntes)]);
  await pool.query(`delete from config_aviso_de_caso where organization_id=$1`, [GOV_ORG]);
  if (avisoAntes) {
    await pool.query(`insert into config_aviso_de_caso select * from json_populate_record(null::config_aviso_de_caso, $1::json)`, [JSON.stringify(avisoAntes)]);
  }
  await pool.end();
});

describe("nome informado contra Postgres", () => {
  it("opção desligada: nada grava", async () => {
    flag(false);
    const r = await registrarNomeInformado(pool, ids(C_VAZIO, V_VAZIO, M_VAZIO), "Maria Silva", nada);
    expect(r.aplicado).toBe(false);
    expect(await nome(C_VAZIO)).toBeNull();
  });
  it("outra organização no id: não grava no contato daqui", async () => {
    flag(true);
    const r = await registrarNomeInformado(pool, ids(C_VAZIO, V_VAZIO, M_VAZIO, OUTRA_ORG), "Maria Silva", nada);
    expect(r.aplicado).toBe(false);
    expect(await nome(C_VAZIO)).toBeNull();
    expect(await audits(C_VAZIO)).toBe(0);
  });
  it("nome já preenchido por humano: nunca sobrescreve", async () => {
    flag(true);
    const r = await registrarNomeInformado(pool, ids(C_CHEIO, V_CHEIO, M_CHEIO), "Maria Silva", nada);
    expect(r.aplicado).toBe(false);
    expect(await nome(C_CHEIO)).toBe("Ana Humana");
    expect(await audits(C_CHEIO)).toBe(0);
  });
  it("nome vazio: grava uma vez, com 1 auditoria; replay não grava de novo", async () => {
    flag(true);
    const r = await registrarNomeInformado(pool, ids(C_VAZIO, V_VAZIO, M_VAZIO), "Maria Silva", nada);
    expect(r).toEqual({ aplicado: true, nome: "Maria Silva" });
    expect(await nome(C_VAZIO)).toBe("Maria Silva");
    expect(await audits(C_VAZIO)).toBe(1);
    const r2 = await registrarNomeInformado(pool, ids(C_VAZIO, V_VAZIO, M_VAZIO), "Maria Silva", nada);
    expect(r2.aplicado).toBe(false);
    expect(await audits(C_VAZIO)).toBe(1);
  });
});

async function eventos(conv: string) {
  const { rows } = await pool.query<{ id: string }>(`select id from event_log where event_type='ai.handoff_aviso_solicitado' and entity_id=$1`, [conv]);
  return rows.map((r) => r.id);
}
async function centrais(conv: string) {
  const { rows } = await pool.query<{ n: string }>(`select count(*)::text n from agent_inbox_items where kind='handoff' and ref_id=$1`, [conv]);
  return Number(rows[0]?.n);
}
const passa = (contato: string, conversa: string) => performHumanHandoff(pool,
  { tenantId: GOV_ORG, leadId: contato, conversationId: conversa },
  { reason: "requested_human", conversationSummary: "resumo", log: logMudo });

describe("aviso de handoff contra Postgres", () => {
  it("sem aviso ligado: Central nasce, nenhum evento", async () => {
    sql(`delete from public.config_aviso_de_caso where organization_id='${GOV_ORG}';`);
    await passa(C_H2, V_H2);
    expect(await centrais(V_H2)).toBe(1);
    expect(await eventos(V_H2)).toHaveLength(0);
  });
  it("com aviso ligado: 1 evento por episódio, mesmo com 2 handoffs; novo episódio após retomar", async () => {
    flag(true, "avisar_transferencia_no_whatsapp");
    sql(AVISO_LIGADO);
    await passa(C_H, V_H);
    await passa(C_H, V_H);
    const ev = await eventos(V_H);
    expect(ev).toHaveLength(1);
    expect(await centrais(V_H)).toBe(1);
    const { rows } = await pool.query(`select metadata->>'aviso_handoff_episodio' ep, metadata->>'aviso_handoff_solicitado' sol from conversations where id=$1`, [V_H]);
    expect(rows[0]).toEqual({ ep: ev[0], sol: ev[0] });
    // poda do event_log não reabre o episódio
    await pool.query(`delete from event_log where id=$1`, [ev[0]]);
    await passa(C_H, V_H);
    expect(await eventos(V_H)).toHaveLength(0);
    // retomada do automático: outro episódio
    await pool.query(`update conversations set bot_silenced_until=null where id=$1`, [V_H]);
    await passa(C_H, V_H);
    expect(await eventos(V_H)).toHaveLength(1);
    sql(`delete from public.config_aviso_de_caso where organization_id='${GOV_ORG}';`);
  });
  it("aviso ligado mas transferências desligadas: Central nasce, nenhum evento", async () => {
    sql(AVISO_LIGADO);
    flag(false, "avisar_transferencia_no_whatsapp");
    await passa(C_H3, V_H3);
    expect(await centrais(V_H3)).toBe(1);
    expect(await eventos(V_H3)).toHaveLength(0);
    flag(true, "avisar_transferencia_no_whatsapp");
    sql(`delete from public.config_aviso_de_caso where organization_id='${GOV_ORG}';`);
  });
});
