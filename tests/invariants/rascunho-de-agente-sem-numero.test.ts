/**
 * O RASCUNHO DE AGENTE PODE NASCER SEM NÚMERO — E CONTINUA SEM PODER ATENDER.
 *
 * A migration 0239 tirou o `not null` de `ai_agent_versions.channel_session_id`
 * porque numa instalação nova não existe UMA linha em `channel_sessions` (o
 * aparelho é pareado outro dia, com o celular na mão) e o editor exigia o número
 * para SALVAR — o dono escrevia o prompt do atendente e não conseguia guardá-lo.
 *
 * Afrouxar uma restrição é a mudança de schema mais fácil de fazer e a mais fácil
 * de fazer errado: a pergunta que fica é se o que a restrição PROTEGIA continua
 * protegido por outra coisa. A prosa da migration afirma que sim, e nomeia quem
 * protege — `fn_publish_ai_agent_version`, que procura o canal por
 * `where s.id = v_version.channel_session_id` e levanta `channel_session_not_found`
 * quando não acha linha (um id nulo não acha nenhuma).
 *
 * Este arquivo cobra essa afirmação no banco de verdade, nos dois sentidos: o
 * nulo ENTRA como rascunho, o nulo NÃO PUBLICA, e escolher o número depois
 * publica a MESMA versão — o rascunho sem número é um estado de espera, não um
 * beco sem saída.
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

/**
 * Um agente sem nenhuma versão publicada e com UM rascunho cujo número está em
 * branco — o retrato de quem acabou de instalar e ainda não pareou o WhatsApp.
 */
async function rascunhoSemNumero() {
  const f = await replyFixture(pool);
  await pool.query("update ai_agents set published_version_id=null where id=$1", [f.agent]);
  await pool.query("delete from ai_agent_versions where agent_id=$1", [f.agent]);

  // O modelo sai do catálogo do próprio baseline: publicar confere
  // `ai_models`, e um id inventado reprovaria por `model_not_found` — um verde
  // (ou um vermelho) que não fala do número.
  const modelo = (
    await pool.query(
      "select model_id from ai_models where provider='anthropic' and deprecated_at is null order by model_id limit 1",
    )
  ).rows[0]?.model_id as string | undefined;
  expect(modelo, "catálogo `ai_models` sem modelo anthropic vivo no baseline").toBeTruthy();

  const version = randomUUID();
  await pool.query(
    `insert into ai_agent_versions
       (id,organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status)
     values ($1,$2,$3,1,'Atenda quem chegar.','anthropic',$4,null,'draft')`,
    [version, f.org, f.agent, modelo],
  );
  return { ...f, version, modelo };
}

it("o rascunho ENTRA com o número em branco — era isto que o `not null` impedia", async () => {
  const f = await rascunhoSemNumero();
  const linha = (
    await pool.query(
      "select status, channel_session_id, system_prompt from ai_agent_versions where id=$1",
      [f.version],
    )
  ).rows[0];
  expect(linha.channel_session_id).toBeNull();
  expect(linha.status).toBe("draft");
  // O que o dono escreveu está guardado — o defeito de origem era exatamente
  // não conseguir guardar isto.
  expect(linha.system_prompt).toBe("Atenda quem chegar.");
});

it("publicar sem número é RECUSADO, e o agente não fica com versão publicada", async () => {
  const f = await rascunhoSemNumero();
  await expect(
    pool.query("select * from fn_publish_ai_agent_version($1,$2,$3,true)", [
      f.org,
      f.agent,
      f.version,
    ]),
  ).rejects.toThrow("channel_session_not_found");

  const depois = (
    await pool.query(
      `select a.published_version_id, v.status
         from ai_agents a join ai_agent_versions v on v.id=$2
        where a.id=$1`,
      [f.agent, f.version],
    )
  ).rows[0];
  expect(depois.published_version_id).toBeNull();
  expect(depois.status).toBe("draft");
});

it("escolhido o número e conectado, a MESMA versão publica — o rascunho é espera, não beco", async () => {
  const f = await rascunhoSemNumero();
  await pool.query("update channel_sessions set status='WORKING' where id=$1", [f.channel]);
  await pool.query("update ai_agent_versions set channel_session_id=$2 where id=$1", [
    f.version,
    f.channel,
  ]);

  const publicada = (
    await pool.query("select * from fn_publish_ai_agent_version($1,$2,$3,true)", [
      f.org,
      f.agent,
      f.version,
    ])
  ).rows[0];
  expect(publicada.version_id).toBe(f.version);

  const depois = (
    await pool.query(
      `select a.published_version_id, v.status
         from ai_agents a join ai_agent_versions v on v.id=$2
        where a.id=$1`,
      [f.agent, f.version],
    )
  ).rows[0];
  expect(depois.published_version_id).toBe(f.version);
  expect(depois.status).toBe("published");
});
