import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { corDaFilaSchema } from "@/lib/schemas/routing";
import { seedGov, GOV_ORG as org } from "./gov-helpers";

/**
 * #3876 (F3) — a COR da fila no BANCO (migration 9084).
 *
 * O Zod recusa a cor inválida na borda; o CHECK é a segunda porta e a única que
 * vale para quem escreve fora da rota (script, psql, restauração). Este arquivo
 * prova o que o banco segura, sem passar por rota nenhuma:
 *
 *   - `#rrggbb` entra, em maiúscula e em minúscula;
 *   - `null` entra (fila sem cor é o estado de hoje, não erro);
 *   - fora do formato é `23514` (check_violation) — e o teste diz QUAL forma
 *     cada tentativa tinha, senão "recusou" não distingue a coluna do resto.
 */
const pool = new Pool({
  // A senha do container efêmero vem do `scripts/test-db.sh`
  // (`POSTGRES_PASSWORD`); o default é o dela. A porta é a que o Docker alocou.
  connectionString: `postgresql://postgres:${process.env.TEST_DB_PASSWORD ?? "postgres"}@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 3,
});
const query = (text: string, args: unknown[] = []) => pool.query(text, args);

let sequencia = 0;
async function criarSetor(color: string | null): Promise<string> {
  sequencia += 1;
  const r = await query(
    "insert into attendant_sectors(organization_id,name,color) values($1,$2,$3) returning id",
    [org, `Fila ${sequencia}`, color],
  );
  return r.rows[0].id as string;
}

beforeAll(async () => {
  seedGov();
  await query("delete from attendant_sectors where organization_id = $1", [org]);
});
afterAll(async () => {
  await query("delete from attendant_sectors where organization_id = $1", [org]);
  await pool.end();
});
beforeEach(async () => {
  await query("delete from attendant_sectors where organization_id = $1", [org]);
});

describe("cor da fila (9084)", () => {
  it("a coluna existe, é text e o CHECK está lá (com controle positivo no mesmo lugar)", async () => {
    const coluna = await query(
      `select data_type, is_nullable from information_schema.columns
        where table_schema='public' and table_name='attendant_sectors' and column_name='color'`,
    );
    expect(coluna.rows).toHaveLength(1);
    expect(coluna.rows[0]).toMatchObject({ data_type: "text", is_nullable: "YES" });

    const check = await query(
      `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
        where t.relname = 'attendant_sectors' and c.contype = 'c'
          and pg_get_constraintdef(c.oid) like '%color%'`,
    );
    expect(check.rows).toHaveLength(1);
    expect(check.rows[0].def).toMatch(/\^#\[0-9a-fA-F\]\{6\}\$/);
  });

  it("#rrggbb entra em minúscula e em maiúscula; null entra (fila sem cor)", async () => {
    await expect(criarSetor("#00655a")).resolves.toBeTypeOf("string");
    await expect(criarSetor("#3E63DD")).resolves.toBeTypeOf("string");
    await expect(criarSetor(null)).resolves.toBeTypeOf("string");
  });

  it("fora do formato é recusado pelo CHECK — a segunda porta do Zod", async () => {
    for (const invalido of ["azul", "#abc", "#00655g", "00655a", "#00655aa", " #00655a", "#00655a "]) {
      await expect(criarSetor(invalido), `cor "${invalido}"`).rejects.toMatchObject({
        code: "23514",
      });
    }
    const sobrou = await query(
      "select count(*)::int n from attendant_sectors where organization_id=$1 and color is not null",
      [org],
    );
    expect(sobrou.rows[0].n).toBe(0);
  });

  it("a cor é POR fila e não vaza para as vizinhas", async () => {
    const pintada = await criarSetor("#ab4aba");
    const semCor = await criarSetor(null);
    const lidas = await query(
      "select id, color from attendant_sectors where id = any($1) order by id",
      [[pintada, semCor]],
    );
    const porId = new Map(lidas.rows.map((r) => [r.id as string, r.color]));
    expect(porId.get(pintada)).toBe("#ab4aba");
    expect(porId.get(semCor)).toBeNull();
  });

  /**
   * CONCORDÂNCIA entre as duas réguas — a de TypeScript (`corDaFilaSchema`) e a
   * do banco (o CHECK). As duas são escritas à mão, com listas de grafias
   * diferentes por natureza (regex contra constraint), e é exatamente assim que
   * elas divergem sem ninguém ver: o Zod aceita, o banco recusa, e o erro só
   * aparece com dado real. Aqui a matriz é UMA, e cada grafia tem de dar o MESMO
   * veredito dos dois lados. A falha diz qual texto divergiu.
   */
  it("Zod e CHECK concordam, grafia por grafia", async () => {
    const matriz: Array<string | null> = [
      "#00655a",
      "#3E63DD",
      "#000000",
      "#abcdef",
      null,
      "#abc",
      "#00655g",
      "00655a",
      "#00655aa",
      " #00655a",
      "#00655a ",
      "azul",
      "",
      "##00655a",
    ];

    for (const grafia of matriz) {
      const aceitaNoZod = corDaFilaSchema.safeParse(grafia).success;
      let aceitaNoBanco = true;
      try {
        await criarSetor(grafia);
      } catch {
        aceitaNoBanco = false;
      }
      expect(aceitaNoBanco, `grafia ${JSON.stringify(grafia)}`).toBe(aceitaNoZod);
    }
  });
});
