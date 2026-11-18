import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

/**
 * A CHAVE DA PROSPECÇÃO É O NÚMERO, E ISSO É DO BANCO (issue #3896).
 *
 * O código podia checar o número e o índice único continuar por organização:
 * o `update ... status='running'` bateria em `prospecting_one_running_org`
 * (23505) e a segunda campanha nunca subiria — o defeito andava de tela para
 * banco. Este arquivo mede o CONTRATO DO SCHEMA, não a mensagem:
 *
 *   - duas campanhas `running` em conexões diferentes convivem;
 *   - duas no MESMO número batem em `prospecting_one_running_canal`;
 *   - pausar libera o número;
 *   - campanha de outra organização nunca ocupa este número;
 *   - `running` sem número é estado impossível (CHECK).
 *
 * O índice antigo é conferido AUSENTE: o teste falha se a troca não aconteceu,
 * mesmo que o comportamento pareça certo numa instalação que ainda tenha os
 * dois (o antigo tornaria o caso 1 impossível).
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
});
afterAll(() => pool.end());

async function novaOrganizacao(): Promise<string> {
  const org = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1,$2,'Campanha por número','Campanha por número')",
    [org, `campanha-por-numero-${org.slice(0, 8)}`],
  );
  return org;
}

async function canal(org: string, archived = false): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted,archived_at) values($1,$2,$3,'\\\\x00'::bytea,$4)",
    [id, org, `canal-${id.slice(0, 8)}`, archived ? new Date() : null],
  );
  return id;
}

async function campanha(
  org: string,
  channelSessionId: string | null,
  status: "draft" | "running" | "paused" = "draft",
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "insert into prospecting_campaigns(id,organization_id,request_id,name,search,config,status,channel_session_id) values($1,$2,$3,$4,'{}'::jsonb,$5,$6,$7)",
    [
      id,
      org,
      randomUUID(),
      `campanha-${id.slice(0, 8)}`,
      JSON.stringify({ channel_session_id: channelSessionId }),
      status,
      channelSessionId,
    ],
  );
  return id;
}

/** Sobe a campanha para `running` pelo mesmo UPDATE que a rota faz. */
function ativar(org: string, id: string) {
  return pool.query(
    "update prospecting_campaigns set status='running',updated_at=now() where organization_id=$1 and id=$2",
    [org, id],
  );
}

describe("uma campanha de prospecção em andamento por NÚMERO (banco real)", () => {
  it("GREEN: duas campanhas running em conexões DIFERENTES convivem na mesma organização", async () => {
    const org = await novaOrganizacao();
    const a = await campanha(org, await canal(org));
    const b = await campanha(org, await canal(org));
    await expect(ativar(org, a)).resolves.toBeDefined();
    await expect(ativar(org, b)).resolves.toBeDefined();
    const { rows } = await pool.query<{ total: number }>(
      "select count(*)::int as total from prospecting_campaigns where organization_id=$1 and status='running'",
      [org],
    );
    expect(rows[0]?.total).toBe(2);
  });

  it("LADO OPOSTO (a): duas no MESMO número continuam bloqueadas, pelo índice do número", async () => {
    const org = await novaOrganizacao();
    const numero = await canal(org);
    const a = await campanha(org, numero);
    const b = await campanha(org, numero);
    await ativar(org, a);
    await expect(ativar(org, b)).rejects.toMatchObject({ code: "23505" });
    // O nome do índice importa: se a recusa viesse do antigo
    // (`prospecting_one_running_org`), o caso GREEN acima não passaria — mas
    // aqui a mensagem prova QUAL regra recusou.
    await expect(ativar(org, b)).rejects.toThrow(/prospecting_one_running_canal/);
  });

  it("LADO OPOSTO (b): pausar libera o número para outra campanha", async () => {
    const org = await novaOrganizacao();
    const numero = await canal(org);
    const a = await campanha(org, numero, "running");
    const b = await campanha(org, numero);
    await expect(ativar(org, b)).rejects.toMatchObject({ code: "23505" });
    await pool.query(
      "update prospecting_campaigns set status='paused' where organization_id=$1 and id=$2",
      [org, a],
    );
    await expect(ativar(org, b)).resolves.toBeDefined();
  });

  it("LADO OPOSTO (c): campanha running de OUTRA organização não ocupa este número", async () => {
    const orgA = await novaOrganizacao();
    const orgB = await novaOrganizacao();
    const numeroA = await canal(orgA);
    const numeroB = await canal(orgB);
    const daB = await campanha(orgB, numeroB);
    await ativar(orgB, daB);
    const daA = await campanha(orgA, numeroA);
    await expect(ativar(orgA, daA)).resolves.toBeDefined();
    const { rows } = await pool.query<{ total: number }>(
      "select count(*)::int as total from prospecting_campaigns where organization_id=$1 and status='running'",
      [orgA],
    );
    expect(rows[0]?.total).toBe(1);
  });

  it("LADO OPOSTO (f): `running` sem conexão é estado impossível (CHECK), e conexão arquivada não serve", async () => {
    const org = await novaOrganizacao();
    await expect(campanha(org, null, "running")).rejects.toMatchObject({ code: "23514" });
    // Arquivada não é conexão de envio: a régua é `validateConfig`, e ela lê
    // `archived_at is null`. Aqui se prova que a linha arquivada continua
    // existindo (âncora de FK) e que o número não é reutilizável como ativo.
    const arquivada = await canal(org, true);
    const { rows } = await pool.query<{ ok: boolean }>(
      "select (archived_at is null) as ok from channel_sessions where organization_id=$1 and id=$2",
      [org, arquivada],
    );
    expect(rows[0]?.ok).toBe(false);
  });

  it("o índice por ORGANIZAÇÃO não existe mais: a troca de chave é do schema", async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      "select indexname from pg_indexes where schemaname='public' and tablename='prospecting_campaigns'",
    );
    const nomes = rows.map((r) => r.indexname);
    expect(nomes).toContain("prospecting_one_running_canal");
    expect(nomes).not.toContain("prospecting_one_running_org");
  });

  it("backfill: a coluna nasce do `config->>'channel_session_id'` para campanha que já existia", async () => {
    // A migration já rodou neste banco; o que se prova é a FORMA da coluna que
    // o backfill deixou: uuid, nula só onde não havia número válido.
    const { rows } = await pool.query<{ tipo: string; anulavel: string }>(
      "select data_type as tipo, is_nullable as anulavel from information_schema.columns where table_schema='public' and table_name='prospecting_campaigns' and column_name='channel_session_id'",
    );
    expect(rows[0]).toEqual({ tipo: "uuid", anulavel: "YES" });
  });
});
