/**
 * A PROSPECÇÃO CRIA A EMPRESA DO MÓDULO "EMPRESAS E PESSOAS" — issue #3198,
 * fatia 2, com o desenho FECHADO pelo autor (@paulolimajr77) em 16/11.
 *
 * As três decisões que estes casos medem:
 *
 * 1. o telefone do Google é da RECEPÇÃO: o contato aponta para a EMPRESA
 *    (`contacts.company_id`), e não existe pessoa sintética "Recepção";
 * 2. na Empresa mora só o que NÃO muda do Maps (`website`, `maps_url`,
 *    `place_id`); nota, avaliações e categoria continuam em
 *    `prospecting_candidates.data`;
 * 3. com o módulo DESLIGADO a prospecção segue como hoje — nenhuma escrita em
 *    `companies`.
 *
 * O que roda de verdade aqui: o código de produto (`empresaDoCandidato` e
 * `ligarContatoAEmpresa`, os dois chamados por `criarPegadaDoCandidato`), o
 * gatilho `trg_contacts_company_same_org`, o índice único
 * `companies_org_place_id_uidx` e a função de expurgo da 0408.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  empresaDoCandidato,
  ligarContatoAEmpresa,
} from "../../lib/prospecting/empresa-do-candidato";
import { meetPgSupabase } from "../support/meet-pg-supabase";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const ORG_A = "31980000-0000-4000-8000-00000000000a";
const ORG_B = "31980000-0000-4000-8000-00000000000b";
const CAMPANHA = "31980000-1111-4000-8000-000000000001";

/** O negócio como o Maps entrega — só os campos que a Empresa recebe. */
function negocio(placeId: string, extra: Record<string, unknown> = {}) {
  return {
    key: placeId,
    name: `Padaria ${placeId}`,
    phone: "+5511999990000",
    website: `https://${placeId}.example.test`,
    maps_url: `https://maps.example.test/?q=${placeId}`,
    category: "Padaria",
    address: "Rua do Maps, 100",
    rating: 4.6,
    reviews: 128,
    emails: ["contato@padaria.example.test"],
    socials: [],
    ...extra,
  };
}

async function semearCandidato(opts: {
  id: string;
  placeId: string;
  idadeDias?: number;
  status?: string;
}): Promise<void> {
  const idade = opts.idadeDias ?? 0;
  await pool.query(
    `insert into prospecting_candidates (
       id, organization_id, campaign_id, place_id, phone, data, status,
       attempted_at, created_at
     ) values ($1,$2,$3,$4,$5,$6::jsonb,$7, now() - interval '${idade} days', now() - interval '${idade} days')`,
    [
      opts.id,
      ORG_A,
      CAMPANHA,
      opts.placeId,
      "+5511999990000",
      JSON.stringify({
        name: `Padaria ${opts.placeId}`,
        website: `https://${opts.placeId}.example.test`,
        maps_url: `https://maps.example.test/?q=${opts.placeId}`,
        category: "Padaria",
        rating: 4.6,
        reviews: 128,
      }),
      opts.status ?? "new",
    ],
  );
}

/**
 * Conta com a coluna ALIASADA (`as n`). Sem o alias o Postgres nomeia a coluna
 * `count`, `rows[0].n` fica `undefined` e o `?? 0` transforma qualquer contagem
 * em zero — foi assim que o caso 3 passou a acusar "empresa não criada" com a
 * empresa criada. Contagem que não devolve a coluna agora explode.
 */
async function conta(sql: string, args: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(sql, args);
  const n = rows[0]?.n;
  if (n === undefined) throw new Error(`contagem sem a coluna n: ${sql}`);
  return Number(n);
}

