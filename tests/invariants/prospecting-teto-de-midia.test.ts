/**
 * O TETO DIÁRIO DE MÍDIA POR NÚMERO (#4581, doc 358 › 2A) CONTA O QUE SAIU.
 *
 * `lib/prospecting/midia-na-primeira-abordagem.test.ts` prova a decisão do envio
 * com a contagem dublada. Aqui se prova, contra Postgres de verdade, a contagem:
 * a 1ª bolha de uma abordagem (`messages.id = prospecting_candidates.message_id`)
 * conta quando levou arquivo, saiu por ESTE número e saiu desde o início do dia;
 * texto, recusa da plataforma, outro número e ontem não contam.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { abordagensComMidiaDesde } from "@/lib/prospecting/midia-da-abordagem";
import {
  criarFixtureDeOfertas,
  limparFixtureDeOfertas,
  type FixtureDeOfertas,
} from "../support/prospeccao-ofertas-fixture";

if (!process.env.TEST_DB_CONTAINER) throw new Error("Esta prova exige o Postgres efêmero de test:db.");

const pool = new pg.Pool({
  host: "127.0.0.1",
  port: Number(process.env.TEST_DB_PORT ?? 54329),
  user: "postgres",
  password: "postgres",
  database: "postgres",
  max: 4,
  statement_timeout: 5000,
});

const ORG = "0a145810-0000-4000-8000-000000000001";
let f: FixtureDeOfertas;
/** O início do "dia" da prova: uma hora atrás, para a mensagem da fixture cair dentro. */
const inicioDoDia = () => new Date(Date.now() - 60 * 60 * 1000);

async function primeiraBolha(set: string) {
  await pool.query(`update messages set ${set} where id=$1`, [f.historicalMessage]);
}
const contar = (canal = f.channel, desde = inicioDoDia()) =>
  abordagensComMidiaDesde(pool, f.org, canal, desde);

beforeAll(async () => {
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1,'teto-midia-qa','Teto QA','Teto QA')",
    [ORG],
  );
  f = await criarFixtureDeOfertas(pool, ORG);
  // A fixture representa uma abordagem já feita: carimba a tentativa de agora.
  await pool.query("update prospecting_candidates set attempted_at=now() where id=$1", [f.candidate]);
});

afterAll(async () => {
  try {
    if (f) await limparFixtureDeOfertas(pool, f);
    await pool.query("delete from organizations where id=$1", [ORG]);
  } finally {
    await pool.end();
  }
});

describe("a contagem do teto é o que saiu com arquivo por este número, hoje", () => {
  it("abordagem só de texto não conta", async () => {
    expect(await contar()).toBe(0);
  });

  it.each(["image", "video", "document"])("abordagem com %s conta", async (tipo) => {
    await primeiraBolha(`type='${tipo}', status='sent'`);
    expect(await contar()).toBe(1);
  });

  it("a que a plataforma recusou (failed) não conta: não chegou a ninguém", async () => {
    await primeiraBolha("type='image', status='failed'");
    expect(await contar()).toBe(0);
  });

  it("outro número não conta, nem a abordagem de antes do início do dia", async () => {
    await primeiraBolha("type='image', status='sent'");
    expect(await contar("0a145810-0000-4000-8000-0000000000ff")).toBe(0);
    expect(await contar(f.channel, new Date(Date.now() + 60 * 1000))).toBe(0);
  });
});
