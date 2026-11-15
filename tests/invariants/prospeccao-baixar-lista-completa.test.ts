/**
 * BAIXAR A LISTA DA CAMPANHA, NUM POSTGRES DE VERDADE — PR "baixar a lista
 * completa", decisão D13.
 *
 * `app/api/v1/prospecting/[id]/exportar/route.test.ts` prova a rota contra um
 * banco de mentira, que devolve as linhas prontas venha a consulta que vier.
 * Trocar `(p.suppression_salt is not null) as suprimida` por `false`, ou
 * `(v.last_inbound_at is not null) as respondeu` por `false`, ou tirar o
 * `organization_id` da 1ª metade da união com os contatos deixava os testes da
 * rota verdes. Aqui a MESMA leitura da rota (`lerListaDaCampanha`) roda sobre o
 * `baseline.sql`, e cada expressão tem uma linha que só ela decide:
 *
 * 1. a linha apagada pela cascata de LGPD (sem vínculo e com o telefone já
 *    trocado: só `suppression_salt` sobra) não sai em arquivo nenhum;
 * 2. quem respondeu sai como `respondeu`, pela conversa da abordagem;
 * 3. o contato bloqueado achado SÓ pelo telefone extra, na outra grafia do nono
 *    dígito, tira a empresa do arquivo;
 * 4. o contato bloqueado e pessoal de OUTRA organização, com o mesmo telefone
 *    (na ficha ou como extra), não tira nada da lista daqui nem aparece no
 *    resumo dela — o pool da rota passa por cima da RLS;
 * 5. a campanha de outra organização, sabendo o id, devolve lista vazia.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { csvDaLista, entraNaLista, resumoDaLista, situacaoDaEmpresa } from "@/lib/prospecting/exportar";
import { lerListaDaCampanha } from "@/lib/prospecting/exportar-leitura";

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

/** Namespace próprio (0b4c0000-). */
const ORG_A = "0b4c0000-0000-4000-8000-000000000001";
const ORG_B = "0b4c0000-0000-4000-8000-000000000002";
const CAMPANHA_A = "0b4c0000-1111-4000-8000-000000000001";
const SESSAO_A = "0b4c0000-2222-4000-8000-000000000001";

const CONTATO_RESPONDEU = "0b4c0000-3333-4000-8000-000000000001";
const CONTATO_ABORDADA = "0b4c0000-3333-4000-8000-000000000002";
const CONTATO_APAGADO = "0b4c0000-3333-4000-8000-000000000003";
const CONTATO_BLOQUEADO_PELO_EXTRA = "0b4c0000-3333-4000-8000-000000000004";
const CONTATO_B_PRINCIPAL = "0b4c0000-3333-4000-8000-000000000005";
const CONTATO_B_EXTRA = "0b4c0000-3333-4000-8000-000000000006";

const CONVERSA_RESPONDEU = "0b4c0000-4444-4000-8000-000000000001";
const CONVERSA_ABORDADA = "0b4c0000-4444-4000-8000-000000000002";

/** Os ids sobem na ordem da lista: `order by created_at, id` fica determinístico. */
const cand = (n: number) => `0b4c0000-5555-4000-8000-00000000000${n}`;

const TEL = {
  respondeu: "+5511911110001",
  abordada: "+5511911110002",
  apagada: "+5511911110003",
  /** O candidato SEM o nono dígito; o extra do contato bloqueado, com ele. */
  bloqueadaCandidato: "+551187650004",
  bloqueadaExtra: "+5511987650004",
  vizinhaPrincipal: "+5511911110005",
  vizinhaExtra: "+5511911110006",
  pulada: "+5511911110007",
  falhou: "+5511911110008",
  naFila: "+5511911110009",
};

const TENTOU = "2026-11-01T12:00:00Z";

