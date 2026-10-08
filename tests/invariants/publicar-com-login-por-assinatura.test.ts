/**
 * AGENTE COM O LOGIN POR ASSINATURA PUBLICA — PELA LISTA DA PRÓPRIA EMPRESA (0592, #2456).
 *
 * A 0592 estende ao `openai-assinatura` a regra que a 0418 deu ao `custom`: o
 * modelo é conferido em `models_available` da credencial da versão, que é da
 * conta ChatGPT de UMA empresa — e não no catálogo global `ai_models`. O que
 * este arquivo cobra no banco de verdade é o isolamento: a lista de uma
 * empresa nunca autoriza a publicação de outra.
 *
 * Sabotagem que confirma: tirar `'openai-assinatura'` do `in (...)` da
 * função faz o primeiro caso cair em `model_not_found` (o catálogo global não
 * tem o modelo); tirar a conferência de organização da credencial deixa o
 * caso da credencial alheia publicar.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, it, expect } from "vitest";
import { seedGov } from "./gov-helpers";
import { replyFixture } from "../support/autonomia-fixture";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 5,
});

beforeAll(() => seedGov());
afterAll(() => pool.end());

const PROVEDOR = "openai-assinatura";
const MODELO_DA_CONTA = "gpt-modelo-so-desta-conta";

async function credencialDaAssinatura(org: string, modelos: string[]) {
  const id = randomUUID();
  await pool.query(
    `insert into ai_provider_credentials
       (id, organization_id, provider, label, api_key_encrypted, api_key_iv, api_key_tag,
        api_key_last4, validated_at, models_available)
     values ($1,$2,$3,'Assinatura do ChatGPT','\\x01'::bytea,'\\x02'::bytea,'\\x03'::bytea,
             '4242', now(), $4)`,
    [id, org, PROVEDOR, modelos],
  );
  return id;
}

/** Uma empresa com o canal conectado e UM rascunho `openai-assinatura`. */
async function rascunho(modelo: string, credencial: (org: string) => Promise<string | null>) {
  const f = await replyFixture(pool);
  await pool.query("update ai_agents set published_version_id=null where id=$1", [f.agent]);
  await pool.query("delete from ai_agent_versions where agent_id=$1", [f.agent]);
  await pool.query("update channel_sessions set status='WORKING' where id=$1", [f.channel]);
  const credential = await credencial(f.org);
  const version = randomUUID();
  await pool.query(
    `insert into ai_agent_versions
       (id,organization_id,agent_id,version_number,system_prompt,provider,model,credential_id,channel_session_id,status)
     values ($1,$2,$3,1,'Atenda quem chegar.',$4,$5,$6,$7,'draft')`,
    [version, f.org, f.agent, PROVEDOR, modelo, credential, f.channel],
  );
  return { ...f, version };
}

function publicar(f: { org: string; agent: string; version: string }, plataforma = false) {
  return pool.query("select * from fn_publish_ai_agent_version($1,$2,$3,$4)", [
    f.org,
    f.agent,
    f.version,
    plataforma,
  ]);
}

async function publicada(agent: string): Promise<string | null> {
  return (await pool.query("select published_version_id from ai_agents where id=$1", [agent])).rows[0]
    .published_version_id;
}

it("o modelo que a conta da empresa lista PUBLICA", async () => {
  const f = await rascunho(MODELO_DA_CONTA, (org) => credencialDaAssinatura(org, [MODELO_DA_CONTA]));
  const r = (await publicar(f)).rows[0];
  expect(r.version_id).toBe(f.version);
  expect(await publicada(f.agent)).toBe(f.version);
});

it("o modelo que só a conta de OUTRA empresa lista é recusado", async () => {
  const outra = await replyFixture(pool);
  await credencialDaAssinatura(outra.org, [MODELO_DA_CONTA]);
  const f = await rascunho(MODELO_DA_CONTA, (org) => credencialDaAssinatura(org, ["outro-modelo"]));
  await expect(publicar(f)).rejects.toThrow("model_not_found");
  expect(await publicada(f.agent)).toBeNull();
});

it("versão apontando para a credencial de OUTRA empresa é recusada, mesmo com o modelo na lista dela", async () => {
  const outra = await replyFixture(pool);
  const alheia = await credencialDaAssinatura(outra.org, [MODELO_DA_CONTA]);
  const f = await rascunho(MODELO_DA_CONTA, async () => alheia);
  await expect(publicar(f)).rejects.toThrow("credential_not_found");
  expect(await publicada(f.agent)).toBeNull();
});

it("sem credencial própria é recusado, mesmo com a chave de plataforma declarada", async () => {
  const f = await rascunho(MODELO_DA_CONTA, async () => null);
  await expect(publicar(f, true)).rejects.toThrow("model_not_found");
  expect(await publicada(f.agent)).toBeNull();
});

it("o catálogo global `ai_models` não ganha linha da assinatura", async () => {
  await rascunho(MODELO_DA_CONTA, (org) => credencialDaAssinatura(org, [MODELO_DA_CONTA]));
  const n = (await pool.query("select count(*)::int as n from ai_models where provider=$1", [PROVEDOR])).rows[0].n;
  expect(n).toBe(0);
});
