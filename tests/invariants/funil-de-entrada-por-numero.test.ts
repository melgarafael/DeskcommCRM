import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { garantirLeadDaConversa } from "@/lib/leads/nascimento-do-lead";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * O FUNIL DE ENTRADA DO NÚMERO (migration 9430) — o caminho real.
 *
 * `funil-do-numero.test.ts` mede `funilDoNumero` com um dublê. Aqui roda
 * `garantirLeadDaConversa` contra o schema do baseline: é a LIGAÇÃO no ponto
 * de decisão que se prova (voltar o destino para `funilDeEntrada` deixa o
 * primeiro caso vermelho), e são as chaves compostas que se provam no banco:
 * o número não aponta para funil de outra empresa, a etapa fica presa ao
 * funil escolhido, e apagar funil ou etapa zera só o destino.
 *
 * Congela: (1) o número com escolha nasce no funil e na etapa escolhidos;
 * (2) o número sem escolha segue no funil padrão; (3) quem já é cliente
 * (cliente pela agenda) não obedece ao número; (4) funil arquivado cai no
 * padrão; (5) as chaves compostas recusam o que o handler recusa; (6) apagar
 * a etapa ou o funil zera só o destino.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});
const db = pgComoSupabase(pool);

const ORG = "9430f000-0000-4000-8000-000000000001";
const ORG_OUTRA = "9430f000-0000-4000-8000-000000000002";

let numeroAtacado: string;
let numeroVarejo: string;
let funilAtacado: string;
let etapaQualificado: string;
let funilDaOutra: string;
let etapaDaOutra: string;
let funilArquivado: string;

async function criarOrg(id: string, slug: string): Promise<void> {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, $2, 'Funil por número LTDA', 'Funil por número') on conflict (id) do nothing`,
    [id, slug],
  );
}

async function criarNumero(org: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into channel_sessions (organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, gen_random_uuid()::text, 'WORKING', decode('00','hex')) returning id`,
    [org],
  );
  return rows[0]!.id;
}

