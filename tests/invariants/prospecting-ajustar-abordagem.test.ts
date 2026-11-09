/**
 * TROCAR A FONTE DA ABORDAGEM E LEVAR A LISTA PARA OUTRA CAMPANHA, NUM POSTGRES DE VERDADE.
 *
 * Duas ações novas de `POST /api/v1/prospecting`, as duas sobre campanha que já foi iniciada:
 * `adjust_approach` (troca `config.fonte_da_abordagem` e, se vier, `config.instruction`) e
 * `move_list` (leva as empresas AINDA NÃO ABORDADAS para uma campanha nova em preparação).
 * O que só uma linha de verdade responde:
 *
 * 1. `adjust_approach` só mexe em campanha PAUSADA com configuração, troca só as chaves pedidas
 *    (o `||` entre jsonb preserva o resto — conexão, agente, funil, base legal, etiquetas) e a
 *    organização está no próprio `where`, não só na leitura de antes;
 * 2. `move_list` MOVE (não copia) só quem nunca foi abordado: sem contato, sem conversa, sem a
 *    linha-tomba de supressão de LGPD, e com status `new`/`queued` ou `skipped` pelo operador.
 *    Quem o produto recusou, quem já foi enviado e quem falhou ficam, com o histórico;
 * 3. repetir com o mesmo `request_id` devolve a mesma campanha e não move nem cria nada a mais;
 *    a tentativa sem nada a levar desfaz a campanha nova (rollback), não deixa uma casca vazia;
 * 4. ISOLAMENTO: outra organização, mesmo sabendo os ids, não enxerga nem move as linhas da
 *    primeira — nos DOIS níveis (a função e o SQL cru, porque a leitura de antes pode sumir num
 *    refactor e o teste da função continuaria verde).
 *
 * Cada arquivo de invariante recebe um banco novo (`tests/db/banco-limpo-por-arquivo.ts`), então
 * os ids abaixo não colidem com nenhum outro arquivo.
 *
 * Não coberto aqui: `lead_id` como motivo de exclusão do `move_list` (a coluna entra no mesmo
 * `where` que `contact_id` e `conversation_id`, mas montar um negócio exige funil e etapa).
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RAZAO_NAO_SELECIONADA } from "@/lib/prospecting/schema";
import {
  AJUSTE_DE_ABORDAGEM_SQL,
  MOVER_LISTA_SQL,
  adjustApproach,
  moverListaParaNovaCampanha,
} from "@/lib/prospecting/store";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});
const db = pool as unknown as pg.Pool;

const ORG_A = "0c120000-0000-4000-8000-000000000001";
const ORG_B = "0c120000-0000-4000-8000-000000000002";

// adjust_approach
const PAUSADA = "0c120000-1111-4000-8000-000000000001";
const RODANDO = "0c120000-1111-4000-8000-000000000002";
const RASCUNHO = "0c120000-1111-4000-8000-000000000003";
const OUTRA_ORG = "0c120000-1111-4000-8000-000000000004";
const PAUSADA_SEM_CONFIG = "0c120000-1111-4000-8000-000000000005";
// move_list
const ORIGEM = "0c120000-1111-4000-8000-000000000011";
const ORIGEM_RODANDO = "0c120000-1111-4000-8000-000000000012";
const ORIGEM_RASCUNHO = "0c120000-1111-4000-8000-000000000013";
const ORIGEM_CONCLUIDA = "0c120000-1111-4000-8000-000000000014";
const ORIGEM_DA_ORG_B = "0c120000-1111-4000-8000-000000000015";

const REQ_MOVER = "0c120000-5555-4000-8000-000000000001";
const REQ_MOVER_DE_NOVO = "0c120000-5555-4000-8000-000000000002";
const REQ_OUTRA_ORG = "0c120000-5555-4000-8000-000000000003";
const REQ_CONCLUIDA = "0c120000-5555-4000-8000-000000000004";
const REQ_RODANDO = "0c120000-5555-4000-8000-000000000005";
const REQ_RASCUNHO = "0c120000-5555-4000-8000-000000000006";
const REQ_DA_ORG_B = "0c120000-5555-4000-8000-000000000007";

const CONFIG = {
  agent_id: "0c120000-2222-4000-8000-000000000001",
  channel_session_id: "0c120000-2222-4000-8000-000000000002",
  pipeline_id: "0c120000-2222-4000-8000-000000000003",
  stage_id: "0c120000-2222-4000-8000-000000000004",
  qualified_stage_id: "0c120000-2222-4000-8000-000000000005",
  instruction: "Vender consultoria para clínicas.",
  qualification: "Confirmou a necessidade e a decisão.",
  daily_limit: 10,
  interval_minutes: 5,
  legal_basis_ref: "LIA-teste",
  exit_offer: "second_message",
  contact_tags: ["clinica"],
};
const BUSCA = { name: "Clínicas em Campinas", segment: "clínica", location: "Campinas" };

let canalA = "";
let contador = 0;
const telefone = () => `+55119888${String(++contador).padStart(5, "0")}`;
const cand = (n: number) => `0c120000-3333-4000-8000-${String(n).padStart(12, "0")}`;

async function configDe(id: string): Promise<Record<string, unknown> | null> {
  const { rows } = await pool.query("select config from prospecting_campaigns where id = $1", [id]);
  return rows[0]?.config ?? null;
}

async function campanha(
  id: string,
  org: string,
  nome: string,
  status: string,
  config: unknown,
  search: unknown = {},
) {
  await pool.query(
    // `channel_session_id` sai do `config`, como o `start` grava: campanha
    // `running` sem número viola o CHECK da 9221 (#3896).
    `insert into prospecting_campaigns(id,organization_id,request_id,name,search,status,config,channel_session_id)
     values ($1,$2,gen_random_uuid(),$3,$4::jsonb,$5,$6::jsonb,($6::jsonb->>'channel_session_id')::uuid)`,
    [
      id,
      org,
      nome,
      JSON.stringify(search),
      status,
      config === null ? null : JSON.stringify(config),
    ],
  );
}

/** Contato + conversa de verdade: `contact_id` e `conversation_id` são chaves estrangeiras. */
async function contatoEConversa(n: number): Promise<{ contato: string; conversa: string }> {
  const contato = `0c120000-6666-4000-8000-${String(n).padStart(12, "0")}`;
  const conversa = `0c120000-4444-4000-8000-${String(n).padStart(12, "0")}`;
  await pool.query(
    "insert into contacts(id,organization_id,display_name) values($1,$2,'Empresa de teste')",
    [contato, ORG_A],
  );
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')",
    [conversa, ORG_A, contato, canalA],
  );
  return { contato, conversa };
}

