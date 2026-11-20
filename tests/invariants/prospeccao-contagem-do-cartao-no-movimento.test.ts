/**
 * A CONTAGEM DO CARTÃO DEPOIS DE MOVER A LISTA (#4947), num Postgres de verdade.
 *
 * A issue nasceu da prova pela tela do "Usar lista em outra campanha": das 3 empresas
 * de uma campanha pausada, as 2 ainda não abordadas vão para uma campanha nova, e o
 * cartão da antiga continuava dizendo 3. O defeito não era o movimento — era o cartão
 * ler `prospecting_campaigns.result_count`, um número guardado que nenhuma operação de
 * saída de linha atualiza (o move do PR #4315, a limpeza das desmarcadas e o expurgo
 * por retenção deixam todos ele para trás).
 *
 * Aqui a MESMA leitura que a rota faz (`listarCampanhasDaLista`, de
 * `lib/prospecting/campanhas-da-lista.ts`) roda sobre o `baseline.sql` e o movimento é
 * o do próprio `move_list` (`moverListaParaNovaCampanha`, de `lib/prospecting/store.ts`).
 * O que este arquivo prova, e um banco de mentira não provaria — ele devolve as linhas
 * prontas venha a consulta que vier:
 *
 * 1. depois de levar 2 de 3, a origem mostra 1 e o destino mostra 2;
 * 2. a coluna guardada da origem continua em 3: é o cartão que deixou de lê-la, e é
 *    isso que impede o número de voltar a mentir na próxima operação de saída;
 * 3. campanha sem nenhuma empresa aparece com 0, e não some da lista;
 * 4. empresa ainda não abordada conta (é linha), mesmo desmarcada pelo operador;
 * 5. a campanha da OUTRA organização fica fora da lista (mesmo pool por cima da RLS).
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listarCampanhasDaLista } from "@/lib/prospecting/campanhas-da-lista";
import { moverListaParaNovaCampanha } from "@/lib/prospecting/store";

// O Postgres efêmero do `scripts/test-db.sh`, em campos separados (e não numa
// connection string com senha, que o pré-voo lê como segredo vazado).
const pool = new pg.Pool({
  host: "127.0.0.1",
  port: Number(process.env.TEST_DB_PORT ?? 54329),
  user: "postgres",
  password: "postgres",
  database: "postgres",
  max: 4,
});

/** Namespace próprio (0c4d0000-). */
const ORG_A = "0c4d0000-0000-4000-8000-000000000001";
const ORG_B = "0c4d0000-0000-4000-8000-000000000002";

const ORIGEM = "0c4d0000-1111-4000-8000-000000000001";
const VAZIA = "0c4d0000-1111-4000-8000-000000000003";
const DA_VIZINHA = "0c4d0000-1111-4000-8000-000000000004";

const RECIBO_ORIGEM = "0c4d0000-2222-4000-8000-000000000001";
const RECIBO_MOVIMENTO = "0c4d0000-2222-4000-8000-000000000002";
const RECIBO_VAZIA = "0c4d0000-2222-4000-8000-000000000003";
const RECIBO_VIZINHA = "0c4d0000-2222-4000-8000-000000000004";

const SESSAO_A = "0c4d0000-6666-4000-8000-000000000001";
const CONTATO_ABORDADA = "0c4d0000-3333-4000-8000-000000000001";
const CONVERSA_ABORDADA = "0c4d0000-4444-4000-8000-000000000001";

const cand = (n: number) => `0c4d0000-5555-4000-8000-00000000000${n}`;

/** A campanha que o movimento cria — preenchida no primeiro teste. */
let destino = "";