async function criarContato(nome: string, firstServiceAt: string | null = null): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, source, first_service_at)
     values ($1, $2, 'whatsapp', $3) returning id`,
    [ORG, nome, firstServiceAt],
  );
  return rows[0]!.id;
}

async function funilEEtapaDoLead(leadId: string) {
  const { rows } = await pool.query<{ pipeline_id: string; stage_id: string; is_default: boolean }>(
    `select l.pipeline_id, l.stage_id, p.is_default
       from crm_leads l join crm_pipelines p on p.id = l.pipeline_id
      where l.id = $1`,
    [leadId],
  );
  return rows[0]!;
}

async function nascer(contato: string, numero: string) {
  return garantirLeadDaConversa(db, {
    organizationId: ORG,
    contactId: contato,
    conversationId: "9430f000-0000-4000-8000-00000000c001",
    nomeDoContato: "Contato",
    channelSessionId: numero,
  });
}

async function codigoDoErro(sql: string, params: unknown[]): Promise<string | null> {
  try {
    await pool.query(sql, params);
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? "sem_codigo";
  }
}

beforeAll(async () => {
  await criarOrg(ORG, "org-funil-por-numero");
  await criarOrg(ORG_OUTRA, "org-funil-por-numero-outra");

  const { rows: funis } = await pool.query<{ id: string; slug: string }>(
    `insert into crm_pipelines (organization_id, name, slug, is_default, position, is_archived) values
       ($1, 'Atacado',   'atacado-9430',   false, 5000, false),
       ($1, 'Arquivado', 'arquivado-9430', false, 6000, true)
     returning id, slug`,
    [ORG],
  );
  funilAtacado = funis.find((f) => f.slug === "atacado-9430")!.id;
  funilArquivado = funis.find((f) => f.slug === "arquivado-9430")!.id;

  const { rows: etapas } = await pool.query<{ id: string; slug: string }>(
    `insert into crm_stages (organization_id, pipeline_id, name, slug, position, is_won, is_lost) values
       ($1, $2, 'Entrada do atacado', 'entrada-atacado-9430', 0, false, false),
       ($1, $2, 'Qualificado',        'qualificado-9430',     1, false, false),
       ($1, $3, 'Entrada arquivada',  'entrada-arq-9430',     0, false, false)
     returning id, slug`,
    [ORG, funilAtacado, funilArquivado],
  );
  etapaQualificado = etapas.find((e) => e.slug === "qualificado-9430")!.id;

  const { rows: daOutra } = await pool.query<{ pipeline_id: string; id: string }>(
    `select s.pipeline_id, s.id from crm_stages s
      where s.organization_id = $1 and s.is_won = false and s.is_lost = false
      order by s.position limit 1`,
    [ORG_OUTRA],
  );
  funilDaOutra = daOutra[0]!.pipeline_id;
  etapaDaOutra = daOutra[0]!.id;

  numeroAtacado = await criarNumero(ORG);
  numeroVarejo = await criarNumero(ORG);
  await pool.query(
    "update channel_sessions set entry_pipeline_id = $2, entry_stage_id = $3 where id = $1",
    [numeroAtacado, funilAtacado, etapaQualificado],
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where id = any($1::uuid[])", [[ORG, ORG_OUTRA]]);
  await pool.end();
});

describe("funil de entrada por número (migration 9430)", () => {
  it("o número com escolha: o negócio nasce no funil e na etapa escolhidos", async () => {
    const r = await nascer(await criarContato("Atacadista"), numeroAtacado);
    expect(r.criado, `esperava criar, veio ${JSON.stringify(r)}`).toBe(true);
    if (!r.criado) return;
    const lead = await funilEEtapaDoLead(r.leadId);
    expect(lead.pipeline_id).toBe(funilAtacado);
    expect(lead.stage_id).toBe(etapaQualificado);
  });

  it("o número sem escolha segue no funil padrão, como antes", async () => {
    const r = await nascer(await criarContato("Varejista"), numeroVarejo);
    expect(r.criado, `esperava criar, veio ${JSON.stringify(r)}`).toBe(true);
    if (!r.criado) return;
    expect((await funilEEtapaDoLead(r.leadId)).is_default).toBe(true);
  });

  it("quem já é cliente (pela agenda) não obedece ao número", async () => {
    await pool.query(
      `update organizations
          set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{crm}',
                coalesce(settings->'crm', '{}'::jsonb) || '{"cliente_pela_agenda": true}'::jsonb)
        where id = $1`,
      [ORG],
    );
    try {
      const r = await nascer(await criarContato("Cliente antigo", "2026-01-10T12:00:00Z"), numeroAtacado);
      expect(r.criado, `esperava criar, veio ${JSON.stringify(r)}`).toBe(true);
      if (!r.criado) return;
      expect((await funilEEtapaDoLead(r.leadId)).pipeline_id).not.toBe(funilAtacado);
    } finally {
      await pool.query(
        "update organizations set settings = settings #- '{crm,cliente_pela_agenda}' where id = $1",
        [ORG],
      );
    }
  });

  it("funil arquivado não vale mais: cai no padrão", async () => {
    const numero = await criarNumero(ORG);
    await pool.query("update channel_sessions set entry_pipeline_id = $2 where id = $1", [
      numero,
      funilArquivado,
    ]);
    const r = await nascer(await criarContato("Do arquivado"), numero);
    expect(r.criado, `esperava criar, veio ${JSON.stringify(r)}`).toBe(true);
    if (!r.criado) return;
    expect((await funilEEtapaDoLead(r.leadId)).is_default).toBe(true);
  });

  it("o banco recusa funil de outra empresa e etapa de outro funil", async () => {
    const numero = await criarNumero(ORG);
    expect(
      await codigoDoErro("update channel_sessions set entry_pipeline_id = $2 where id = $1", [
        numero,
        funilDaOutra,
      ]),
      "funil de OUTRA organização",
    ).toBe("23503");
    expect(
      await codigoDoErro(
        "update channel_sessions set entry_pipeline_id = $2, entry_stage_id = $3 where id = $1",
        [numero, funilAtacado, etapaDaOutra],
      ),
      "etapa de outra organização",
    ).toBe("23503");
    const { rows: padrao } = await pool.query<{ id: string }>(
      "select id from crm_pipelines where organization_id = $1 and is_default limit 1",
      [ORG],
    );
    expect(
      await codigoDoErro(
        "update channel_sessions set entry_pipeline_id = $2, entry_stage_id = $3 where id = $1",
        [numero, padrao[0]!.id, etapaQualificado],
      ),
      "etapa do atacado com o funil padrão",
    ).toBe("23503");
  });

  it("apagar a etapa zera só a etapa; apagar o funil zera o destino", async () => {
    const { rows: funis } = await pool.query<{ id: string }>(
      `insert into crm_pipelines (organization_id, name, slug, is_default, position)
       values ($1, 'Temporário', 'temporario-9430', false, 7000) returning id`,
      [ORG],
    );
    const funil = funis[0]!.id;
    const { rows: etapas } = await pool.query<{ id: string }>(
      `insert into crm_stages (organization_id, pipeline_id, name, slug, position, is_won, is_lost)
       values ($1, $2, 'Etapa temporária', 'etapa-temporaria-9430', 0, false, false) returning id`,
      [ORG, funil],
    );
    const numero = await criarNumero(ORG);
    await pool.query(
      "update channel_sessions set entry_pipeline_id = $2, entry_stage_id = $3 where id = $1",
      [numero, funil, etapas[0]!.id],
    );

    await pool.query("delete from crm_stages where id = $1", [etapas[0]!.id]);
    const depoisDaEtapa = await pool.query(
      "select organization_id, entry_pipeline_id, entry_stage_id from channel_sessions where id = $1",
      [numero],
    );
    expect(depoisDaEtapa.rows[0]).toMatchObject({
      organization_id: ORG,
      entry_pipeline_id: funil,
      entry_stage_id: null,
    });

    await pool.query("delete from crm_pipelines where id = $1", [funil]);
    const depoisDoFunil = await pool.query(
      "select organization_id, entry_pipeline_id from channel_sessions where id = $1",
      [numero],
    );
    expect(depoisDoFunil.rows[0]).toMatchObject({ organization_id: ORG, entry_pipeline_id: null });
  });
});