async function candidato(
  n: number,
  camp: string,
  org: string,
  campos: {
    status?: string;
    selected?: boolean;
    error?: string | null;
    contact?: string | null;
    conversation?: string | null;
    salt?: boolean;
    data?: Record<string, unknown>;
  } = {},
) {
  await pool.query(
    `insert into prospecting_candidates(id,organization_id,campaign_id,place_id,phone,data,status,selected,error,contact_id,conversation_id,suppression_salt)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12)`,
    [
      cand(n),
      org,
      camp,
      `place-${n}`,
      telefone(),
      JSON.stringify(campos.data ?? {}),
      campos.status ?? "new",
      campos.selected ?? true,
      campos.error ?? null,
      campos.contact ?? null,
      campos.conversation ?? null,
      campos.salt ? Buffer.alloc(32, 1) : null,
    ],
  );
}

async function estado(n: number) {
  const { rows } = await pool.query(
    "select campaign_id, status, selected, error, data from prospecting_candidates where id = $1",
    [cand(n)],
  );
  return rows[0] as
    | {
        campaign_id: string;
        status: string;
        selected: boolean;
        error: string | null;
        data: Record<string, unknown>;
      }
    | undefined;
}

async function candidatosDaCampanha(camp: string): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    "select id from prospecting_candidates where campaign_id = $1 order by id",
    [camp],
  );
  return rows.map((r) => r.id);
}

