import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { garantirLeadDaConversa } from "@/lib/leads/nascimento-do-lead";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * O NEGÓCIO PERDIDO DE MINUTOS ATRÁS NÃO VIRA CARD VAZIO (#4076).
 *
 * ═══ O DEFEITO, COMO O AUTOR DA ISSUE MEDIU ═══
 *
 * `garantirLeadDaConversa` só olhava "existe algum negócio ABERTO?". Com o
 * último marcado perdido minutos antes, a resposta era não — e nascia um card
 * novo, em "Contato Inicial", SEM descrição, SEM os campos e SEM o motivo da
 * perda, que ficavam no card perdido. Na operação dele: **5 de 7 negócios
 * perdidos em 9 dias geraram um card novo em até 85 minutos**, e em 3 de 4
 * contatos o gatilho era só a mensagem de despedida ("obrigado, qualquer coisa
 * eu chamo"). Dois cards do mesmo contato, e o histórico comercial no fantasma.
 *
 * ═══ O QUE ESTE ARQUIVO CONGELA ═══
 *
 * Com `settings.reabrir_perdido_dias` no funil e o perdido DENTRO da janela, a
 * mensagem REABRE O MESMO card: mesmo `id`, `status` de volta a `open`, etapa de
 * origem, descrição/campos/motivo intactos, UM card só. Os oito lados opostos
 * da issue estão aqui, um `it` cada: opção desligada (= hoje), fora da janela,
 * sem nenhum negócio, dois perdidos (reabre o mais recente), outra organização,
 * sem laço de automação, motivo preservado com registro de quem reabriu, e dono
 * intacto.
 *
 * ═══ POR QUE INVARIANTE DE BANCO ═══
 *
 * Quem devolve o `status` é o GATILHO `fn_crm_lead_close_on_stage` (P-02: ele é
 * o único escritor de `status`), e é ele também que zera `lost_from_stage_id` e
 * `closed_at` ao reabrir. Uma reescrita em mock provaria que a função chama
 * `update`, não que o card volta a `open` — e o defeito desta issue é
 * exatamente um card no estado errado.
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
const db = pgComoSupabase(pool);

/** A opção LIGADA, 30 dias — o cenário do GREEN. */
const ORG_REABRE = "4076a000-0000-4000-8000-000000000001";
/** Nenhuma opção gravada — o comportamento de HOJE, e o RED literal. */
const ORG_PADRAO = "4076a000-0000-4000-8000-000000000002";
/** Opção ligada, mas o funil já escolheu `novo_negocio` na retomada. */
const ORG_RETOMA_NOVO = "4076a000-0000-4000-8000-000000000003";
/** Outro tenant, com a MESMA pessoa como contato (mesmo telefone). */
const ORG_VIZINHA = "4076a000-0000-4000-8000-000000000004";

const CONVERSA = "4076a000-0000-4000-8000-00000000c001";
const DONO = "4076a000-0000-4000-8000-00000000d001";

interface Funil {
  pipelineId: string;
  /** Primeira etapa aberta — onde o card nasce. */
  entrada: string;
  /** Segunda etapa aberta — de onde o card "morreu" nos casos abaixo. */
  meio: string;
  /** A etapa de perda do funil. */
  perdido: string;
}

let funilReabre: Funil;
let funilPadrao: Funil;
let funilRetomaNovo: Funil;
let funilVizinho: Funil;

async function criarOrg(id: string, slug: string): Promise<void> {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, $2, 'Reabertura LTDA', 'Reabertura') on conflict (id) do nothing`,
    [id, slug],
  );
}

async function criarContato(org: string, nome: string, telefone: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, source, phone_number)
     values ($1, $2, 'whatsapp', $3) returning id`,
    [org, nome, telefone],
  );
  return rows[0]!.id;
}