beforeAll(async () => {
  await pool.query(
    `insert into organizations(id,slug,legal_name,display_name) values
       ($1,'lista-a','A','A'), ($2,'lista-b','B','B')`,
    [ORG_A, ORG_B],
  );
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted) values($1::uuid,$2,$1::text,'WORKING','\\x00')",
    [SESSAO_A, ORG_A],
  );
  await pool.query(
    `insert into contacts(id,organization_id,name,display_name,phone_number,is_blocked,is_personal) values
       ($1,$7,'Respondeu','Respondeu',$9,false,false),
       ($2,$7,'Abordada','Abordada',$10,false,false),
       ($3,$7,'Apagada','Apagada',$11,false,false),
       ($4,$7,'Bloqueada','Bloqueada','+5511944440004',true,false),
       -- Outra organização, MESMO telefone da vizinha daqui: bloqueado e pessoal.
       ($5,$8,'Vizinha B','Vizinha B',$12,true,true),
       ($6,$8,'Vizinha B extra','Vizinha B extra','+5511955550006',true,true)`,
    [
      CONTATO_RESPONDEU,
      CONTATO_ABORDADA,
      CONTATO_APAGADO,
      CONTATO_BLOQUEADO_PELO_EXTRA,
      CONTATO_B_PRINCIPAL,
      CONTATO_B_EXTRA,
      ORG_A,
      ORG_B,
      TEL.respondeu,
      TEL.abordada,
      TEL.apagada,
      TEL.vizinhaPrincipal,
    ],
  );
  await pool.query(
    `insert into contact_phones(organization_id,contact_id,phone_number,tipo) values
       ($1,$2,$3,'celular'), ($4,$5,$6,'celular')`,
    [ORG_A, CONTATO_BLOQUEADO_PELO_EXTRA, TEL.bloqueadaExtra, ORG_B, CONTATO_B_EXTRA, TEL.vizinhaExtra],
  );
  await pool.query(
    `insert into conversations(id,organization_id,contact_id,channel_session_id,status,last_inbound_at) values
       ($1,$3,$4,$6,'open',now()), ($2,$3,$5,$6,'open',null)`,
    [CONVERSA_RESPONDEU, CONVERSA_ABORDADA, ORG_A, CONTATO_RESPONDEU, CONTATO_ABORDADA, SESSAO_A],
  );
  await pool.query(
    "insert into prospecting_campaigns(id,organization_id,request_id,name,search,status) values($1,$2,gen_random_uuid(),'Clínicas','{}','completed')",
    [CAMPANHA_A, ORG_A],
  );
  const linha = (
    n: number,
    nome: string,
    telefone: string,
    status: string,
    extra: { contato?: string; conversa?: string; tentou?: boolean } = {},
  ) => [
    cand(n),
    `place-${n}`,
    telefone,
    JSON.stringify({ key: `place-${n}`, name: nome, phone: telefone }),
    status,
    extra.contato ?? null,
    extra.conversa ?? null,
    extra.tentou ? TENTOU : null,
  ];
  const linhas = [
    linha(1, "Respondeu Sim", TEL.respondeu, "sent", {
      contato: CONTATO_RESPONDEU,
      conversa: CONVERSA_RESPONDEU,
      tentou: true,
    }),
    linha(2, "Sem Resposta", TEL.abordada, "sent", {
      contato: CONTATO_ABORDADA,
      conversa: CONVERSA_ABORDADA,
      tentou: true,
    }),
    // "Contato já existe no CRM": sem vínculo, de propósito (`store.ts`).
    linha(3, "Apagada LGPD", TEL.apagada, "skipped"),
    linha(4, "Bloqueada Extra", TEL.bloqueadaCandidato, "skipped"),
    linha(5, "Vizinha Principal", TEL.vizinhaPrincipal, "new"),
    linha(6, "Vizinha Extra", TEL.vizinhaExtra, "new"),
    linha(7, "Pulada Triagem", TEL.pulada, "skipped"),
    linha(8, "Falhou Sem Envio", TEL.falhou, "failed", { tentou: true }),
    linha(9, "Na Fila", TEL.naFila, "queued"),
  ];
  for (const valores of linhas)
    await pool.query(
      `insert into prospecting_candidates(id,organization_id,campaign_id,place_id,phone,data,status,contact_id,conversation_id,attempted_at)
       values($1,$9,$10,$2,$3,$4::jsonb,$5,$6,$7,$8)`,
      [...valores, ORG_A, CAMPANHA_A],
    );
  // A cascata de verdade: alcança o candidato SEM vínculo pelo telefone, troca
  // os dados e semeia a supressão. Depois dela, só `suppression_salt` diz que a
  // linha foi apagada — o contato não é mais achado pelo telefone.
  await pool.query("select public.fn_lgpd_cascade_redact_contact($1,$2,gen_random_uuid())", [
    ORG_A,
    CONTATO_APAGADO,
  ]);
});
afterAll(() => pool.end());

describe("a lista da campanha num banco de verdade", () => {
  it("a semente valeu: a linha apagada ficou suprimida e sem telefone", async () => {
    const { rows } = await pool.query(
      "select phone, contact_id, suppression_salt is not null as suprimida from prospecting_candidates where id=$1",
      [cand(3)],
    );
    expect(rows[0]).toEqual({ phone: null, contact_id: null, suprimida: true });
  });

  it("o resumo conta só o que é desta organização, com o motivo certo", async () => {
    const lista = await lerListaDaCampanha(pool, ORG_A, CAMPANHA_A);
    expect(resumoDaLista(lista)).toEqual({
      total: 9,
      // Vizinha Principal, Vizinha Extra e Na Fila: o contato bloqueado da B
      // não tira as vizinhas daqui.
      nao_abordadas: 3,
      todas: 7,
      fora_da_lista: { dados_apagados: 1, pediu_para_parar: 1, ficha_pessoal: 0 },
    });
  });

  it("a lista inteira leva cada empresa com a situação que o banco confirma", async () => {
    const lista = await lerListaDaCampanha(pool, ORG_A, CAMPANHA_A);
    const saem = lista.filter((c) => entraNaLista(c, "todas"));
    expect(saem.map((c) => [c.data.name, situacaoDaEmpresa(c)])).toEqual([
      ["Respondeu Sim", "respondeu"],
      ["Sem Resposta", "abordada"],
      ["Vizinha Principal", "não abordada"],
      ["Vizinha Extra", "não abordada"],
      ["Pulada Triagem", "fora da fila"],
      ["Falhou Sem Envio", "envio não confirmado"],
      ["Na Fila", "não abordada"],
    ]);
    const csv = csvDaLista(saem, { comSituacao: true });
    expect(csv).not.toContain("Bloqueada Extra");
    expect(csv).not.toContain(TEL.bloqueadaCandidato);
    expect(csv).not.toContain("Apagada");
    expect(csv).not.toContain(TEL.apagada);
  });

  it("a lista das não abordadas também não leva quem foi vetado", async () => {
    const lista = await lerListaDaCampanha(pool, ORG_A, CAMPANHA_A);
    expect(lista.filter((c) => entraNaLista(c, "nao_abordadas")).map((c) => c.data.name)).toEqual([
      "Vizinha Principal",
      "Vizinha Extra",
      "Na Fila",
    ]);
  });

  it("outra organização, sabendo o id da campanha, não lê nada", async () => {
    expect(await lerListaDaCampanha(pool, ORG_B, CAMPANHA_A)).toEqual([]);
  });
});
