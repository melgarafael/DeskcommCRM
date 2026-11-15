/**
 * EDITAR A INSTRUÇÃO, OS CRITÉRIOS E AS OFERTAS DE UMA CAMPANHA PAUSADA — issue #4570.
 *
 * `tests/unit/prospeccao-editar-instrucao.test.ts` prova o formato e o texto do
 * `update`. Aqui se prova, contra Postgres de verdade, o que só uma linha
 * responde:
 *
 * 1. campanha pausada troca instrução, critérios e ofertas e MANTÉM o resto —
 *    agente, conexão, funil, base legal e ritmo. O `||` preserva por construção
 *    e o teste é o que reprova uma troca por `set config = $3`;
 * 2. DOC 358 › 1A (decisão do dono, 15/11): o texto novo vale SÓ para quem
 *    ainda não foi abordado. A conversa já aberta segue com o texto com que
 *    começou, também nos próximos turnos; a empresa abordada DEPOIS da edição
 *    conversa com o texto novo; e a prévia escrita com o texto velho não sai
 *    (descartada na edição, e vencida se o preparo a terminar durante a edição);
 * 3. o histórico JÁ trocado não é reescrito — mensagens ficam byte a byte como
 *    estavam;
 * 4. campanha rodando continua recusando com 409 (a mesma régua das irmãs), e
 *    outra organização recebe 404 — provado também no `update` cru, porque a
 *    leitura de antes pode sumir num refactor e o teste da função continuaria
 *    verde.
 *
 * Cada arquivo de invariante recebe um banco novo (`tests/db/banco-limpo-por-arquivo.ts`),
 * então os ids da fixture não colidem com nenhum outro arquivo.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { prospectingConversationContext } from "@/lib/prospecting/context";
import { gravarPrevia, previaDoAgente, type DadosDaPrevia } from "@/lib/prospecting/previa";
import {
  EDICAO_DO_BRIEFING_SQL,
  editBriefing,
  MENSAGEM_DE_CAMPANHA_PAUSADA_PARA_EDITAR,
} from "@/lib/prospecting/store";
import { campaignConfigSchema } from "@/lib/prospecting/schema";
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

const TEXTO_ANTIGO = "Converse com empresas que responderam à campanha.";
const CRITERIO_ANTIGO = "Confirmar como a empresa atende os pedidos de seus clientes.";

const NOVO = {
  instruction: "Ofereça a auditoria do site e proponha uma conversa de quinze minutos.",
  qualification: "Confirmou que os pedidos chegam pelo WhatsApp e quer responder mais rápido.",
  ofertas: ["site", "automacao_crm"] as const,
};

let f: FixtureDeOfertas;
/** Segunda campanha, em OUTRA organização: só o status muda (rodando). */
let rodando: FixtureDeOfertas;
let orgAlheia: string;
/** Empresa da MESMA campanha que ainda está na fila, com a prévia escrita antes da edição. */
const naFila = { candidate: randomUUID(), contact: randomUUID(), conversation: "" };
const PREVIA_VELHA = "Olá! Rascunho escrito com o texto antigo da campanha.";

const ORG_A = "0a130000-0000-4000-8000-000000000001";
const ORG_B = "0a130000-0000-4000-8000-000000000002";

async function configDe(id: string): Promise<Record<string, unknown> | null> {
  const { rows } = await pool.query("select config from prospecting_campaigns where id=$1", [id]);
  return rows[0]?.config ?? null;
}

async function historicoDa(conversation: string) {
  const { rows: mensagens } = await pool.query(
    "select id, body, direction, sent_at from messages where conversation_id=$1 order by id",
    [conversation],
  );
  const { rows: candidatos } = await pool.query(
    "select id, status, conversation_id, message_id, contact_id, data from prospecting_candidates where conversation_id=$1 order by id",
    [conversation],
  );
  return { mensagens, candidatos };
}

