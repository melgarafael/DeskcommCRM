/**
 * ESPECIALISTA DE ROTEADOR PUBLICADO SEM NÚMERO NÃO ATENDE PELO NÚMERO — E SÓ
 * PUBLICA PELO ROTEADOR DA PRÓPRIA EMPRESA.
 *
 * A 0741 (#3284) deixou `fn_publish_ai_agent_version` publicar versão com
 * `channel_session_id` nulo quando o agente é membro de um roteador cujo canal
 * está WORKING, com o roteador ainda inativo. Duas perguntas ficam, e este
 * arquivo cobra as duas no banco de verdade:
 *
 * 1. Publicado e com o roteador inativo, o especialista disputa o número com o
 *    agente que já atende nele? Não: a seleção por número
 *    (`loadPublishedAgentConfig`) exige `v.channel_session_id = canal`, e o
 *    roteador só entra no turno quando ativo (`loadActiveRouter`).
 *
 * 2. `ai_router_members.router_id` é FK simples: uma linha de membro da empresa
 *    A pode apontar para um roteador da empresa B. O único guarda é o filtro
 *    `r.organization_id = p_org_id` no join da função. O caso "roteador de B
 *    sobre um canal de A" é o que só esse filtro barra — sem ele, o canal
 *    encontrado é de A, passa na conferência de organização do canal e publica.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, it, expect } from "vitest";
import { seedGov } from "./gov-helpers";
import { replyFixture } from "../support/autonomia-fixture";
import { loadPublishedAgentConfig } from "@/lib/agent-engine/agent/agent-config";
import { loadActiveRouter } from "@/lib/agent-engine/agent/router-config";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 5,
});

beforeAll(() => seedGov());
afterAll(() => pool.end());

/** Especialista com UM rascunho sem número, numa empresa que já tem um agente no ar no canal. */
async function especialistaSemNumero(org: string) {
  const modelo = (
    await pool.query(
      "select model_id from ai_models where provider='anthropic' and deprecated_at is null order by model_id limit 1",
    )
  ).rows[0]?.model_id as string | undefined;
  expect(modelo, "catálogo `ai_models` sem modelo anthropic vivo no baseline").toBeTruthy();

  const agent = randomUUID();
  const version = randomUUID();
  await pool.query(
    "insert into ai_agents(id,organization_id,name,system_prompt) values($1,$2,$3,'Especialista.')",
    [agent, org, `Especialista ${agent}`],
  );
  await pool.query(
    `insert into ai_agent_versions
       (id,organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status)
     values ($1,$2,$3,1,'Especialista.','anthropic',$4,null,'draft')`,
    [version, org, agent, modelo],
  );
  return { agent, version };
}

async function membro(org: string, router: string, agent: string) {
  await pool.query(
    "insert into ai_router_members(organization_id,router_id,agent_id,intent_name,intent_description) values($1,$2,$3,$4,'Intenção')",
    [org, router, agent, `intencao-${randomUUID()}`],
  );
}

it("publicado com o roteador inativo, o especialista não é escolhido pelo número — quem atende segue sendo o agente do canal", async () => {
  const f = await replyFixture(pool);
  await pool.query("update channel_sessions set status='WORKING' where id=$1", [f.channel]);
  const esp = await especialistaSemNumero(f.org);
  const router = randomUUID();
  await pool.query(
    "insert into ai_routers(id,organization_id,name,channel_session_id,is_active) values($1,$2,$3,$4,false)",
    [router, f.org, `Roteador ${router}`, f.channel],
  );
  await membro(f.org, router, esp.agent);

  const publicada = (
    await pool.query("select * from fn_publish_ai_agent_version($1,$2,$3,true)", [
      f.org,
      esp.agent,
      esp.version,
    ])
  ).rows[0];
  // Controle positivo: sem a publicação, o caso abaixo seria verde por vacuidade.
  expect(publicada.version_id).toBe(esp.version);

  const doNumero = await loadPublishedAgentConfig(pool, f.org, f.channel);
  expect(doNumero?.agentId).toBe(f.agent);
  expect(await loadActiveRouter(pool, f.org, f.channel)).toBeNull();

  // Sem o agente do canal, a seleção por número devolve NADA — nunca o especialista.
  await pool.query("update ai_agents set archived_at=now() where id=$1", [f.agent]);
  expect(await loadPublishedAgentConfig(pool, f.org, f.channel)).toBeNull();
});

it("membro da empresa A apontando para roteador da empresa B sobre um canal de A NÃO publica", async () => {
  const a = await replyFixture(pool);
  const b = await replyFixture(pool);
  await pool.query("update channel_sessions set status='WORKING' where id=$1", [a.channel]);
  const esp = await especialistaSemNumero(a.org);
  const routerDeB = randomUUID();
  await pool.query(
    "insert into ai_routers(id,organization_id,name,channel_session_id,is_active) values($1,$2,$3,$4,false)",
    [routerDeB, b.org, `Roteador ${routerDeB}`, a.channel],
  );
  await membro(a.org, routerDeB, esp.agent);

  await expect(
    pool.query("select * from fn_publish_ai_agent_version($1,$2,$3,true)", [
      a.org,
      esp.agent,
      esp.version,
    ]),
  ).rejects.toThrow("channel_session_not_found");
  const depois = (
    await pool.query(
      "select a.published_version_id, v.status from ai_agents a join ai_agent_versions v on v.id=$2 where a.id=$1",
      [esp.agent, esp.version],
    )
  ).rows[0];
  expect(depois).toMatchObject({ published_version_id: null, status: "draft" });
});

it("membro da empresa A apontando para roteador da empresa B com canal WORKING de B NÃO publica", async () => {
  const a = await replyFixture(pool);
  const b = await replyFixture(pool);
  await pool.query("update channel_sessions set status='WORKING' where id=$1", [b.channel]);
  const esp = await especialistaSemNumero(a.org);
  const routerDeB = randomUUID();
  await pool.query(
    "insert into ai_routers(id,organization_id,name,channel_session_id,is_active) values($1,$2,$3,$4,false)",
    [routerDeB, b.org, `Roteador ${routerDeB}`, b.channel],
  );
  await membro(a.org, routerDeB, esp.agent);

  await expect(
    pool.query("select * from fn_publish_ai_agent_version($1,$2,$3,true)", [
      a.org,
      esp.agent,
      esp.version,
    ]),
  ).rejects.toThrow("channel_session_not_found");
});
