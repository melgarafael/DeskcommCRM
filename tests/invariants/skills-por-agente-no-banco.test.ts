/**
 * SKILLS POR AGENTE NO BANCO (migration 9107), sobre o baseline instalado.
 *
 * Três propriedades, e cada uma tem um modo de falha próprio:
 *
 *  1. A coluna nasce NULL em toda versão, e o loader do motor devolve
 *     `skillNames: null` (todas) — o comportamento de antes. Isto também prova
 *     que o SELECT de `agent-config.ts`, que agora nomeia a coluna, roda contra o
 *     baseline: sem a coluna, todo turno falharia com 42703.
 *  2. A versão PUBLICADA não muda a lista: sem a linha no trigger
 *     `fn_ai_agent_version_content_immutable`, a service key reescreveria as
 *     skills de um agente no ar sem virar versão nova e sem trilha.
 *  3. O caminho certo continua: rascunho com lista própria publica, e o loader
 *     devolve a lista.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";

import { seedGov } from "./gov-helpers";
import { replyFixture } from "../support/autonomia-fixture";
import { loadAgentVersionConfig } from "@/lib/agent-engine/agent/agent-config";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

beforeAll(() => seedGov());
afterAll(() => pool.end());

async function skillsDaVersao(id: string) {
  return (
    await pool.query<{ status: string; skill_names: string[] | null }>(
      "select status, skill_names from ai_agent_versions where id=$1",
      [id],
    )
  ).rows[0]!;
}

it("versão existente nasce com skill_names NULL e o loader do motor a lê como 'todas'", async () => {
  const f = await replyFixture(pool);
  expect(await skillsDaVersao(f.version)).toEqual({ status: "published", skill_names: null });
  const config = await loadAgentVersionConfig(pool, f.org, f.agent, f.version);
  expect(config?.skillNames).toBeNull();
});

it("versão PUBLICADA recusa mudar a lista de skills, e o valor fica igual", async () => {
  const f = await replyFixture(pool);
  await expect(
    pool.query("update ai_agent_versions set skill_names = '{agendamento}' where id = $1", [f.version]),
  ).rejects.toThrow(/imutável/);
  expect(await skillsDaVersao(f.version)).toEqual({ status: "published", skill_names: null });
});

it("rascunho com lista própria publica, e o loader devolve a lista", async () => {
  const f = await replyFixture(pool);
  await pool.query("update channel_sessions set status='WORKING' where id=$1", [f.channel]);
  // O publicar confere o modelo no catálogo: a credencial própria com o modelo
  // declarado é o caminho que já passa (o mesmo de trava-da-versao-publicada-…).
  const credencial = randomUUID();
  await pool.query(
    `insert into ai_provider_credentials
       (id, organization_id, provider, label, api_key_encrypted, api_key_iv, api_key_tag,
        api_key_last4, validated_at, models_available, base_url)
     values ($1,$2,'custom','Ollama','\\x01'::bytea,'\\x02'::bytea,'\\x03'::bytea,
             '4242', now(), $3, 'https://ollama.example/v1')`,
    [credencial, f.org, ["qwen3:14b"]],
  );
  const rascunho = randomUUID();
  await pool.query(
    `insert into ai_agent_versions
       (id,organization_id,agent_id,version_number,system_prompt,provider,model,credential_id,channel_session_id,status)
     values ($1,$2,$3,2,'Atenda quem chegar.','custom','qwen3:14b',$4,$5,'draft')`,
    [rascunho, f.org, f.agent, credencial, f.channel],
  );
  // Rascunho é editável — inclusive voltar a lista para vazia (nenhuma skill).
  await pool.query("update ai_agent_versions set skill_names = '{}' where id = $1", [rascunho]);
  await pool.query("update ai_agent_versions set skill_names = '{agendamento}' where id = $1", [rascunho]);
  await pool.query("select * from fn_publish_ai_agent_version($1,$2,$3,false)", [f.org, f.agent, rascunho]);

  expect(await skillsDaVersao(rascunho)).toEqual({ status: "published", skill_names: ["agendamento"] });
  const config = await loadAgentVersionConfig(pool, f.org, f.agent, rascunho);
  expect(config?.skillNames).toEqual(["agendamento"]);
});
