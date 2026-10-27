import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ESPECIES } from "@/lib/agencia/mapas/blocos";

/**
 * Os blocos do mapa no estilo do Fluxo (migration 9014, plano de 27/10 › item 5):
 * a espécie fechada no banco com a MESMA lista do TypeScript, os efeitos novos no
 * `tipo`, a configuração sempre objeto, e o vínculo com o aviso e o post que o
 * bloco criou sem cascata (apagar o envio não apaga o bloco).
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 3,
});
const cliente = randomUUID();
const mapa = randomUUID();
const bloco = randomUUID();

beforeAll(async () => {
  await pool.query("insert into agencia_clientes(id,nome) values ($1,'Cliente 9014')", [cliente]);
  await pool.query("insert into agencia_mapas(id,cliente_id,titulo) values ($1,$2,'Mapa 9014')", [mapa, cliente]);
  await pool.query("insert into agencia_mapa_blocos(id,mapa_id,titulo) values ($1,$2,'Bloco')", [bloco, mapa]);
});

afterAll(async () => {
  await pool.query("delete from agencia_clientes where id = $1", [cliente]);
  await pool.end();
});

describe("blocos do mapa (9014)", () => {
  it("bloco antigo nasce tarefa livre, com configuração vazia", async () => {
    const { rows } = await pool.query("select especie, tipo, config from agencia_mapa_blocos where id = $1", [bloco]);
    expect(rows[0]).toEqual({ especie: "tarefa", tipo: "tarefa", config: {} });
  });

  it("o CHECK da espécie é a MESMA lista da paleta (blocos.ts)", async () => {
    const { rows } = await pool.query<{ def: string }>(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'agencia_mapa_blocos_especie'",
    );
    const noBanco = [...(rows[0]?.def ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(noBanco).toEqual([...ESPECIES].sort());
    await expect(pool.query("update agencia_mapa_blocos set especie = 'foguete' where id = $1", [bloco])).rejects.toThrow(/agencia_mapa_blocos_especie/);
  });

  it("os efeitos novos entram no tipo; o resto não", async () => {
    for (const t of ["aviso", "publicacao", "espera", "nota", "marco", "tarefa"]) {
      await pool.query("update agencia_mapa_blocos set tipo = $2 where id = $1", [bloco, t]);
    }
    await expect(pool.query("update agencia_mapa_blocos set tipo = 'magia' where id = $1", [bloco])).rejects.toThrow(/agencia_mapa_blocos_tipo/);
  });

  it("configuração é sempre objeto", async () => {
    await pool.query(`update agencia_mapa_blocos set config = '{"texto":"oi"}' where id = $1`, [bloco]);
    await expect(pool.query("update agencia_mapa_blocos set config = '[1,2]' where id = $1", [bloco])).rejects.toThrow(/agencia_mapa_blocos_config/);
  });

  it("apagar o post que o bloco criou solta o vínculo, não apaga o bloco", async () => {
    const { rows } = await pool.query<{ id: string }>("insert into agencia_publicacoes(cliente_id,titulo,quando) values ($1,'Post 9014',now()) returning id", [cliente]);
    await pool.query("update agencia_mapa_blocos set publicacao_id = $2 where id = $1", [bloco, rows[0]!.id]);
    await pool.query("delete from agencia_publicacoes where id = $1", [rows[0]!.id]);
    const { rows: depois } = await pool.query("select publicacao_id from agencia_mapa_blocos where id = $1", [bloco]);
    expect(depois).toEqual([{ publicacao_id: null }]);
  });
});