/** O funil padrão que o trigger semeou + as etapas que os casos usam. */
async function lerFunil(org: string): Promise<Funil> {
  const { rows: pipelines } = await pool.query<{ id: string }>(
    `select id from crm_pipelines
      where organization_id = $1 and is_default = true
      order by position asc limit 1`,
    [org],
  );
  const pipelineId = pipelines[0]!.id;
  const { rows: etapas } = await pool.query<{ id: string; is_lost: boolean }>(
    `select id, is_lost from crm_stages
      where organization_id = $1 and pipeline_id = $2
      order by position asc`,
    [org, pipelineId],
  );
  const abertas = etapas.filter((e) => !e.is_lost);
  const perdido = etapas.find((e) => e.is_lost);
  if (abertas.length < 2 || !perdido) {
    throw new Error(`funil semeado de ${org} precisa de 2 etapas abertas e 1 de perda`);
  }
  return { pipelineId, entrada: abertas[0]!.id, meio: abertas[1]!.id, perdido: perdido.id };
}

/** A opção no jsonb do funil — a MESMA chave que a tela grava. */
async function configurar(funil: Funil, settings: Record<string, unknown>): Promise<void> {
  await pool.query(
    `update crm_pipelines set settings = coalesce(settings, '{}'::jsonb) || $2::jsonb where id = $1`,
    [funil.pipelineId, JSON.stringify(settings)],
  );
}

interface PerdidoDeTeste {
  org: string;
  contato: string;
  funil: Funil;
  /** `interval` do Postgres: '5 minutes', '20 days', '60 days'. */
  quando: string;
  descricao?: string | null;
  campos?: Record<string, unknown>;
  motivo?: string;
  /** Etapa de onde ele saiu — o `lost_from_stage_id` (migration 0426). */
  deEtapa?: string;
  dono?: string;
}

/**
 * O card PERDIDO, gravado direto — é o estado em que o produto o deixa depois
 * de "marcar como perdido". `status` e `closed_at` aqui são escrita da fixture;
 * quem os escreve no produto é o gatilho de etapa.
 */