beforeAll(async () => {
  orgAlheia = "0a130000-0000-4000-8000-000000000099";
  for (const [org, slug] of [
    [ORG_A, "edicao-qa-a"],
    [ORG_B, "edicao-qa-b"],
    [orgAlheia, "edicao-qa-alheia"],
  ] as const) {
    await pool.query(
      "insert into organizations(id,slug,legal_name,display_name) values($1,$2,'Edição QA','Edição QA')",
      [org, slug],
    );
  }
  f = await criarFixtureDeOfertas(pool, ORG_A);
  rodando = await criarFixtureDeOfertas(pool, ORG_B);
  // A empresa na fila: contato e conversa próprios (ainda sem mensagem), status
  // `queued` e uma prévia válida, escrita pelo agente da campanha ANTES da edição.
  const telefone = `+5511988${String(parseInt(naFila.contact.slice(0, 8), 16)).slice(-6).padStart(6, "0")}`;
  await pool.query(
    "insert into contacts(id,organization_id,name,display_name,phone_number) values($1,$2,'Na fila QA','Na fila QA',$3)",
    [naFila.contact, ORG_A, telefone],
  );
  const { rows } = await pool.query<{ boundary: { conversation_id: string } }>(
    "select fn_service_begin($1,$2,$3) as boundary",
    [ORG_A, naFila.contact, f.channel],
  );
  naFila.conversation = rows[0]!.boundary.conversation_id;
  const verificado = "2026-11-01T00:00:00.000Z";
  await pool.query(
    "insert into prospecting_candidates(id,organization_id,campaign_id,place_id,phone,data,status,contact_id) values($1,$2,$3,$4,$5,$6::jsonb,'queued',$7)",
    [
      naFila.candidate, ORG_A, f.campaign, `na-fila-${naFila.candidate}`, telefone,
      JSON.stringify({
        key: naFila.candidate, name: "Na fila QA", phone: telefone, website: null,
        category: "Clínicas", address: null, maps_url: null, rating: null, reviews: 0,
        emails: [], socials: [],
        site: {
          ver: 1, classe: "sem-site", problemas: [], checklist: { tem: [], falta: [] },
          final_url: null, http_status: null, tempo_ms: null, conteudo_resumo: null,
          pagespeed: null, verificado_em: verificado, provisorio: false, tentativas: 0,
        },
        previa: {
          texto: PREVIA_VELHA, baseada_em: `sem-site@${verificado}`,
          gerada_em: verificado, agente_id: f.agent,
        },
      }),
      naFila.contact,
    ],
  );
  // A fixture nasce pausada. Para provar a recusa da irmã, esta retoma — a
  // coluna `channel_session_id` sai da config, como o `start` grava (o CHECK
  // `prospecting_campaigns_running_tem_canal` exige o número ao retomar).
  await pool.query(
    "update prospecting_campaigns set status='running', channel_session_id=(config->>'channel_session_id')::uuid where id=$1",
    [rodando.campaign],
  );
});

afterAll(async () => {
  try {
    // A conversa da empresa na fila usa o canal da fixture: sai antes dele.
    if (naFila.conversation)
      await pool.query("delete from conversations where id=$1", [naFila.conversation]);
    if (f) await limparFixtureDeOfertas(pool, f);
    await pool.query("delete from contacts where id=$1", [naFila.contact]);
    if (rodando) await limparFixtureDeOfertas(pool, rodando);
    for (const org of [ORG_A, ORG_B, orgAlheia]) {
      await pool.query("delete from organizations where id=$1", [org]);
    }
  } finally {
    await pool.end();
  }
});