beforeEach(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values
       ($1, 'org-empresa-da-prospeccao-a', 'Org A', 'Org A'),
       ($2, 'org-empresa-da-prospeccao-b', 'Org B', 'Org B')
     on conflict (id) do nothing`,
    [ORG_A, ORG_B],
  );
  await pool.query(
    `insert into prospecting_campaigns (id, organization_id, request_id, name, search)
     values ($1,$2,$3,'Campanha da Empresa','{}'::jsonb)
     on conflict (id) do nothing`,
    [CAMPANHA, ORG_A, randomUUID()],
  );
  await pool.query("delete from contacts where organization_id in ($1,$2)", [ORG_A, ORG_B]);
  await pool.query("delete from companies where organization_id in ($1,$2)", [ORG_A, ORG_B]);
  await pool.query("delete from prospecting_candidates where organization_id in ($1,$2)", [
    ORG_A,
    ORG_B,
  ]);
  // A chave do módulo nasce AUSENTE: desligado é o padrão da instalação.
  await pool.query("delete from platform_config where chave = 'MODULO_CRM_B2B'");
});

afterAll(async () => {
  await pool.query("delete from platform_config where chave = 'MODULO_CRM_B2B'");
  await pool.end();
});

async function ligarModulo(valor: "ligado" | "desligado"): Promise<void> {
  await pool.query(
    `insert into platform_config (chave, valor) values ('MODULO_CRM_B2B', $1)
     on conflict (chave) do update set valor = $1`,
    [valor],
  );
}

describe("prospecção × módulo Empresas e pessoas (#3198, fatia 2)", () => {
  it("1. módulo desligado: nenhuma linha em companies — a prospecção segue como hoje", async () => {
    // AUSENTE = desligado (falha fechada da `lib/instalacao/modulos.ts`). Um
    // candidato abordado sem o módulo não pode criar empresa nenhuma: é a
    // decisão 3 do autor, e a caracterização do modo de hoje.
    const { client } = meetPgSupabase(pool);
    const devolvidos = [];
    for (const placeId of ["desligado-1", "desligado-2", "desligado-3"]) {
      devolvidos.push(await empresaDoCandidato(client, ORG_A, negocio(placeId)));
    }

    expect(devolvidos).toEqual([null, null, null]);
    expect(
      await conta("select count(*) as n from companies where organization_id = $1", [ORG_A]),
    ).toBe(0);

    // E o mesmo com a chave EXPLÍCITA em `desligado`: só `ligado` liga.
    await ligarModulo("desligado");
    expect(await empresaDoCandidato(client, ORG_A, negocio("desligado-4"))).toBeNull();
    expect(
      await conta("select count(*) as n from companies where organization_id = $1", [ORG_A]),
    ).toBe(0);
  });

  it("2. módulo ligado: a empresa nasce com site, Maps e place_id, e o contato nasce ligado a ela", async () => {
    await ligarModulo("ligado");
    const { client } = meetPgSupabase(pool);
    const dados = negocio("chave-ligada");

    const empresaId = await empresaDoCandidato(client, ORG_A, dados);
    expect(empresaId).toBeTruthy();

    const { rows } = await pool.query(
      "select trade_name, phone, email, website, maps_url, place_id from companies where id = $1",
      [empresaId],
    );
    expect(rows[0]).toEqual({
      trade_name: dados.name,
      phone: dados.phone,
      email: dados.emails[0],
      website: dados.website,
      maps_url: dados.maps_url,
      place_id: dados.key,
    });

    // Nota, avaliações e categoria NÃO moram na Empresa (decisão 2): a Empresa
    // não tem essas colunas, e o candidato continua sendo quem as guarda.
    const colunas = await pool.query(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'companies'
          and column_name in ('rating','reviews','category')`,
    );
    expect(colunas.rowCount).toBe(0);

    // O contato que a prospecção ACABOU de criar nasce ligado à empresa.
    const contatoId = randomUUID();
    await pool.query(
      `insert into contacts (id, organization_id, name, display_name, phone_number, source)
       values ($1,$2,$3,$3,'+5511999990000','prospecting')`,
      [contatoId, ORG_A, dados.name],
    );
    await ligarContatoAEmpresa(pool, ORG_A, contatoId, empresaId!);

    const contato = await pool.query("select company_id from contacts where id = $1", [contatoId]);
    expect(contato.rows[0].company_id).toBe(empresaId);

    // E sem pessoa sintética "Recepção": o vínculo é com a EMPRESA (decisão 1).
    expect(
      await conta("select count(*) as n from people where organization_id = $1", [ORG_A]),
    ).toBe(0);
  });

  it("3. dois candidatos com o mesmo place_id na mesma organização reaproveitam a mesma empresa", async () => {
    await ligarModulo("ligado");
    const { client, errors: errosDaPonte } = meetPgSupabase(pool);

    const primeira = await empresaDoCandidato(client, ORG_A, negocio("mesma-casa"));
    // A ponte guarda o erro que engoliu; sem esta linha, "empresa não criada"
    // poderia ser falha do INSTRUMENTO passando por defeito do produto.
    expect(errosDaPonte).toEqual([]);
    // O segundo candidato do MESMO negócio chega com o site ainda por preencher:
    // o reaproveitamento completa o campo vazio, sem duplicar empresa.
    const segunda = await empresaDoCandidato(
      client,
      ORG_A,
      negocio("mesma-casa", { website: "https://completado.example.test", maps_url: null }),
    );

    expect(segunda).toBe(primeira);
    expect(
      await conta("select count(*) as n from companies where organization_id = $1", [ORG_A]),
    ).toBe(1);
    const { rows } = await pool.query("select website, maps_url from companies where id = $1", [
      primeira,
    ]);
    // Preencheu o que faltava e não apagou o que já existia.
    expect(rows[0].website).toBe("https://mesma-casa.example.test");
    expect(rows[0].maps_url).toBe("https://maps.example.test/?q=mesma-casa");
  });

  it("4. contato não aponta para empresa de outra organização — recusa explícita", async () => {
    await ligarModulo("ligado");
    const { client } = meetPgSupabase(pool);
    const empresaDaB = await empresaDoCandidato(client, ORG_B, negocio("empresa-da-b"));
    expect(empresaDaB).toBeTruthy();

    const contatoId = randomUUID();
    await pool.query(
      `insert into contacts (id, organization_id, name, phone_number, source)
       values ($1,$2,'Contato da A','+5511988887777','prospecting')`,
      [contatoId, ORG_A],
    );

    await expect(ligarContatoAEmpresa(pool, ORG_A, contatoId, empresaDaB!)).rejects.toThrow(
      /contacts\.company_id: organization_id deve coincidir com a empresa/,
    );

    const contato = await pool.query("select company_id from contacts where id = $1", [contatoId]);
    expect(contato.rows[0].company_id).toBeNull();

    // Controle: a empresa da PRÓPRIA organização liga sem recusa — sem este par,
    // um gatilho que recusasse tudo passaria no caso acima.
    const empresaDaA = await empresaDoCandidato(client, ORG_A, negocio("empresa-da-a"));
    await ligarContatoAEmpresa(pool, ORG_A, contatoId, empresaDaA!);
    const depois = await pool.query("select company_id from contacts where id = $1", [contatoId]);
    expect(depois.rows[0].company_id).toBe(empresaDaA);
  });

  it("5. a poda de 365 dias do candidato não apaga a empresa nem seus campos", async () => {
    await ligarModulo("ligado");
    const { client } = meetPgSupabase(pool);

    const candidatoId = randomUUID();
    await semearCandidato({
      id: candidatoId,
      placeId: "vence-em-365",
      idadeDias: 400,
      status: "sent",
    });
    const empresaId = await empresaDoCandidato(client, ORG_A, negocio("vence-em-365"));
    const contatoId = randomUUID();
    await pool.query(
      `insert into contacts (id, organization_id, name, phone_number, source)
       values ($1,$2,'Padaria Vencida','+5511977776666','prospecting')`,
      [contatoId, ORG_A],
    );
    await ligarContatoAEmpresa(pool, ORG_A, contatoId, empresaId!);

    // A poda real da 0408, com o mesmo chamador do cron de retenção.
    const apagadas = await pool.query<{ n: number }>(
      "select public.fn_expurgar_prospeccao_vencida(365, 1000) as n",
    );
    expect(Number(apagadas.rows[0]?.n ?? 0)).toBeGreaterThanOrEqual(1);
    expect(
      await conta("select count(*) as n from prospecting_candidates where id = $1", [candidatoId]),
    ).toBe(0);

    // O que agora mora na Empresa sobrevive à linha que sumiu — o motivo pelo
    // qual o autor rejeitou a opção "só o place_id apontando para a prospecção".
    const { rows } = await pool.query(
      "select trade_name, website, maps_url, place_id from companies where id = $1",
      [empresaId],
    );
    expect(rows[0]).toEqual({
      trade_name: "Padaria vence-em-365",
      website: "https://vence-em-365.example.test",
      maps_url: "https://maps.example.test/?q=vence-em-365",
      place_id: "vence-em-365",
    });
    const contato = await pool.query("select company_id from contacts where id = $1", [contatoId]);
    expect(contato.rows[0].company_id).toBe(empresaId);
  });
});