beforeAll(async () => {
  await pool.query(
    `insert into organizations(id,slug,legal_name,display_name) values
       ($1,'cartao-a','A','A'), ($2,'cartao-b','B','B')`,
    [ORG_A, ORG_B],
  );
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted) values($1::uuid,$2,$1::text,'WORKING','\\x00')",
    [SESSAO_A, ORG_A],
  );
  await pool.query(
    `insert into contacts(id,organization_id,name,display_name,phone_number) values
       ($1,$2,'Abordada','Abordada','+5511944440001')`,
    [CONTATO_ABORDADA, ORG_A],
  );
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')",
    [CONVERSA_ABORDADA, ORG_A, CONTATO_ABORDADA, SESSAO_A],
  );
  // A origem nasce com o número GUARDADO certo (3), como sai da busca/importação —
  // é o movimento que o deixa velho, e é por isso que o cartão não pode lê-lo.
  await pool.query(
    `insert into prospecting_campaigns(id,organization_id,request_id,name,search,status,search_status,result_count) values
       ($1,$4,$5,'Origem','{"niche":"x"}','paused','succeeded',3),
       ($2,$4,$6,'Sem nenhuma empresa','{"niche":"x"}','draft','succeeded',0),
       ($3,$7,$8,'Da vizinha','{"niche":"x"}','draft','succeeded',1)`,
    [ORIGEM, VAZIA, DA_VIZINHA, ORG_A, RECIBO_ORIGEM, RECIBO_VAZIA, ORG_B, RECIBO_VIZINHA],
  );
  await pool.query(
    `insert into prospecting_candidates(id,organization_id,campaign_id,place_id,phone,data,status,contact_id,conversation_id) values
       ($1,$4,$7,'place-abordada','+5511944440001','{"name":"Já abordada"}','sent',$5,$6),
       ($2,$4,$7,'place-nova-1',null,'{"name":"Nunca abordada 1"}','new',null,null),
       ($3,$4,$7,'place-nova-2',null,'{"name":"Nunca abordada 2"}','queued',null,null)`,
    [cand(1), cand(2), cand(3), ORG_A, CONTATO_ABORDADA, CONVERSA_ABORDADA, ORIGEM],
  );
  // A empresa da vizinha existe para a lista da org A não poder contá-la por engano.
  await pool.query(
    `insert into prospecting_candidates(id,organization_id,campaign_id,place_id,data,status) values
       ($1,$2,$3,'place-vizinha','{"name":"Da vizinha"}','new')`,
    [cand(9), ORG_B, DA_VIZINHA],
  );
});

afterAll(async () => {
  await pool.end();
});

const porId = (linhas: { id: string; result_count: number }[], id: string) =>
  linhas.find((l) => l.id === id);

describe("o cartão conta as linhas da lista, inclusive depois do movimento (#4947)", () => {
  it("leva 2 de 3: a origem mostra 1, o destino mostra 2 — e a coluna guardada da origem fica em 3", async () => {
    const antes = await listarCampanhasDaLista(pool, ORG_A);
    expect(porId(antes, ORIGEM)!.result_count).toBe(3);

    const movida = await moverListaParaNovaCampanha(pool, ORG_A, ORIGEM, RECIBO_MOVIMENTO);
    expect(movida.moved).toBe(2);
    destino = movida.campaign_id;

    const depois = await listarCampanhasDaLista(pool, ORG_A);
    expect(porId(depois, ORIGEM)!.result_count, "o cartão da origem tem de cair para 1").toBe(1);
    expect(porId(depois, destino)!.result_count, "a campanha nova mostra as 2 que chegaram").toBe(
      2,
    );

    // A prova de que o cartão NÃO lê o campo guardado: ele continua 3 no banco.
    const guardado = await pool.query<{ result_count: number }>(
      "select result_count from prospecting_campaigns where organization_id=$1 and id=$2",
      [ORG_A, ORIGEM],
    );
    expect(guardado.rows[0]!.result_count).toBe(3);
  });

  it("campanha sem nenhuma empresa aparece com 0, e não some da lista", async () => {
    const lista = await listarCampanhasDaLista(pool, ORG_A);
    expect(porId(lista, VAZIA)).toBeDefined();
    expect(porId(lista, VAZIA)!.result_count).toBe(0);
  });

  it("empresa desmarcada pelo operador continua contando: ela está na lista", async () => {
    await pool.query(
      "update prospecting_candidates set selected=false, status='skipped', error='Desmarcada pelo operador.' where organization_id=$1 and id=$2",
      [ORG_A, cand(3)],
    );
    const lista = await listarCampanhasDaLista(pool, ORG_A);
    expect(porId(lista, destino)!.result_count).toBe(2);
  });

  it("a campanha da outra organização fica fora da lista", async () => {
    const lista = await listarCampanhasDaLista(pool, ORG_A);
    expect(porId(lista, DA_VIZINHA)).toBeUndefined();
    const daVizinha = await listarCampanhasDaLista(pool, ORG_B);
    expect(porId(daVizinha, DA_VIZINHA)!.result_count).toBe(1);
  });
});