async function criarPerdido(p: PerdidoDeTeste): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into crm_leads
       (organization_id, pipeline_id, stage_id, contact_id, title, status, lost_reason,
        closed_at, lost_from_stage_id, description, custom_fields, owner_user_id, assigned_at)
     values ($1, $2, $3, $4, 'Negócio que morreu', 'lost', $5, now() - $6::interval, $7, $8, $9::jsonb, $10,
             case when $10::uuid is null then null else now() - interval '3 hours' end)
     returning id`,
    [
      p.org,
      p.funil.pipelineId,
      p.funil.perdido,
      p.contato,
      p.motivo ?? "price",
      p.quando,
      p.deEtapa ?? p.funil.meio,
      p.descricao ?? "Pedido de 3 portas de correr, medida 2,10 x 0,90",
      JSON.stringify(p.campos ?? { origem_do_contato: "site", ambientes: 4 }),
      p.dono ?? null,
    ],
  );
  return rows[0]!.id;
}

interface LinhaDoCard {
  id: string;
  status: string;
  stage_id: string;
  description: string | null;
  custom_fields: Record<string, unknown>;
  lost_reason: string | null;
  closed_at: Date | null;
  lost_from_stage_id: string | null;
  owner_user_id: string | null;
  assigned_at: Date | null;
}

async function cardsDoContato(contato: string): Promise<LinhaDoCard[]> {
  const { rows } = await pool.query<LinhaDoCard>(
    `select id, status, stage_id, description, custom_fields, lost_reason, closed_at,
            lost_from_stage_id, owner_user_id, assigned_at
       from crm_leads where contact_id = $1 order by created_at asc`,
    [contato],
  );
  return rows;
}

async function cardPorId(id: string): Promise<LinhaDoCard> {
  const { rows } = await pool.query<LinhaDoCard>(
    `select id, status, stage_id, description, custom_fields, lost_reason, closed_at,
            lost_from_stage_id, owner_user_id, assigned_at
       from crm_leads where id = $1`,
    [id],
  );
  return rows[0]!;
}

/** A mensagem chegou: é ESTE o chamador do nascimento do card. */
async function mensagemChegou(org: string, contato: string, nome: string) {
  return garantirLeadDaConversa(db, {
    organizationId: org,
    contactId: contato,
    conversationId: CONVERSA,
    nomeDoContato: nome,
  });
}

beforeAll(async () => {
  await criarOrg(ORG_REABRE, "org-4076-reabre");
  await criarOrg(ORG_PADRAO, "org-4076-padrao");
  await criarOrg(ORG_RETOMA_NOVO, "org-4076-retoma-novo");
  await criarOrg(ORG_VIZINHA, "org-4076-vizinho");

  await pool.query("insert into auth.users (id, email) values ($1, $2)", [
    DONO,
    "dono-do-negocio@invariant.test",
  ]);
  // Sem vínculo ativo, o gatilho de responsável recusa: "Responsável não é um
  // atendente ativo desta organização". O dono do caso precisa ser atendente.
  await pool.query(
    `insert into user_organizations (user_id, organization_id, role, accepted_at)
     values ($1, $2, 'agent', now())`,
    [DONO, ORG_REABRE],
  );

  funilReabre = await lerFunil(ORG_REABRE);
  funilPadrao = await lerFunil(ORG_PADRAO);
  funilRetomaNovo = await lerFunil(ORG_RETOMA_NOVO);
  funilVizinho = await lerFunil(ORG_VIZINHA);

  await configurar(funilReabre, { reabrir_perdido_dias: 30 });
  await configurar(funilVizinho, { reabrir_perdido_dias: 30 });
  // `novo_negocio` é a decisão explícita deste funil sobre "encerrado que
  // volta" (#1538): nova tentativa, com a perda anterior registrada. Ela vence
  // a janela — as duas respondem a MESMA pergunta, e não podem valer juntas.
  await configurar(funilRetomaNovo, { reabrir_perdido_dias: 30, reabertura: "novo_negocio" });
  // ORG_PADRAO não recebe nada: é o funil de todo mundo hoje.
});

afterAll(async () => {
  await pool.end();
});

describe("#4076 · o perdido de minutos atrás volta a ser o MESMO card", () => {
  it("GREEN · opção ligada: reabre o card perdido, mesmo id, histórico intacto, UM card", async () => {
    const contato = await criarContato(ORG_REABRE, "Cliente Que Voltou", "+5511990000001");
    const perdidoId = await criarPerdido({
      org: ORG_REABRE,
      contato,
      funil: funilReabre,
      quando: "5 minutes",
      motivo: "price",
      deEtapa: funilReabre.meio,
    });

    const r = await mensagemChegou(ORG_REABRE, contato, "Cliente Que Voltou");

    // O estado lido ANTES da asserção, e na mensagem dela: quando isto falha, o
    // que se quer ver é o defeito inteiro (ids, status, descrição) — não um
    // "expected true to be false" que obriga a rodar de novo para investigar.
    const cards = await cardsDoContato(contato);
    expect(
      r.criado,
      `esperava reabrir. Nascimento: ${JSON.stringify(r)}. Cards do contato: ${JSON.stringify(cards)}`,
    ).toBe(false);
    if (r.criado) return;
    expect(r.motivo).toBe("reaberto");
    // O MESMO id — é isto que a issue pede: nada de card novo, nada de cópia.
    expect(r.leadId).toBe(perdidoId);

    // Um card só — o perdido reaberto.
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.id).toBe(perdidoId);
    // Quem devolveu o status foi o GATILHO, não a função: `stage_id` mudou e
    // `fn_crm_lead_close_on_stage` fez o resto (é o único escritor de `status`).
    expect(card.status).toBe("open");
    expect(card.closed_at, "aberto não tem data de fechamento").toBeNull();
    expect(card.stage_id, "volta para a etapa de onde saiu").toBe(funilReabre.meio);
    // O HISTÓRICO COMERCIAL — o que a issue relata ter ficado no fantasma.
    expect(card.description).toBe("Pedido de 3 portas de correr, medida 2,10 x 0,90");
    expect(card.custom_fields).toMatchObject({ origem_do_contato: "site", ambientes: 4 });
    // O MOTIVO DA PERDA não é apagado: é a memória de por que a tentativa
    // anterior morreu. Apagá-lo faria o card reaberto mentir sobre o passado.
    expect(card.lost_reason).toBe("price");
    // O gatilho zerou a etapa de origem ao reabrir (0426) — a passagem fica na
    // timeline, que é o `it` do "motivo preservado".
    expect(card.lost_from_stage_id).toBeNull();
  });

  it("RED literal · opção desligada (o padrão de hoje): nasce um SEGUNDO card, vazio", async () => {
    const contato = await criarContato(ORG_PADRAO, "Cliente Sem Opção", "+5511990000002");
    const perdidoId = await criarPerdido({
      org: ORG_PADRAO,
      contato,
      funil: funilPadrao,
      quando: "5 minutes",
    });

    const r = await mensagemChegou(ORG_PADRAO, contato, "Cliente Sem Opção");

    expect(r.criado, "sem a opção, o comportamento é o de hoje").toBe(true);
    if (!r.criado) return;
    expect(r.leadId).not.toBe(perdidoId);

    const cards = await cardsDoContato(contato);
    expect(cards, "dois cards do mesmo contato — o defeito da issue").toHaveLength(2);

    const novo = cards.find((c) => c.id !== perdidoId)!;
    const antigo = cards.find((c) => c.id === perdidoId)!;
    // O CARD VAZIO: nasce na entrada, SEM descrição, SEM os campos e SEM o
    // motivo da perda — e o histórico comercial fica no card perdido.
    expect(novo.status).toBe("open");
    expect(novo.stage_id).toBe(funilPadrao.entrada);
    expect(novo.description, "o card novo nasce sem a descrição do negócio").toBeNull();
    expect(
      novo.custom_fields.origem_do_contato,
      "os campos comerciais ficam no card perdido",
    ).toBeUndefined();
    expect(antigo.status, "o histórico continua no fantasma").toBe("lost");
    expect(antigo.description).not.toBeNull();
    expect(antigo.lost_reason).toBe("price");
  });

  it("fora da janela: perdido há 60 dias, janela de 30 — card novo, e o perdido continua perdido", async () => {
    const contato = await criarContato(
      ORG_REABRE,
      "Cliente Do Trimestre Passado",
      "+5511990000003",
    );
    const perdidoId = await criarPerdido({
      org: ORG_REABRE,
      contato,
      funil: funilReabre,
      quando: "60 days",
    });
    const antes = await cardPorId(perdidoId);

    const r = await mensagemChegou(ORG_REABRE, contato, "Cliente Do Trimestre Passado");

    expect(r.criado, "reabrir um morto antigo esconderia a rotatividade").toBe(true);
    const cards = await cardsDoContato(contato);
    expect(cards).toHaveLength(2);
    const antigo = await cardPorId(perdidoId);
    expect(antigo.status).toBe("lost");
    expect(antigo.closed_at, "a perda continua registrada na data dela").toEqual(antes.closed_at);
    expect(antigo.lost_from_stage_id, "e a etapa de origem continua lá").toBe(funilReabre.meio);
  });

  it("contato SEM nenhum negócio: nasce normal (a opção não inventa card)", async () => {
    const contato = await criarContato(ORG_REABRE, "Cliente Novo", "+5511990000004");

    const r = await mensagemChegou(ORG_REABRE, contato, "Cliente Novo");

    expect(r.criado).toBe(true);
    if (!r.criado) return;
    const cards = await cardsDoContato(contato);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.stage_id).toBe(funilReabre.entrada);
    expect(cards[0]!.status).toBe("open");
  });

  it("dois perdidos do mesmo contato: reabre o MAIS RECENTE, um só, e o outro fica perdido", async () => {
    const contato = await criarContato(ORG_REABRE, "Cliente Com Duas Perdas", "+5511990000005");
    const antigo = await criarPerdido({
      org: ORG_REABRE,
      contato,
      funil: funilReabre,
      quando: "20 days",
      motivo: "no_response",
      descricao: "Primeira tentativa",
    });
    const recente = await criarPerdido({
      org: ORG_REABRE,
      contato,
      funil: funilReabre,
      quando: "5 minutes",
      motivo: "price",
      descricao: "Segunda tentativa",
    });

    const r = await mensagemChegou(ORG_REABRE, contato, "Cliente Com Duas Perdas");

    expect(r.criado).toBe(false);
    if (r.criado) return;
    // A REGRA: o card que volta é o ÚLTIMO que morreu — é o que a mensagem de
    // hoje está respondendo. Reabrir os dois seria fundir histórico, e a issue
    // proíbe fundir.
    expect(r.leadId, "o mais recente, e não o mais antigo").toBe(recente);
    const cards = await cardsDoContato(contato);
    expect(cards, "um card aberto só").toHaveLength(2);
    expect(cards.find((c) => c.id === antigo)!.status, "o antigo não é tocado").toBe("lost");
    expect(cards.filter((c) => c.status === "open")).toHaveLength(1);
    expect((await cardPorId(recente)).stage_id).toBe(funilReabre.meio);
  });

  it("outra organização: o card perdido do vizinho NUNCA é usado, nem com o mesmo telefone", async () => {
    const telefone = "+5511990000006";
    const contatoDoVizinho = await criarContato(ORG_VIZINHA, "Mesma Pessoa", telefone);
    const doVizinho = await criarPerdido({
      org: ORG_VIZINHA,
      contato: contatoDoVizinho,
      funil: funilVizinho,
      quando: "5 minutes",
    });
    const contatoDaLoja = await criarContato(ORG_REABRE, "Mesma Pessoa", telefone);
    const daLoja = await criarPerdido({
      org: ORG_REABRE,
      contato: contatoDaLoja,
      funil: funilReabre,
      quando: "5 minutes",
    });

    const r = await mensagemChegou(ORG_REABRE, contatoDaLoja, "Mesma Pessoa");

    expect(r.criado).toBe(false);
    if (r.criado) return;
    // O mesmo humano é cliente das duas empresas: a mensagem daqui reabre o
    // card DAQUI, e o card do vizinho fica exatamente como estava.
    expect(r.leadId).toBe(daLoja);
    expect(r.leadId).not.toBe(doVizinho);
    const cardDoVizinho = await cardPorId(doVizinho);
    expect(cardDoVizinho.status).toBe("lost");
    expect(cardDoVizinho.stage_id).toBe(funilVizinho.perdido);
    expect(cardDoVizinho.closed_at).not.toBeNull();
  });

  it("motivo preservado e registro de QUEM reabriu e QUANDO — uma linha, não um evento de criação", async () => {
    const contato = await criarContato(ORG_REABRE, "Cliente Com Timeline", "+5511990000007");
    const perdidoId = await criarPerdido({
      org: ORG_REABRE,
      contato,
      funil: funilReabre,
      quando: "10 minutes",
      motivo: "no_response",
      deEtapa: funilReabre.meio,
    });

    await mensagemChegou(ORG_REABRE, contato, "Cliente Com Timeline");

    const { rows } = await pool.query<{
      type: string;
      actor_kind: string | null;
      source_module: string;
      source_id: string | null;
      contact_id: string | null;
      reason: string | null;
      payload: Record<string, unknown>;
      performed_at: Date;
    }>(
      `select type, actor_kind, source_module, source_id, contact_id, reason, payload, performed_at
         from crm_lead_activities where lead_id = $1 order by performed_at asc`,
      [perdidoId],
    );
    expect(rows, "uma linha na timeline — a reabertura, e só ela").toHaveLength(1);
    const at = rows[0]!;
    expect(at.type).toBe("lead_reopened");
    // `system` e não `ai`: quem agiu foi o runtime a partir da mensagem. A
    // fixture gravou o card direto, então não há `lead_created` aqui.
    expect(at.actor_kind).toBe("system");
    expect(at.source_module).toBe("canal.ingest");
    expect(at.source_id, "a conversa que reabriu fica registrada").toBe(CONVERSA);
    expect(at.contact_id).toBe(contato);
    expect(at.reason).toContain("janela de 30 dias");
    // QUANDO: a data da linha é a da reabertura, e o payload guarda quando o
    // negócio tinha morrido e por quê.
    expect(at.performed_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(at.payload).toMatchObject({
      etapa_da_perda: funilReabre.meio,
      etapa_de_volta: funilReabre.meio,
      lost_reason: "no_response",
      janela_dias: 30,
    });
    expect(at.payload.perdido_em).toBeTruthy();

    // NADA NASCEU: zero `lead.created` para este negócio. Um evento de criação
    // por reabertura inflaria a contagem de cards do funil — que é justamente o
    // número que a issue relata estar sujo.
    const { rows: nascidos } = await pool.query<{ event_type: string }>(
      `select event_type from event_log where entity_id = $1 and event_type = 'lead.created'`,
      [perdidoId],
    );
    expect(nascidos, "a reabertura não é criação").toHaveLength(0);

    // E o desfecho é UM evento, o que o GATILHO de status emite (o mesmo que o
    // "retomar" manual emite hoje): `lead.reopened`. Uma vez, não uma por
    // mensagem — é a contagem que impede o laço de automação.
    const { rows: reabertos } = await pool.query<{ event_type: string }>(
      `select event_type from event_log
        where entity_kind = 'lead' and entity_id = $1 and event_type = 'lead.reopened'`,
      [perdidoId],
    );
    expect(reabertos).toHaveLength(1);
  });

  it("sem laço: três mensagens seguidas = UM card, UMA reabertura, UM evento", async () => {
    const contato = await criarContato(ORG_REABRE, "Cliente Que Escreve Muito", "+5511990000008");
    const perdidoId = await criarPerdido({
      org: ORG_REABRE,
      contato,
      funil: funilReabre,
      quando: "2 minutes",
    });

    const primeira = await mensagemChegou(ORG_REABRE, contato, "Cliente Que Escreve Muito");
    const segunda = await mensagemChegou(ORG_REABRE, contato, "Cliente Que Escreve Muito");
    const terceira = await mensagemChegou(ORG_REABRE, contato, "Cliente Que Escreve Muito");

    expect(primeira.criado).toBe(false);
    if (primeira.criado) return;
    expect(primeira.motivo).toBe("reaberto");
    // Depois da primeira, o card JÁ está aberto: as outras caem no
    // `ja_existe` de sempre, sem reabrir nem reescrever etapa.
    expect(segunda).toMatchObject({ criado: false, motivo: "ja_existe" });
    expect(terceira).toMatchObject({ criado: false, motivo: "ja_existe" });

    expect(await cardsDoContato(contato)).toHaveLength(1);
    const { rows: atividades } = await pool.query<{ type: string }>(
      `select type from crm_lead_activities where lead_id = $1`,
      [perdidoId],
    );
    expect(atividades.filter((a) => a.type === "lead_reopened")).toHaveLength(1);
    const { rows: reabertos } = await pool.query<{ event_type: string }>(
      `select event_type from event_log
        where entity_kind = 'lead' and entity_id = $1 and event_type = 'lead.reopened'`,
      [perdidoId],
    );
    // UMA reabertura para três mensagens. É esta contagem que impede o laço:
    // reabrir a cada mensagem faria o funil emitir `lead.reopened` (e disparar
    // o que estiver pendurado nele) a cada mensagem do cliente.
    expect(reabertos).toHaveLength(1);
  });

  it("dono intacto: reabrir não muda o dono do negócio nem o atendente da conversa", async () => {
    const contato = await criarContato(ORG_REABRE, "Cliente Com Dono", "+5511990000009");
    const perdidoId = await criarPerdido({
      org: ORG_REABRE,
      contato,
      funil: funilReabre,
      quando: "3 minutes",
      dono: DONO,
    });
    const { rows: sessoes } = await pool.query<{ id: string }>(
      `insert into channel_sessions (organization_id, waha_session_name, status, webhook_secret_encrypted)
       values ($1, 'sessao-4076', 'WORKING', '\\x00'::bytea) returning id`,
      [ORG_REABRE],
    );
    const { rows: conversas } = await pool.query<{ id: string }>(
      `insert into conversations (organization_id, contact_id, channel_session_id, assigned_to_user_id, assigned_at)
       values ($1, $2, $3, $4, now() - interval '2 hours') returning id`,
      [ORG_REABRE, contato, sessoes[0]!.id, DONO],
    );
    const conversa = conversas[0]!.id;
    const antesDoCard = await cardPorId(perdidoId);

    await garantirLeadDaConversa(db, {
      organizationId: ORG_REABRE,
      contactId: contato,
      conversationId: conversa,
      nomeDoContato: "Cliente Com Dono",
    });

    const depoisDoCard = await cardPorId(perdidoId);
    expect(depoisDoCard.owner_user_id, "o dono do negócio não muda ao reabrir").toBe(DONO);
    expect(depoisDoCard.assigned_at, "e a data de atribuição menos ainda").toEqual(
      antesDoCard.assigned_at,
    );

    const { rows: depois } = await pool.query<{
      assigned_to_user_id: string | null;
      assigned_at: Date | null;
    }>(`select assigned_to_user_id, assigned_at from conversations where id = $1`, [conversa]);
    expect(depois[0]!.assigned_to_user_id, "o atendimento segue com quem já atendia").toBe(DONO);
    expect(depois[0]!.assigned_at).not.toBeNull();
  });

  it("a escolha de RETOMADA vence a janela: funil em `novo_negocio` cria card novo", async () => {
    const contato = await criarContato(
      ORG_RETOMA_NOVO,
      "Cliente Do Funil De Retomada",
      "+5511990000010",
    );
    await criarPerdido({
      org: ORG_RETOMA_NOVO,
      contato,
      funil: funilRetomaNovo,
      quando: "5 minutes",
    });

    const r = await mensagemChegou(ORG_RETOMA_NOVO, contato, "Cliente Do Funil De Retomada");

    // Ligar as duas opções seria pedir "reabra o mesmo" e "não reabra o mesmo"
    // ao mesmo tempo; a escolha explícita do funil sobre encerrados é a que
    // vale, e ela já tem tela e documentação (#1538).
    expect(r.criado).toBe(true);
    expect(await cardsDoContato(contato)).toHaveLength(2);
  });

  it("etapa de origem ARQUIVADA: reabre na etapa de entrada, em vez de sumir do quadro", async () => {
    const contato = await criarContato(ORG_REABRE, "Cliente Da Etapa Arquivada", "+5511990000011");
    const perdidoId = await criarPerdido({
      org: ORG_REABRE,
      contato,
      funil: funilReabre,
      quando: "5 minutes",
      deEtapa: funilReabre.meio,
    });
    // O funil mudou depois da perda: a etapa de onde ele saiu saiu do quadro.
    await pool.query("update crm_stages set is_archived = true where id = $1", [funilReabre.meio]);

    try {
      const r = await mensagemChegou(ORG_REABRE, contato, "Cliente Da Etapa Arquivada");
      expect(r.criado).toBe(false);
      if (r.criado) return;
      expect(r.leadId).toBe(perdidoId);
      // Reabrir numa etapa arquivada daria um card invisível no quadro — pior
      // que reabrir na entrada, e indistinguível de "o card sumiu".
      expect((await cardPorId(perdidoId)).stage_id).toBe(funilReabre.entrada);
    } finally {
      await pool.query("update crm_stages set is_archived = false where id = $1", [
        funilReabre.meio,
      ]);
    }
  });
});