describe("a campanha pausada passa a falar o texto novo, e só ele", () => {
  it("antes da edição o contexto da conversa traz o texto antigo", async () => {
    const texto = await prospectingConversationContext(pool, f.org, f.conversation);
    expect(texto).toContain(`Objetivo definido pelo operador: ${TEXTO_ANTIGO}`);
    expect(texto).toContain(`Critérios de qualificação a confirmar com a pessoa: ${CRITERIO_ANTIGO}`);
  });

  it("edita instrução, critérios e ofertas e preserva o resto da configuração", async () => {
    const antes = (await configDe(f.campaign)) ?? {};
    const resultado = await editBriefing(pool as unknown as pg.Pool, f.org, f.campaign, {
      ...NOVO,
      ofertas: [...NOVO.ofertas],
    });
    expect(resultado.previous).toEqual({
      instruction: TEXTO_ANTIGO,
      qualification: CRITERIO_ANTIGO,
      ofertas: ["site", "automacao_crm", "automacao_n8n"],
    });
    const depois = (await configDe(f.campaign)) ?? {};
    expect(depois).toEqual({
      ...antes,
      instruction: NOVO.instruction,
      qualification: NOVO.qualification,
      ofertas: [...NOVO.ofertas],
      briefing_editado_em: expect.any(String),
    });
    // O que NÃO podia mudar, nomeado: a edição não pode arrastar o resto junto.
    for (const chave of [
      "agent_id",
      "channel_session_id",
      "pipeline_id",
      "stage_id",
      "qualified_stage_id",
      "legal_basis_ref",
      "daily_limit",
      "interval_minutes",
    ]) {
      expect(depois[chave], `a chave ${chave} não pode mudar na edição do briefing`).toEqual(
        antes[chave],
      );
    }
    // A configuração gravada continua passando no schema que o turno usa.
    expect(campaignConfigSchema.safeParse(depois).success).toBe(true);
  });

  it("a conversa JÁ ABERTA segue com o texto com que começou", async () => {
    const texto = await prospectingConversationContext(pool, f.org, f.conversation);
    expect(texto).toContain(`Objetivo definido pelo operador: ${TEXTO_ANTIGO}`);
    expect(texto).toContain(`Critérios de qualificação a confirmar com a pessoa: ${CRITERIO_ANTIGO}`);
    expect(texto).not.toContain(NOVO.instruction);
  });

  it("a prévia escrita com o texto velho sai da fila", async () => {
    const { rows } = await pool.query<{ data: Record<string, unknown> }>(
      "select data from prospecting_candidates where id=$1",
      [naFila.candidate],
    );
    expect(rows[0]?.data).not.toHaveProperty("previa");
    // O resto do que se sabe da empresa fica.
    expect(rows[0]?.data).toHaveProperty("site");
  });

  it("a prévia que o preparo terminou com o texto velho DURANTE a edição nasce vencida", async () => {
    // O preparo não toma o bloqueio da edição: leu a config antiga, gerou, e grava depois.
    await gravarPrevia(pool, {
      organizationId: f.org,
      campaignId: f.campaign,
      candidateId: naFila.candidate,
      previa: {
        texto: PREVIA_VELHA,
        baseada_em: "sem-site@2026-11-01T00:00:00.000Z",
        gerada_em: new Date().toISOString(),
        agente_id: f.agent,
      },
    });
    const cfg = campaignConfigSchema.parse(await configDe(f.campaign));
    const { rows } = await pool.query<{ data: DadosDaPrevia }>(
      "select data from prospecting_candidates where id=$1",
      [naFila.candidate],
    );
    expect(previaDoAgente(rows[0]!.data, cfg.agent_id, cfg.briefing_editado_em)).toBeNull();
    // A que o preparo escreve DEPOIS, com o texto novo, leva o carimbo atual e vale.
    await gravarPrevia(pool, {
      organizationId: f.org,
      campaignId: f.campaign,
      candidateId: naFila.candidate,
      previa: {
        texto: "Olá! Rascunho com o texto novo.",
        baseada_em: "sem-site@2026-11-01T00:00:00.000Z",
        gerada_em: new Date().toISOString(),
        agente_id: f.agent,
        briefing_editado_em: cfg.briefing_editado_em,
      },
    });
    const { rows: depois } = await pool.query<{ data: DadosDaPrevia }>(
      "select data from prospecting_candidates where id=$1",
      [naFila.candidate],
    );
    expect(previaDoAgente(depois[0]!.data, cfg.agent_id, cfg.briefing_editado_em)?.texto).toBe(
      "Olá! Rascunho com o texto novo.",
    );
  });

  it("a empresa abordada DEPOIS da edição conversa com o texto novo, sem o antigo", async () => {
    // O que o envio grava ao abordar: status e conversa do candidato.
    await pool.query(
      "update prospecting_candidates set status='sent', conversation_id=$2, attempted_at=now() where id=$1",
      [naFila.candidate, naFila.conversation],
    );
    const texto = await prospectingConversationContext(pool, f.org, naFila.conversation);
    expect(texto).toContain(`Objetivo definido pelo operador: ${NOVO.instruction}`);
    expect(texto).toContain(
      `Critérios de qualificação a confirmar com a pessoa: ${NOVO.qualification}`,
    );
    expect(texto).not.toContain(TEXTO_ANTIGO);
    expect(texto).not.toContain(CRITERIO_ANTIGO);
    // As ofertas novas também chegam: a primeira da lista manda no argumento.
    expect(texto).toContain(
      "O que esta campanha vende, em ordem: Site profissional; Automação do atendimento (CRM).",
    );
  });

  it("a campanha segue pausada depois da edição", async () => {
    const { rows } = await pool.query("select status from prospecting_campaigns where id=$1", [
      f.campaign,
    ]);
    expect(rows[0]?.status).toBe("paused");
  });
});

