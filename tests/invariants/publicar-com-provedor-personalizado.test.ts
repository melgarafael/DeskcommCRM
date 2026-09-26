/**
 * AGENTE COM O PROVEDOR PERSONALIZADO PUBLICA — PELO QUE O PRÓPRIO ENDPOINT DEVOLVEU.
 *
 * A 0413 trouxe o "Provedor personalizado (compatível com OpenAI)", mas a
 * `fn_publish_ai_agent_version` conferia o modelo só no catálogo GLOBAL
 * `ai_models`, onde nada escreve linha `custom`. Medido numa VPS real: a
 * credencial validada, o rascunho com um modelo que o endpoint devolveu em
 * `/models`, e todo "Publicar" respondendo `model_not_found`.
 *
 * A 0418 confere, para `custom`, a lista gravada na credencial da versão
 * (`models_available`). Este arquivo cobra no banco de verdade os dois
 * sentidos: o modelo da lista PUBLICA; o que está fora dela, ou a versão
 * `custom` sem credencial própria, continua RECUSADO.
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

const MODELO_DO_ENDPOINT = "qwen3:14b";

/**
 * Um agente sem versão publicada, o canal conectado e UM rascunho `custom`.
 * `comCredencial=false` é a versão sem chave própria — que para um endpoint de
 * empresa não tem plataforma que a substitua.
 */
async function rascunhoCustom(modelo: string, comCredencial = true) {
  const f = await replyFixture(pool);
  await pool.query("update ai_agents set published_version_id=null where id=$1", [f.agent]);
  await pool.query("delete from ai_agent_versions where agent_id=$1", [f.agent]);
  await pool.query("update channel_sessions set status='WORKING' where id=$1", [f.channel]);

  let credential: string | null = null;
  if (comCredencial) {
    credential = randomUUID();
    await pool.query(
      `insert into ai_provider_credentials
         (id, organization_id, provider, label, api_key_encrypted, api_key_iv, api_key_tag,
          api_key_last4, validated_at, models_available, base_url)
       values ($1,$2,'custom','Ollama','\\x01'::bytea,'\\x02'::bytea,'\\x03'::bytea,
               '4242', now(), $3, 'https://ollama.example/v1')`,
      [credential, f.org, [MODELO_DO_ENDPOINT, "llama3.1:8b"]],
    );
  }

  const version = randomUUID();
  await pool.query(
    `insert into ai_agent_versions
       (id,organization_id,agent_id,version_number,system_prompt,provider,model,credential_id,channel_session_id,status)
     values ($1,$2,$3,1,'Atenda quem chegar.','custom',$4,$5,$6,'draft')`,
    [version, f.org, f.agent, modelo, credential, f.channel],
  );
  return { ...f, version };
}

async function estado(agent: string, version: string) {
  return (
    await pool.query(
      `select a.published_version_id, v.status
         from ai_agents a join ai_agent_versions v on v.id=$2
        where a.id=$1`,
      [agent, version],
    )
  ).rows[0] as { published_version_id: string | null; status: string };
}

it("o modelo que o endpoint devolveu em /models PUBLICA — era o que respondia model_not_found", async () => {
  const f = await rascunhoCustom(MODELO_DO_ENDPOINT);
  const publicada = (
    await pool.query("select * from fn_publish_ai_agent_version($1,$2,$3,false)", [
      f.org,
      f.agent,
      f.version,
    ])
  ).rows[0];
  expect(publicada.version_id).toBe(f.version);

  const depois = await estado(f.agent, f.version);
  expect(depois.published_version_id).toBe(f.version);
  expect(depois.status).toBe("published");
});

it("o modelo que o endpoint NÃO devolveu continua recusado, e nada é publicado", async () => {
  const f = await rascunhoCustom("modelo-que-o-endpoint-nao-tem");
  await expect(
    pool.query("select * from fn_publish_ai_agent_version($1,$2,$3,false)", [
      f.org,
      f.agent,
      f.version,
    ]),
  ).rejects.toThrow("model_not_found");

  const depois = await estado(f.agent, f.version);
  expect(depois.published_version_id).toBeNull();
  expect(depois.status).toBe("draft");
});

it("`custom` sem credencial própria é recusado mesmo com a chave de plataforma declarada", async () => {
  const f = await rascunhoCustom(MODELO_DO_ENDPOINT, false);
  await expect(
    pool.query("select * from fn_publish_ai_agent_version($1,$2,$3,true)", [
      f.org,
      f.agent,
      f.version,
    ]),
  ).rejects.toThrow("model_not_found");
  expect((await estado(f.agent, f.version)).published_version_id).toBeNull();
});

it("o catálogo `ai_models` não ganha linha `custom` — a lista é da empresa, não da instalação", async () => {
  await rascunhoCustom(MODELO_DO_ENDPOINT);
  const n = (
    await pool.query("select count(*)::int as n from ai_models where provider='custom'")
  ).rows[0].n;
  expect(n).toBe(0);
});
