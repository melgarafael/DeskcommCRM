/**
 * "Não são a mesma empresa" — o que o par ligado por CPF muda na dispensa (#4081).
 *
 * O invariante `tests/invariants/dispensar-par-de-contatos.test.ts` prova a trava,
 * a idempotência e o filtro de organização contra Postgres de verdade. O que este
 * arquivo guarda é outra coisa, e que banco nenhum vê: a LEITURA do par precisa
 * trazer `cpf_hash`, senão `ligadosPorMotivoForte` recebe `undefined` nos dois
 * lados, compara igual e o atendente consegue dispensar um par que é a mesma
 * pessoa — a fusão acontece depois por outro caminho, com o histórico no lugar
 * errado. É a falha muda clássica: a coluna some do `select`, tudo continua verde
 * e a régua para de valer.
 */
import { describe, expect, it } from "vitest";

import { dispensarParDeContatos } from "@/lib/contacts/dispensar-par";

const ORG = "22222222-2222-4222-8222-222222222222";
const USUARIO = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HASH = "3f7a1c0d9b2e4f5061728394a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e";

interface LinhaDoPar {
  id: string;
  phone_number: string | null;
  email: string | null;
  email_normalized: string | null;
  cpf_hash: string | null;
  wa_identity: string | null;
  wa_lid: string | null;
  source_metadata: Record<string, unknown> | null;
}

/**
 * `pg.Pool` de mentira: responde as quatro consultas da transação e registra o SQL.
 * Não é um banco — é o suficiente para provar o que a função PEDE e o que ela faz
 * com a resposta.
 */
function poolFalso(linhas: LinhaDoPar[]) {
  const consultas: string[] = [];
  const inseridos: unknown[][] = [];

  const db = {
    async query(sql: string, params?: unknown[]) {
      consultas.push(sql);
      if (/from public\.contacts/.test(sql)) return { rows: linhas };
      if (/insert into public\.merge_queue/.test(sql)) {
        inseridos.push(params ?? []);
        return { rows: [] };
      }
      // `begin`, trava, `select 1 from merge_queue`, `commit`/`rollback`.
      return { rows: [] };
    },
    release() {
      /* nada a liberar num dublê */
    },
  };

  const pool = { connect: async () => db } as never;
  return { pool, consultas, inseridos };
}

function linha(id: string, campos: Partial<LinhaDoPar> = {}): LinhaDoPar {
  return {
    id,
    phone_number: null,
    email: null,
    email_normalized: null,
    cpf_hash: null,
    wa_identity: null,
    wa_lid: null,
    source_metadata: null,
    ...campos,
  };
}

describe("dispensar par de contatos: o CPF é motivo forte", () => {
  it("mesmo CPF → par_forte, rollback e NENHUMA linha de dispensa", async () => {
    // Sabotagem: tirar o CPF de `ligadosPorMotivoForte` deixa este caso vermelho —
    // a dispensa seria gravada e o par sumiria da lista para todo mundo.
    const { pool, inseridos } = poolFalso([linha(A, { cpf_hash: HASH }), linha(B, { cpf_hash: HASH })]);

    const r = await dispensarParDeContatos(pool, {
      organizationId: ORG,
      contactIds: [A, B],
      userId: USUARIO,
    });

    expect(r).toEqual({ ok: false, motivo: "par_forte" });
    expect(inseridos).toEqual([]);
  });

  it("a leitura do par PEDE `cpf_hash` — sem a coluna, a régua não vê nada", async () => {
    // Sabotagem: tirar `cpf_hash` do `select` deixa esta asserção vermelha, e o
    // defeito em produção seria invisível (undefined === undefined).
    const { pool, consultas } = poolFalso([linha(A), linha(B)]);

    await dispensarParDeContatos(pool, { organizationId: ORG, contactIds: [A, B], userId: USUARIO });

    const leitura = consultas.find((sql) => /from public\.contacts/.test(sql))!;
    expect(leitura).toContain("cpf_hash");
  });

  it("CPF vazio nos dois NÃO é par forte: dispensa normal continua funcionando", async () => {
    // O outro lado do mesmo erro: se vazio casasse, nenhum par de nome — nem o de
    // pessoas diferentes — poderia mais ser dispensado.
    const { pool, inseridos } = poolFalso([
      linha(A, { cpf_hash: "" }),
      linha(B, { cpf_hash: "" }),
    ]);

    const r = await dispensarParDeContatos(pool, {
      organizationId: ORG,
      contactIds: [A, B],
      userId: USUARIO,
    });

    expect(r).toEqual({ ok: true, criada: true, candidatos: [A, B] });
    expect(inseridos).toHaveLength(1);
  });

  it("CPF diferente: o par volta a ser dispensável", async () => {
    const { pool, inseridos } = poolFalso([
      linha(A, { cpf_hash: HASH }),
      linha(B, { cpf_hash: `${HASH.slice(0, -1)}f` }),
    ]);

    const r = await dispensarParDeContatos(pool, {
      organizationId: ORG,
      contactIds: [A, B],
      userId: USUARIO,
    });

    expect(r.ok).toBe(true);
    expect(inseridos).toHaveLength(1);
  });
});

/**
 * A conta de WhatsApp (#4081) é motivo forte, e pela mesma mecânica muda: se a
 * leitura do par não trouxer `wa_identity`/`wa_lid`, `ligadosPorMotivoForte` vê
 * `undefined` dos dois lados e o atendente consegue dispensar — para todo mundo —
 * o par que é a MESMA conta de WhatsApp.
 */
describe("dispensar par de contatos: a conta de WhatsApp é motivo forte", () => {
  const LID = "100000000000001";

  it("mesmo `wa_lid` → par_forte, rollback e NENHUMA linha de dispensa", async () => {
    const { pool, inseridos } = poolFalso([
      linha(A, { wa_identity: `lid:${LID}`, wa_lid: LID }),
      linha(B, { wa_identity: `lid:${LID}`, wa_lid: LID }),
    ]);

    const r = await dispensarParDeContatos(pool, {
      organizationId: ORG,
      contactIds: [A, B],
      userId: USUARIO,
    });

    expect(r).toEqual({ ok: false, motivo: "par_forte" });
    expect(inseridos).toEqual([]);
  });

  it("a leitura do par PEDE `wa_identity` e `wa_lid`", async () => {
    // Sabotagem: tirar qualquer das duas do `select` deixa esta asserção vermelha.
    const { pool, consultas } = poolFalso([linha(A), linha(B)]);

    await dispensarParDeContatos(pool, { organizationId: ORG, contactIds: [A, B], userId: USUARIO });

    const leitura = consultas.find((sql) => /from public\.contacts/.test(sql))!;
    expect(leitura).toContain("wa_identity");
    expect(leitura).toContain("wa_lid");
  });

  it("conta de WhatsApp diferente: o par continua dispensável", async () => {
    const { pool, inseridos } = poolFalso([
      linha(A, { wa_identity: `lid:${LID}`, wa_lid: LID }),
      linha(B, { wa_identity: "lid:70192801579999", wa_lid: "70192801579999" }),
    ]);

    const r = await dispensarParDeContatos(pool, {
      organizationId: ORG,
      contactIds: [A, B],
      userId: USUARIO,
    });

    expect(r.ok).toBe(true);
    expect(inseridos).toHaveLength(1);
  });
});