async function totalDeCampanhas(org: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "select count(*)::text as n from prospecting_campaigns where organization_id = $1",
    [org],
  );
  return Number(rows[0]?.n);
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations(id,slug,legal_name,display_name) values
       ($1,'abord-a','A','A'), ($2,'abord-b','B','B')`,
    [ORG_A, ORG_B],
  );
  canalA = (
    await pool.query(
      "insert into channel_sessions(organization_id,waha_session_name,status,webhook_secret_encrypted) values($1,gen_random_uuid()::text,'WORKING',decode('00','hex')) returning id",
      [ORG_A],
    )
  ).rows[0].id;

  // --- adjust_approach: nasce SEM `fonte_da_abordagem`, como a configuração de antes da chave.
  await campanha(PAUSADA, ORG_A, "pausada", "paused", CONFIG);
  await campanha(RODANDO, ORG_A, "rodando", "running", CONFIG);
  await campanha(RASCUNHO, ORG_A, "rascunho", "draft", null);
  await campanha(OUTRA_ORG, ORG_B, "da outra org", "paused", { ...CONFIG, instruction: "Da B." });
  await campanha(PAUSADA_SEM_CONFIG, ORG_A, "pausada sem configuração", "paused", null);

  // Uma empresa na fila da pausada: trocar a abordagem não pode tocar na lista.
  await candidato(50, PAUSADA, ORG_A, { status: "queued" });

  // --- move_list
  await campanha(ORIGEM, ORG_A, "Campinas", "paused", CONFIG, BUSCA);
  await campanha(ORIGEM_RODANDO, ORG_A, "rodando mover", "running", CONFIG, BUSCA);
  await campanha(ORIGEM_RASCUNHO, ORG_A, "rascunho mover", "draft", null, BUSCA);
  await campanha(ORIGEM_CONCLUIDA, ORG_A, "concluída", "completed", CONFIG, BUSCA);
  await campanha(ORIGEM_DA_ORG_B, ORG_B, "da B", "paused", CONFIG, BUSCA);

  const vivo = await contatoEConversa(1);
  const outro = await contatoEConversa(2);
  // Podem ir (4): nunca abordadas; a prévia guardada é de outra campanha e não acompanha.
  await candidato(1, ORIGEM, ORG_A, { status: "new" });
  await candidato(2, ORIGEM, ORG_A, { status: "queued" });
  await candidato(3, ORIGEM, ORG_A, {
    status: "skipped",
    selected: false,
    error: RAZAO_NAO_SELECIONADA,
  });
  await candidato(4, ORIGEM, ORG_A, {
    status: "new",
    data: { name: "Com prévia", previa: { mensagem: "Olá!", fonte: "estrategia" } },
  });
  // Ficam: o produto recusou, já foi abordada, falhou, já virou contato, já tem conversa,
  // ou é a linha-tomba de uma supressão de LGPD.
  await candidato(10, ORIGEM, ORG_A, {
    status: "skipped",
    selected: true,
    error: "Sem telefone brasileiro válido.",
  });
  await candidato(11, ORIGEM, ORG_A, { status: "sent" });
  await candidato(12, ORIGEM, ORG_A, { status: "failed", error: "falhou" });
  await candidato(13, ORIGEM, ORG_A, { status: "queued", contact: vivo.contato });
  await candidato(14, ORIGEM, ORG_A, { status: "queued", conversation: outro.conversa });
  await candidato(15, ORIGEM, ORG_A, { status: "queued", salt: true });
  // Origens que o `move_list` recusa e a concluída que ele aceita.
  await candidato(20, ORIGEM_RODANDO, ORG_A, { status: "queued" });
  await candidato(21, ORIGEM_RASCUNHO, ORG_A, { status: "new" });
  await candidato(22, ORIGEM_CONCLUIDA, ORG_A, { status: "new" });
  // Da outra organização.
  await candidato(30, ORIGEM_DA_ORG_B, ORG_B, { status: "queued" });
  await candidato(31, ORIGEM_DA_ORG_B, ORG_B, { status: "new" });
});
afterAll(() => pool.end());

describe("adjust_approach: troca a fonte da abordagem de uma campanha pausada", () => {
  it("campanha antiga (sem a chave) conta como `estrategia`, e a troca preserva todo o resto", async () => {
    expect(CONFIG).not.toHaveProperty("fonte_da_abordagem");
    const r = await adjustApproach(db, ORG_A, PAUSADA, {
      fonte_da_abordagem: "agente",
      instruction: "Apresentar a automação de agendamento para clínicas.",
    });
    expect(r.previous).toEqual({ fonte_da_abordagem: "estrategia", instruction_changed: false });
    expect(r.next).toEqual({ fonte_da_abordagem: "agente", instruction_changed: true });
    expect(await configDe(PAUSADA)).toEqual({
      ...CONFIG,
      fonte_da_abordagem: "agente",
      instruction: "Apresentar a automação de agendamento para clínicas.",
    });
    const { rows } = await pool.query("select status from prospecting_campaigns where id = $1", [
      PAUSADA,
    ]);
    expect(rows[0]?.status).toBe("paused");
  });

  it("sem instrução no pedido, a instrução gravada não é tocada", async () => {
    const antes = await configDe(PAUSADA);
    const r = await adjustApproach(db, ORG_A, PAUSADA, { fonte_da_abordagem: "estrategia" });
    expect(r.previous.fonte_da_abordagem).toBe("agente");
    expect(r.next).toEqual({ fonte_da_abordagem: "estrategia", instruction_changed: false });
    expect(await configDe(PAUSADA)).toEqual({ ...antes, fonte_da_abordagem: "estrategia" });
  });

  it("instrução igual à gravada não conta como mudança", async () => {
    const atual = (await configDe(PAUSADA))?.instruction as string;
    const r = await adjustApproach(db, ORG_A, PAUSADA, {
      fonte_da_abordagem: "estrategia",
      instruction: atual,
    });
    expect(r.next.instruction_changed).toBe(false);
  });

  it("a lista não muda: a empresa na fila continua na mesma campanha, no mesmo estado", async () => {
    expect(await estado(50)).toMatchObject({
      campaign_id: PAUSADA,
      status: "queued",
      selected: true,
    });
    expect(AJUSTE_DE_ABORDAGEM_SQL).not.toMatch(/prospecting_candidates/);
  });
});

describe("adjust_approach: quem não pode trocar não altera nada", () => {
  it("outra organização, com o id certo, recebe 404 e a linha não muda", async () => {
    const antes = await configDe(PAUSADA);
    await expect(
      adjustApproach(db, ORG_B, PAUSADA, {
        fonte_da_abordagem: "agente",
        instruction: "x".repeat(20),
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await configDe(PAUSADA)).toEqual(antes);
  });

  it("o update cru também recusa a organização errada — a guarda não mora só na leitura de antes", async () => {
    const antes = await configDe(PAUSADA);
    const { rows } = await pool.query(AJUSTE_DE_ABORDAGEM_SQL, [
      ORG_B,
      PAUSADA,
      JSON.stringify({ fonte_da_abordagem: "agente" }),
    ]);
    expect(rows).toHaveLength(0);
    expect(await configDe(PAUSADA)).toEqual(antes);
  });

  it("campanha rodando: 409 e a linha não muda", async () => {
    await expect(
      adjustApproach(db, ORG_A, RODANDO, { fonte_da_abordagem: "agente" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await configDe(RODANDO)).toEqual(CONFIG);
  });

  it("o update cru também recusa campanha que não está pausada", async () => {
    const { rows } = await pool.query(AJUSTE_DE_ABORDAGEM_SQL, [
      ORG_A,
      RODANDO,
      JSON.stringify({ fonte_da_abordagem: "agente" }),
    ]);
    expect(rows).toHaveLength(0);
    expect(await configDe(RODANDO)).toEqual(CONFIG);
  });

  it("rascunho sem configuração: 409 e a configuração continua nula", async () => {
    await expect(
      adjustApproach(db, ORG_A, RASCUNHO, { fonte_da_abordagem: "agente" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await configDe(RASCUNHO)).toBeNull();
  });

  it("o update cru recusa campanha pausada SEM configuração — `null || jsonb` criaria uma config de uma chave só", async () => {
    const { rows } = await pool.query(AJUSTE_DE_ABORDAGEM_SQL, [
      ORG_A,
      PAUSADA_SEM_CONFIG,
      JSON.stringify({ fonte_da_abordagem: "agente" }),
    ]);
    expect(rows).toHaveLength(0);
    expect(await configDe(PAUSADA_SEM_CONFIG)).toBeNull();
  });

  it("campanha que não existe: 404", async () => {
    await expect(
      adjustApproach(db, ORG_A, "0c120000-9999-4000-8000-000000000000", {
        fonte_da_abordagem: "agente",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("a campanha da outra organização continua com a configuração dela", async () => {
    expect(await configDe(OUTRA_ORG)).toEqual({ ...CONFIG, instruction: "Da B." });
  });
});

describe("move_list: leva só quem nunca foi abordado para uma campanha nova", () => {
  let nova = "";

  it("MOVE as 4 elegíveis; o resto fica na campanha antiga com o histórico", async () => {
    const r = await moverListaParaNovaCampanha(db, ORG_A, ORIGEM, REQ_MOVER);
    expect(r).toMatchObject({ moved: 4, repeated: false });
    nova = r.campaign_id;
    expect(nova).not.toBe(ORIGEM);

    expect(await candidatosDaCampanha(nova)).toEqual([cand(1), cand(2), cand(3), cand(4)]);
    expect(await candidatosDaCampanha(ORIGEM)).toEqual([10, 11, 12, 13, 14, 15].map(cand).sort());
  });

  it("as que foram vêm limpas: `new`, marcadas, sem motivo e sem a prévia da outra campanha", async () => {
    for (const n of [1, 2, 3, 4]) {
      const e = await estado(n);
      expect(e).toMatchObject({ campaign_id: nova, status: "new", selected: true, error: null });
    }
    // O resto do `data` (nome, site…) fica; só a prévia, que é da abordagem antiga, sai.
    expect(await estado(4).then((e) => e?.data)).toEqual({ name: "Com prévia" });
  });

  it("as que ficam não mudam de estado nem de motivo", async () => {
    expect(await estado(10)).toMatchObject({
      status: "skipped",
      error: "Sem telefone brasileiro válido.",
    });
    expect((await estado(11))?.status).toBe("sent");
    expect(await estado(12)).toMatchObject({ status: "failed", error: "falhou" });
    for (const n of [13, 14, 15]) expect((await estado(n))?.status).toBe("queued");
  });

  it("a campanha nova nasce em rascunho, sem configuração, com a busca da antiga já concluída", async () => {
    const { rows } = await pool.query(
      "select name, status, config, search, search_status, result_count from prospecting_campaigns where id = $1",
      [nova],
    );
    expect(rows[0]).toMatchObject({
      status: "draft",
      config: null,
      search: BUSCA,
      search_status: "succeeded",
      result_count: 4,
    });
    expect(rows[0].name).toContain("Campinas");
  });

  it("a campanha antiga segue pausada e com a configuração intacta", async () => {
    const { rows } = await pool.query(
      "select status, config from prospecting_campaigns where id = $1",
      [ORIGEM],
    );
    expect(rows[0].status).toBe("paused");
    expect(rows[0].config).toEqual(CONFIG);
  });

  it("repetir com o mesmo request_id devolve a mesma campanha e não move nem cria nada a mais", async () => {
    const antes = await totalDeCampanhas(ORG_A);
    const r = await moverListaParaNovaCampanha(db, ORG_A, ORIGEM, REQ_MOVER);
    expect(r).toEqual({ campaign_id: nova, moved: 4, repeated: true });
    expect(await totalDeCampanhas(ORG_A)).toBe(antes);
    expect(await candidatosDaCampanha(nova)).toHaveLength(4);
  });

  it("outro request_id, já sem ninguém a levar: 409 e a campanha nova que ele abriria é desfeita", async () => {
    const antes = await totalDeCampanhas(ORG_A);
    await expect(
      moverListaParaNovaCampanha(db, ORG_A, ORIGEM, REQ_MOVER_DE_NOVO),
    ).rejects.toMatchObject({ status: 409 });
    expect(await totalDeCampanhas(ORG_A)).toBe(antes);
    const { rows } = await pool.query(
      "select 1 from prospecting_campaigns where organization_id = $1 and request_id = $2",
      [ORG_A, REQ_MOVER_DE_NOVO],
    );
    expect(rows).toHaveLength(0);
  });

  it("campanha concluída também pode levar a lista", async () => {
    const r = await moverListaParaNovaCampanha(db, ORG_A, ORIGEM_CONCLUIDA, REQ_CONCLUIDA);
    expect(r).toMatchObject({ moved: 1, repeated: false });
    expect((await estado(22))?.campaign_id).toBe(r.campaign_id);
  });
});

describe("move_list: quem não pode levar não move nada", () => {
  it("campanha rodando: 409 e nada se move", async () => {
    await expect(
      moverListaParaNovaCampanha(db, ORG_A, ORIGEM_RODANDO, REQ_RODANDO),
    ).rejects.toMatchObject({ status: 409 });
    expect((await estado(20))?.campaign_id).toBe(ORIGEM_RODANDO);
  });

  it("rascunho: 409 e nada se move", async () => {
    await expect(
      moverListaParaNovaCampanha(db, ORG_A, ORIGEM_RASCUNHO, REQ_RASCUNHO),
    ).rejects.toMatchObject({ status: 409 });
    expect((await estado(21))?.campaign_id).toBe(ORIGEM_RASCUNHO);
  });

  it("campanha que não existe: 404", async () => {
    await expect(
      moverListaParaNovaCampanha(
        db,
        ORG_A,
        "0c120000-9999-4000-8000-000000000000",
        "0c120000-5555-4000-8000-0000000000ff",
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("outra organização, com o id certo da campanha, recebe 404 e as linhas da primeira não se movem", async () => {
    const antes = await candidatosDaCampanha(ORIGEM);
    const campanhasDeB = await totalDeCampanhas(ORG_B);
    await expect(
      moverListaParaNovaCampanha(db, ORG_B, ORIGEM, REQ_OUTRA_ORG),
    ).rejects.toMatchObject({ status: 404 });
    expect(await candidatosDaCampanha(ORIGEM)).toEqual(antes);
    expect(await totalDeCampanhas(ORG_B)).toBe(campanhasDeB);
  });

  it("o recibo é por organização: o request_id da A, usado pela B, não devolve a campanha da A", async () => {
    await expect(moverListaParaNovaCampanha(db, ORG_B, ORIGEM, REQ_MOVER)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("o update cru também recusa a organização errada — a guarda não mora só na leitura de antes", async () => {
    // Quem ainda está na ORIGEM da A (de fato elegível, no estado em que o teste deixou a
    // campanha) é consultado como se a B mandasse: nenhuma linha pode sair.
    const alvoDaB = (
      await pool.query<{ id: string }>(
        "insert into prospecting_campaigns(organization_id,request_id,name,search) values($1,gen_random_uuid(),'alvo da B','{}') returning id",
        [ORG_B],
      )
    ).rows[0]!.id;
    await candidato(40, ORIGEM, ORG_A, { status: "new" });
    const { rows } = await pool.query(MOVER_LISTA_SQL, [
      ORG_B,
      ORIGEM,
      alvoDaB,
      RAZAO_NAO_SELECIONADA,
    ]);
    expect(rows).toHaveLength(0);
    expect((await estado(40))?.campaign_id).toBe(ORIGEM);
  });

  it("a B leva a lista dela sem encostar na da A", async () => {
    const r = await moverListaParaNovaCampanha(db, ORG_B, ORIGEM_DA_ORG_B, REQ_DA_ORG_B);
    expect(r).toMatchObject({ moved: 2, repeated: false });
    expect(await candidatosDaCampanha(r.campaign_id)).toEqual([cand(30), cand(31)]);
    // A empresa 40 da A (elegível) continua onde estava.
    expect((await estado(40))?.campaign_id).toBe(ORIGEM);
    const { rows } = await pool.query(
      "select organization_id from prospecting_candidates where id = any($1)",
      [[cand(30), cand(31)]],
    );
    expect(rows.every((l) => l.organization_id === ORG_B)).toBe(true);
  });
});
