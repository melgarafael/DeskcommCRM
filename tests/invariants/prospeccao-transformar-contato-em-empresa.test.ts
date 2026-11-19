/**
 * "TRANSFORMAR EM EMPRESA" — issue #3198, fatia 3.
 *
 * O handler de produto (`transformarContatoEmEmpresaHandler`) roda contra o
 * Postgres de verdade, com `empresaDoCandidato` (fatia 2) e o gatilho
 * `trg_contacts_company_same_org` (9406) sem dublê. O que estes casos medem:
 *
 * 1. o contato da prospecção vira Empresa com site, Maps, `place_id` e o endereço
 *    separado em colunas, e o `contacts.company_id` fica gravado;
 * 2. o segundo clique é recusado (409) e não duplica a Empresa;
 * 3. a mesma loja do Maps prospectada em DUAS organizações vira duas Empresas,
 *    cada uma na sua — nada cruza o tenant;
 * 4. contato de outra organização é 404, sem escrita;
 * 5. o que a equipe já digitou na Empresa não é sobrescrito pelo endereço do Maps;
 * 6. vencida a poda de 365 dias (a linha do candidato some), a Empresa nasce só
 *    com o que o contato guardou.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const adm = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => adm.client }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import type { HandlerCtx } from "../../lib/api/handlers/types";
import { transformarContatoEmEmpresaHandler } from "../../lib/crm-b2b/empresa-da-prospeccao";
import { meetPgSupabase } from "../support/meet-pg-supabase";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const ORG_A = "31983000-0000-4000-8000-00000000000a";
const ORG_B = "31983000-0000-4000-8000-00000000000b";
const CAMPANHA_A = "31983000-1111-4000-8000-00000000000a";
const CAMPANHA_B = "31983000-1111-4000-8000-00000000000b";
const ATOR = "31983000-2222-4000-8000-000000000001";
const PLACE = "ChIJ-fatia3-padaria";

function ctx(org: string): HandlerCtx {
  return {
    organization_id: org,
    actor: { type: "user", id: ATOR, role: "agent" },
    requestId: "req-3198-f3-db",
    idioma: "pt-BR",
  };
}

async function semearContato(org: string, campanha: string, place = PLACE): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `insert into contacts (id, organization_id, name, display_name, phone_number, source, source_metadata)
     values ($1,$2,'Padaria Fatia 3','Padaria Fatia 3','+5511999990000','prospecting',$3::jsonb)`,
    [id, org, JSON.stringify({ campaign_id: campanha, place_id: place, maps_url: `https://maps.example.test/?q=${place}` })],
  );
  return id;
}

async function semearCandidato(org: string, campanha: string, contactId: string, place = PLACE) {
  await pool.query(
    `insert into prospecting_candidates (id, organization_id, campaign_id, place_id, phone, data, status, contact_id)
     values ($1,$2,$3,$4,'+5511999990000',$5::jsonb,'sent',$6)`,
    [
      randomUUID(),
      org,
      campanha,
      place,
      JSON.stringify({
        name: "Padaria Fatia 3",
        category: "Padaria",
        address: "R. Augusta, 1234 - Consolação, São Paulo - SP, 01304-001",
        website: "https://padaria-fatia3.example.test",
        maps_url: `https://maps.example.test/?q=${place}`,
        rating: 4.6,
        reviews: 120,
        emails: ["contato@padaria-fatia3.example.test"],
        socials: [],
      }),
      contactId,
    ],
  );
}

async function conta(sql: string, args: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(sql, args);
  const n = rows[0]?.n;
  if (n === undefined) throw new Error(`contagem sem a coluna n: ${sql}`);
  return Number(n);
}

async function ligarModulo(): Promise<void> {
  await pool.query(
    `insert into platform_config (chave, valor) values ('MODULO_CRM_B2B', 'ligado')
     on conflict (chave) do update set valor = 'ligado'`,
  );
}

beforeEach(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values
       ($1, 'org-transformar-empresa-a', 'Org A', 'Org A'),
       ($2, 'org-transformar-empresa-b', 'Org B', 'Org B')
     on conflict (id) do nothing`,
    [ORG_A, ORG_B],
  );
  for (const [org, camp] of [
    [ORG_A, CAMPANHA_A],
    [ORG_B, CAMPANHA_B],
  ] as const) {
    await pool.query(
      `insert into prospecting_campaigns (id, organization_id, request_id, name, search)
       values ($1,$2,$3,'Campanha da fatia 3','{}'::jsonb) on conflict (id) do nothing`,
      [camp, org, randomUUID()],
    );
  }
  await pool.query("delete from prospecting_candidates where organization_id in ($1,$2)", [ORG_A, ORG_B]);
  await pool.query("delete from contacts where organization_id in ($1,$2)", [ORG_A, ORG_B]);
  await pool.query("delete from companies where organization_id in ($1,$2)", [ORG_A, ORG_B]);
  await ligarModulo();
  adm.client = meetPgSupabase(pool).client;
});

afterAll(async () => {
  await pool.query("delete from platform_config where chave = 'MODULO_CRM_B2B'");
  await pool.end();
});

function cliente() {
  return adm.client as Parameters<typeof transformarContatoEmEmpresaHandler>[0];
}

describe("transformar o contato da prospecção em Empresa (#3198, fatia 3)", () => {
  it("1. cria a Empresa com site, Maps, place_id e endereço em colunas, e liga o contato", async () => {
    const contato = await semearContato(ORG_A, CAMPANHA_A);
    await semearCandidato(ORG_A, CAMPANHA_A, contato);

    const r = await transformarContatoEmEmpresaHandler(cliente(), ctx(ORG_A), ATOR, contato);
    expect(r.criada).toBe(true);

    const { rows } = await pool.query(
      `select trade_name, website, maps_url, place_id, street, number, district, city, state, zip_code
         from companies where id = $1 and organization_id = $2`,
      [r.company_id, ORG_A],
    );
    expect(rows[0]).toEqual({
      trade_name: "Padaria Fatia 3",
      website: "https://padaria-fatia3.example.test",
      maps_url: `https://maps.example.test/?q=${PLACE}`,
      place_id: PLACE,
      street: "R. Augusta",
      number: "1234",
      district: "Consolação",
      city: "São Paulo",
      state: "SP",
      zip_code: "01304-001",
    });
    const c = await pool.query("select company_id from contacts where id = $1", [contato]);
    expect(c.rows[0].company_id).toBe(r.company_id);
    // Sem pessoa sintética: o vínculo é com a Empresa.
    expect(await conta("select count(*) as n from people where organization_id = $1", [ORG_A])).toBe(0);
  });

  it("2. o segundo clique é recusado (409) e não duplica a Empresa", async () => {
    const contato = await semearContato(ORG_A, CAMPANHA_A);
    await semearCandidato(ORG_A, CAMPANHA_A, contato);
    await transformarContatoEmEmpresaHandler(cliente(), ctx(ORG_A), ATOR, contato);

    await expect(
      transformarContatoEmEmpresaHandler(cliente(), ctx(ORG_A), ATOR, contato),
    ).rejects.toMatchObject({ status: 409 });
    expect(await conta("select count(*) as n from companies where organization_id = $1", [ORG_A])).toBe(1);
  });

  it("3. a mesma loja do Maps em duas organizações vira duas Empresas, cada uma na sua", async () => {
    const a = await semearContato(ORG_A, CAMPANHA_A);
    await semearCandidato(ORG_A, CAMPANHA_A, a);
    const b = await semearContato(ORG_B, CAMPANHA_B);
    await semearCandidato(ORG_B, CAMPANHA_B, b);

    const ra = await transformarContatoEmEmpresaHandler(cliente(), ctx(ORG_A), ATOR, a);
    const rb = await transformarContatoEmEmpresaHandler(cliente(), ctx(ORG_B), ATOR, b);

    expect(ra.company_id).not.toBe(rb.company_id);
    expect(await conta("select count(*) as n from companies where organization_id = $1", [ORG_A])).toBe(1);
    expect(await conta("select count(*) as n from companies where organization_id = $1", [ORG_B])).toBe(1);
    const cb = await pool.query("select company_id from contacts where id = $1", [b]);
    expect(cb.rows[0].company_id).toBe(rb.company_id);
  });

  it("4. contato de outra organização é 404 e nada é escrito", async () => {
    const contatoDeA = await semearContato(ORG_A, CAMPANHA_A);
    await semearCandidato(ORG_A, CAMPANHA_A, contatoDeA);

    await expect(
      transformarContatoEmEmpresaHandler(cliente(), ctx(ORG_B), ATOR, contatoDeA),
    ).rejects.toMatchObject({ status: 404 });
    expect(await conta("select count(*) as n from companies", [])).toBe(0);
    const c = await pool.query("select company_id from contacts where id = $1", [contatoDeA]);
    expect(c.rows[0].company_id).toBeNull();
  });

  it("5. não sobrescreve o endereço que a equipe já digitou na Empresa do mesmo place_id", async () => {
    await pool.query(
      `insert into companies (id, organization_id, trade_name, place_id, street, city)
       values ($1,$2,'Padaria já cadastrada',$3,'Rua Digitada à Mão','Campinas')`,
      [randomUUID(), ORG_A, PLACE],
    );
    const contato = await semearContato(ORG_A, CAMPANHA_A);
    await semearCandidato(ORG_A, CAMPANHA_A, contato);

    const r = await transformarContatoEmEmpresaHandler(cliente(), ctx(ORG_A), ATOR, contato);
    expect(r.criada).toBe(false);
    const { rows } = await pool.query(
      "select street, city, number, state from companies where id = $1",
      [r.company_id],
    );
    expect(rows[0]).toEqual({ street: "Rua Digitada à Mão", city: "Campinas", number: "1234", state: "SP" });
  });

  it("6. vencida a poda, a Empresa nasce só com o que o contato guardou", async () => {
    const contato = await semearContato(ORG_A, CAMPANHA_A);
    // Nenhuma linha em prospecting_candidates: a poda de 365 dias já a apagou.

    const r = await transformarContatoEmEmpresaHandler(cliente(), ctx(ORG_A), ATOR, contato);
    const { rows } = await pool.query(
      "select trade_name, website, maps_url, place_id, street, city from companies where id = $1",
      [r.company_id],
    );
    expect(rows[0]).toEqual({
      trade_name: "Padaria Fatia 3",
      website: null,
      maps_url: `https://maps.example.test/?q=${PLACE}`,
      place_id: PLACE,
      street: null,
      city: null,
    });
  });
});
