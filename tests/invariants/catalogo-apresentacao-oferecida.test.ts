/** A consulta real de `apresentacaoOferecidaNoTurno`, por organização, em PG real. */
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { apresentacaoOferecidaNoTurno } from "@/lib/catalogo/apresentacao-ligada";

vi.mock("@/lib/organizacao/capacidades", () => ({
  capacidadesDaOrganizacao: vi.fn(async () => ["apresentacao_do_catalogo"]),
}));

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 2,
});
const [ATIVA, SO_INATIVA, SEM_LINHA] = [randomUUID(), randomUUID(), randomUUID()];
const oferecida = (org: string) =>
  apresentacaoOferecidaNoTurno({} as never, pool, org, {
    warn: (mensagem) => { throw new Error(mensagem); },
  });

beforeAll(async () => {
  for (const org of [ATIVA, SO_INATIVA, SEM_LINHA]) {
    await pool.query(
      "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Sintética','Sintética')",
      [org],
    );
  }
  for (const [org, ativa] of [[ATIVA, true], [SO_INATIVA, false]] as const) {
    const produto = randomUUID();
    await pool.query(
      "insert into catalog_products(id,organization_id,codigo,nome,preco_cents) values($1,$2,'A','Produto',100)",
      [produto, org],
    );
    await pool.query(
      "insert into catalog_product_presentations(organization_id,catalog_product_id,enabled,kind,text_content) values($1,$2,$3,'text','Texto')",
      [org, produto, ativa],
    );
  }
});
afterAll(() => pool.end());

describe("apresentação oferecida no turno", () => {
  it("só a organização com apresentação ativa recebe a ferramenta", async () => {
    expect(await oferecida(ATIVA)).toBe(true);
    expect(await oferecida(SO_INATIVA)).toBe(false);
    expect(await oferecida(SEM_LINHA)).toBe(false);
  });
});
