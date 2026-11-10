import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { dispensarParDeContatos } from "@/lib/contacts/dispensar-par";

/**
 * "NÃO SÃO A MESMA EMPRESA" NO POSTGRES REAL (Spec 31, PR A).
 *
 * A dispensa é uma linha de `merge_queue` (`discarded`, `nao_sao_a_mesma`). Estes casos
 * medem o que o helper garante contra o banco de verdade: uma linha só por par, a
 * organização da sessão como fronteira, fichas vivas apenas, e par forte recusado.
 *
 * `resolved_by_user_id` não tem FK no baseline (`merge_queue` só tem a FK da
 * organização), por isso o id de quem dispensou é um uuid fixo, sem linha em `auth.users`.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 4,
});

const ORG = "e31a0000-0000-4000-8000-000000000001";
const ORG_OUTRA = "e31a0000-0000-4000-8000-000000000002";
const USUARIO = "e31a0000-0000-4000-8000-0000000000aa";

beforeAll(async () => {
  for (const [id, slug] of [
    [ORG, "org-dispensa-par-1"],
    [ORG_OUTRA, "org-dispensa-par-2"],
  ] as const) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name)
       values ($1, $2, 'Dispensa LTDA', 'Dispensa') on conflict (id) do nothing`,
      [id, slug],
    );
  }
});

afterAll(async () => {
  await pool.end();
});

/** Uma ficha viva por padrão. `telefone` entra só quando o caso o pede. */
async function criarContato(
  org: string,
  campos: { nome?: string; telefone?: string; mescladoEm?: string; anonimizado?: boolean } = {},
): Promise<string> {
  const anonimizado = campos.anonimizado === true;
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, source, phone_number, is_merged_into, is_anonymized, anonymized_at)
     values ($1, $2, 'manual', $3, $4, $5, $6)
     returning id`,
    [
      org,
      campos.nome ?? "Ficha da prova",
      campos.telefone ?? null,
      campos.mescladoEm ?? null,
      anonimizado,
      anonimizado ? new Date() : null,
    ],
  );
  return rows[0]!.id;
}

/** Quantas linhas de dispensa existem para este par, em QUALQUER organização. */
async function contarDispensas(a: string, b: string): Promise<number> {
  const ordenado = [a, b].sort();
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text as n from merge_queue
      where status = 'discarded' and reason = 'nao_sao_a_mesma' and candidates = $1::uuid[]`,
    [ordenado],
  );
  return Number(rows[0]!.n);
}

function dispensar(org: string, a: string, b: string) {
  return dispensarParDeContatos(pool, { organizationId: org, contactIds: [a, b], userId: USUARIO });
}

describe("dispensarParDeContatos: grava uma dispensa por par", () => {
  it("(a) dispensar cria 1 linha discarded/nao_sao_a_mesma, com os ids em ordem crescente", async () => {
    const a = await criarContato(ORG, { nome: "Clínica Santos" });
    const b = await criarContato(ORG, { nome: "Santos Clínica" });

    // Passa os ids invertidos de propósito: a gravação tem de ordenar.
    const r = await dispensar(ORG, b, a);

    const esperado = [a, b].sort();
    expect(r).toEqual({ ok: true, criada: true, candidatos: esperado });
    expect(await contarDispensas(a, b)).toBe(1);
  });

  it("(b) dispensar de novo, e com o par invertido, não grava segunda linha", async () => {
    // Sabotagem: tirar a conferência de "já existe" faz a segunda chamada gravar outra linha.
    const a = await criarContato(ORG, { nome: "Padaria Sol" });
    const b = await criarContato(ORG, { nome: "Sol Padaria" });
    await dispensar(ORG, a, b);

    const de_novo = await dispensar(ORG, a, b);
    const invertido = await dispensar(ORG, b, a);

    expect(de_novo).toMatchObject({ ok: true, criada: false });
    expect(invertido).toMatchObject({ ok: true, criada: false });
    expect(await contarDispensas(a, b)).toBe(1);
  });

  it("(c) 5 chamadas CONCORRENTES do mesmo par gravam exatamente 1 linha", async () => {
    // Sabotagem: tirar o `pg_advisory_xact_lock` faz duas transações lerem "não existe"
    // ao mesmo tempo e as duas gravarem: a contagem vira 2 e este caso fica vermelho.
    const a = await criarContato(ORG, { nome: "Gráfica Norte" });
    const b = await criarContato(ORG, { nome: "Norte Gráfica" });

    const resultados = await Promise.all([
      dispensar(ORG, a, b),
      dispensar(ORG, b, a),
      dispensar(ORG, a, b),
      dispensar(ORG, b, a),
      dispensar(ORG, a, b),
    ]);

    expect(resultados.every((r) => r.ok)).toBe(true);
    expect(resultados.filter((r) => r.ok && r.criada)).toHaveLength(1);
    expect(await contarDispensas(a, b)).toBe(1);
  });
});

describe("dispensarParDeContatos: a fronteira é a organização da sessão", () => {
  it("(d) a organização A dispensando fichas da organização B → nao_encontrado, e nenhuma linha", async () => {
    // Sabotagem: tirar o `organization_id = $1` do select das fichas deixa esta chamada
    // achar as fichas de B e gravar a dispensa: a contagem vira 1 e este caso fica vermelho.
    const aDeB = await criarContato(ORG_OUTRA, { nome: "Loja Vizinha" });
    const bDeB = await criarContato(ORG_OUTRA, { nome: "Vizinha Loja" });

    const r = await dispensar(ORG, aDeB, bDeB);

    expect(r).toEqual({ ok: false, motivo: "nao_encontrado" });
    expect(await contarDispensas(aDeB, bDeB)).toBe(0);
  });
});

describe("dispensarParDeContatos: só ficha viva, e só par que é de nome", () => {
  it("(e) ficha mesclada ou anonimizada → nao_encontrado", async () => {
    // Sabotagem: não filtrar `is_merged_into is null` ou `not is_anonymized` deixa a
    // dispensa de uma lápide ou de uma anonimizada passar.
    const viva = await criarContato(ORG, { nome: "Viva" });
    const outra = await criarContato(ORG, { nome: "Outra" });
    const lapide = await criarContato(ORG, { nome: "Lápide", mescladoEm: viva });
    const anonima = await criarContato(ORG, { nome: "Anônima", anonimizado: true });

    expect(await dispensar(ORG, lapide, outra)).toEqual({ ok: false, motivo: "nao_encontrado" });
    expect(await dispensar(ORG, anonima, outra)).toEqual({ ok: false, motivo: "nao_encontrado" });
    expect(await contarDispensas(lapide, outra)).toBe(0);
    expect(await contarDispensas(anonima, outra)).toBe(0);
  });

  it("(f) par com o mesmo telefone (grafia com e sem o nono dígito) → par_forte, 0 linhas", async () => {
    // Sabotagem: não recusar o par forte deixa a dispensa de um par de telefone gravar.
    const a = await criarContato(ORG, { nome: "Mesmo Número", telefone: "+553198966398" });
    const b = await criarContato(ORG, { nome: "Mesmo Número Dois", telefone: "+5531998966398" });

    const r = await dispensar(ORG, a, b);

    expect(r).toEqual({ ok: false, motivo: "par_forte" });
    expect(await contarDispensas(a, b)).toBe(0);
  });
});
