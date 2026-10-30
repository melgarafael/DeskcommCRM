import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { completarLinksDoContato } from "@/lib/prospecting/links-do-candidato";

/**
 * COMPLETAR OS LINKS DE UM CONTATO QUE JÁ EXISTE, NO POSTGRES REAL (Spec 26 §3.3).
 *
 * A instrução é UMA `update` atômica: o que a pessoa digitou vence, o que falta entra,
 * o resto do `custom_fields` é preservado, e o contato anonimizado, o mesclado e o de
 * outra organização não são tocados. Roda o helper de verdade contra o banco porque
 * o que se mede depende do estado anterior (o `custom_fields` que já está lá).
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});

const ORG = "e26a0000-0000-4000-8000-000000000001";
const ORG_OUTRA = "e26a0000-0000-4000-8000-000000000002";
const SITE = "https://candidato.example.com/";
const INSTAGRAM = "https://www.instagram.com/candidato/";

let db: pg.PoolClient;

beforeAll(async () => {
  for (const [id, slug] of [
    [ORG, "org-links-contato-1"],
    [ORG_OUTRA, "org-links-contato-2"],
  ] as const) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name)
       values ($1, $2, 'Links LTDA', 'Links') on conflict (id) do nothing`,
      [id, slug],
    );
  }
  db = await pool.connect();
});

afterAll(async () => {
  db?.release();
  await pool.end();
});

async function criarContato(
  org: string,
  campos: {
    custom_fields?: Record<string, unknown>;
    anonimizado?: boolean;
    mescladoEm?: string;
  } = {},
): Promise<string> {
  const anonimizado = campos.anonimizado === true;
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, source, custom_fields, is_anonymized, anonymized_at, is_merged_into)
     values ($1, 'Contato da prova', 'manual', $2::jsonb, $3, $4, $5)
     returning id`,
    [
      org,
      JSON.stringify(campos.custom_fields ?? {}),
      anonimizado,
      anonimizado ? new Date() : null,
      campos.mescladoEm ?? null,
    ],
  );
  return rows[0]!.id;
}

async function lerContato(id: string): Promise<{
  custom_fields: Record<string, unknown>;
  updated_at: Date;
}> {
  const { rows } = await pool.query<{ custom_fields: Record<string, unknown>; updated_at: Date }>(
    "select custom_fields, updated_at from contacts where id = $1",
    [id],
  );
  return rows[0]!;
}

describe("completarLinksDoContato: o que a pessoa digitou não se perde", () => {
  it("(a) chave que a pessoa digitou é preservada; a que falta entra", async () => {
    // SABOTAGEM (Spec 26 §6): inverta a ordem do `||` no helper
    // (`coalesce(...) || $3::jsonb`). Com o candidato na direita, o `link_instagram` do
    // candidato vence o que a pessoa digitou e ESTE caso fica VERMELHO, na asserção do
    // `link_instagram`. Previsto: 1 vermelho, o desta linha.
    const digitado = "https://pessoa.example.com/perfil";
    const id = await criarContato(ORG, { custom_fields: { link_instagram: digitado } });

    const gravou = await completarLinksDoContato(db, ORG, id, {
      instagram: INSTAGRAM,
      site: SITE,
    });

    expect(gravou).toBe(true);
    const cf = (await lerContato(id)).custom_fields;
    expect(cf.link_instagram).toBe(digitado);
    expect(cf.link_site).toBe(SITE);
  });

  it("(b) chave ausente é adicionada ao contato sem campos", async () => {
    const id = await criarContato(ORG, { custom_fields: {} });

    const gravou = await completarLinksDoContato(db, ORG, id, { site: SITE });

    expect(gravou).toBe(true);
    expect((await lerContato(id)).custom_fields).toEqual({ link_site: SITE });
  });

  it("(f) campos que não são link_* ficam como estavam, inclusive link_ que não é nosso", async () => {
    const id = await criarContato(ORG, {
      custom_fields: {
        campo_x: "valor",
        nota: "ligar na terça",
        link_personalizado: "não é um tipo nosso",
      },
    });

    await completarLinksDoContato(db, ORG, id, { instagram: INSTAGRAM });

    const cf = (await lerContato(id)).custom_fields;
    expect(cf.campo_x).toBe("valor");
    expect(cf.nota).toBe("ligar na terça");
    expect(cf.link_personalizado).toBe("não é um tipo nosso");
    expect(cf.link_instagram).toBe(INSTAGRAM);
  });
});

describe("completarLinksDoContato: rodada sem nada novo não escreve", () => {
  it("(c) segunda rodada, com os mesmos links, não muda updated_at", async () => {
    const id = await criarContato(ORG, { custom_fields: {} });
    await completarLinksDoContato(db, ORG, id, { site: SITE });
    const antes = await lerContato(id);

    const gravouDeNovo = await completarLinksDoContato(db, ORG, id, { site: SITE });

    expect(gravouDeNovo).toBe(false);
    expect((await lerContato(id)).updated_at).toEqual(antes.updated_at);
  });

  it("(c2) link que a pessoa digitou com OUTRO valor: a rodada seguinte também não escreve", async () => {
    // Caso que o `@> $links` do texto da spec não cobria: o valor digitado nunca bate com o
    // do candidato, então a linha seria reescrita a cada clique. Com a checagem de chave
    // (`?&`), o link já existe e a rodada não toca no contato.
    const id = await criarContato(ORG, {
      custom_fields: { link_instagram: "https://pessoa.example.com/perfil" },
    });
    await completarLinksDoContato(db, ORG, id, { instagram: INSTAGRAM, site: SITE });
    const antes = await lerContato(id);

    const gravouDeNovo = await completarLinksDoContato(db, ORG, id, {
      instagram: INSTAGRAM,
      site: SITE,
    });

    expect(gravouDeNovo).toBe(false);
    expect((await lerContato(id)).updated_at).toEqual(antes.updated_at);
  });
});

describe("completarLinksDoContato: o que não é do alcance fica intocado", () => {
  it("(d) contato anonimizado não é tocado", async () => {
    const id = await criarContato(ORG, { custom_fields: {}, anonimizado: true });

    const gravou = await completarLinksDoContato(db, ORG, id, { site: SITE });

    expect(gravou).toBe(false);
    expect((await lerContato(id)).custom_fields).toEqual({});
  });

  it("(e) contato de OUTRA organização não é tocado, mesmo com o id certo", async () => {
    const id = await criarContato(ORG_OUTRA, { custom_fields: {} });

    const gravou = await completarLinksDoContato(db, ORG, id, { site: SITE });

    expect(gravou).toBe(false);
    expect((await lerContato(id)).custom_fields).toEqual({});
  });

  it("(g) contato MESCLADO em outro da mesma organização não é tocado", async () => {
    const destino = await criarContato(ORG, { custom_fields: {} });
    const id = await criarContato(ORG, { custom_fields: {}, mescladoEm: destino });

    const gravou = await completarLinksDoContato(db, ORG, id, { site: SITE });

    expect(gravou).toBe(false);
    expect((await lerContato(id)).custom_fields).toEqual({});
  });
});