describe("a conversa já em andamento não é reescrita", () => {
  it("mensagens e candidato ficam como estavam: nada de histórico regravado", async () => {
    // Uma segunda edição, com o histórico já formado, para capturar antes/depois.
    const antes = await historicoDa(f.conversation);
    await editBriefing(pool as unknown as pg.Pool, f.org, f.campaign, {
      instruction: `${NOVO.instruction} Peça permissão antes de falar de preço.`,
      qualification: NOVO.qualification,
      ofertas: ["automacao_crm"],
    });
    const depois = await historicoDa(f.conversation);
    expect(depois).toEqual(antes);
    expect(depois.mensagens).toHaveLength(1);
  });

  it("nem a segunda edição alcança o PRÓXIMO turno das conversas já abertas", async () => {
    // A primeira conversa segue com o texto com que começou, mesmo duas edições depois.
    const texto = await prospectingConversationContext(pool, f.org, f.conversation);
    expect(texto).toContain(`Objetivo definido pelo operador: ${TEXTO_ANTIGO}`);
    expect(texto).not.toContain("Peça permissão antes de falar de preço.");
    // A abordada entre as duas edições segue com o texto da primeira edição.
    const daFila = await prospectingConversationContext(pool, f.org, naFila.conversation);
    expect(daFila).toContain(`Objetivo definido pelo operador: ${NOVO.instruction}`);
    expect(daFila).not.toContain("Peça permissão antes de falar de preço.");
    // E o que já foi trocado não volta atrás: a mensagem antiga continua sendo a antiga.
    const { rows } = await pool.query<{ body: string }>(
      "select body from messages where conversation_id=$1",
      [f.conversation],
    );
    expect(rows[0]?.body).toContain("Este é o histórico sintético da prova");
  });
});

describe("quem não pode editar não altera nada", () => {
  it("campanha rodando: 409 com a mensagem das irmãs, e a linha não muda", async () => {
    const antes = await configDe(rodando.campaign);
    await expect(
      editBriefing(pool as unknown as pg.Pool, rodando.org, rodando.campaign, {
        ...NOVO,
        ofertas: [...NOVO.ofertas],
      }),
    ).rejects.toMatchObject({ status: 409, message: MENSAGEM_DE_CAMPANHA_PAUSADA_PARA_EDITAR });
    expect(await configDe(rodando.campaign)).toEqual(antes);
  });

  it("o update cru também recusa a campanha rodando — a guarda não mora só na leitura", async () => {
    const antes = await configDe(rodando.campaign);
    const { rows } = await pool.query(EDICAO_DO_BRIEFING_SQL, [
      rodando.org,
      rodando.campaign,
      "Qualquer texto novo.",
      "Qualquer critério novo.",
      JSON.stringify(["site"]),
      new Date().toISOString(),
    ]);
    expect(rows).toHaveLength(0);
    expect(await configDe(rodando.campaign)).toEqual(antes);
  });

  it("outra organização, com o id certo da campanha, recebe 404 e a linha não muda", async () => {
    const antes = await configDe(f.campaign);
    await expect(
      editBriefing(pool as unknown as pg.Pool, orgAlheia, f.campaign, {
        ...NOVO,
        ofertas: [...NOVO.ofertas],
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await configDe(f.campaign)).toEqual(antes);
  });

  it("o update cru também recusa a organização errada", async () => {
    const antes = await configDe(f.campaign);
    const { rows } = await pool.query(EDICAO_DO_BRIEFING_SQL, [
      orgAlheia,
      f.campaign,
      "Qualquer texto novo.",
      "Qualquer critério novo.",
      JSON.stringify(["site"]),
      new Date().toISOString(),
    ]);
    expect(rows).toHaveLength(0);
    expect(await configDe(f.campaign)).toEqual(antes);
  });

  it("campanha pausada SEM configuração recusa: `null || jsonb` apagaria tudo", async () => {
    const vazia = await criarFixtureDeOfertas(pool, f.org);
    try {
      await pool.query("update prospecting_campaigns set config=null where id=$1", [vazia.campaign]);
      await expect(
        editBriefing(pool as unknown as pg.Pool, f.org, vazia.campaign, {
          ...NOVO,
          ofertas: [...NOVO.ofertas],
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(await configDe(vazia.campaign)).toBeNull();
    } finally {
      await limparFixtureDeOfertas(pool, vazia);
    }
  });
});
