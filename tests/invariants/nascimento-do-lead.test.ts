import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { funilDeEntrada, garantirLeadDaConversa } from "@/lib/leads/nascimento-do-lead";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * A CONVERSA VIRA LEAD — o elo que faltava (spec 17 §3).
 *
 * Aqui roda a FUNÇÃO, não uma reescrita da consulta em SQL: `pgComoSupabase`
 * troca só o transporte, e o instrumento tem teste próprio
 * (`pg-como-supabase.test.ts`) porque adaptador que ignora filtro faz tudo
 * abaixo passar pelo motivo errado.
 *
 * Invariante de banco e não teste de unidade porque o que se mede é escolha
 * feita **contra o schema real**: qual etapa é a de entrada depende de
 * `position`, `is_won`, `is_lost` e `is_archived` existirem e valerem — e da
 * organização nascer com funil, o que é um TRIGGER
 * (`fn_seed_default_pipeline_for_org`). Nada disso existe fora do Postgres.
 *
 * Congela: (1) o lead nasce na etapa de entrada e emite atividade; (2) um por
 * demanda, não um por mensagem; (3) demanda nova depois de fechada; (4) quem
 * pediu para sair não vira oportunidade; (5) cada recusa tem motivo próprio;
 * (6) etapa de ganho/perda nunca é a de entrada, mesmo sendo a primeira.
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

/** Org normal: fica com o funil que o trigger semeia. */
const ORG_VIVA = "1ead7e00-0000-4000-8000-000000000001";
/** Org sem funil padrão — o semeado é apagado no setup. */
const ORG_SEM_FUNIL = "1ead7e00-0000-4000-8000-000000000002";
/** Org cujo único funil só tem etapas de ganho/perda. */
const ORG_SO_FECHADAS = "1ead7e00-0000-4000-8000-000000000003";
/** Org com etapa de GANHO na posição 0 — a armadilha do §6. */
const ORG_GANHO_PRIMEIRO = "1ead7e00-0000-4000-8000-000000000004";
/** Org com a ETAPA DE ENTRADA declarada no funil (#3011) — a declarada não é a primeira. */
const ORG_ENTRADA_CONFIGURADA = "1ead7e00-0000-4000-8000-000000000005";

const CONVERSA = "1ead7e00-0000-4000-8000-00000000c001";

/** Fixtures de `ORG_ENTRADA_CONFIGURADA`, preenchidas no `beforeAll`. */
let funilConfigurado: string;
let funilVizinho: string;
let etapaIniciada: string;
let etapaEmAtendimento: string;
let etapaProposta: string;
let etapaDoVizinho: string;

async function criarOrg(id: string, slug: string): Promise<void> {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, $2, 'Nascimento LTDA', 'Nascimento') on conflict (id) do nothing`,
    [id, slug],
  );
}

async function criarContato(org: string, nome: string | null): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, source) values ($1, $2, 'whatsapp') returning id`,
    [org, nome],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  await criarOrg(ORG_VIVA, "org-nascimento-viva");
  await criarOrg(ORG_SEM_FUNIL, "org-nascimento-sem-funil");
  await criarOrg(ORG_SO_FECHADAS, "org-nascimento-so-fechadas");
  await criarOrg(ORG_GANHO_PRIMEIRO, "org-nascimento-ganho-primeiro");

  // ORG_SEM_FUNIL: apaga o que o trigger semeou. Um tenant que arquivou ou
  // apagou o funil padrão chega neste estado sem fazer nada de errado.
  await pool.query("delete from crm_stages where organization_id = $1", [ORG_SEM_FUNIL]);
  await pool.query("delete from crm_pipelines where organization_id = $1", [ORG_SEM_FUNIL]);

  // ORG_SO_FECHADAS: mantém o funil padrão, remove toda etapa aberta.
  await pool.query(
    "delete from crm_stages where organization_id = $1 and is_won = false and is_lost = false",
    [ORG_SO_FECHADAS],
  );

  // ORG_GANHO_PRIMEIRO: funil próprio, com "Ganho" ANTES da entrada.
  await pool.query("delete from crm_stages where organization_id = $1", [ORG_GANHO_PRIMEIRO]);
  await pool.query("delete from crm_pipelines where organization_id = $1", [ORG_GANHO_PRIMEIRO]);
  const { rows } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug, is_default, position)
     values ($1, 'Funil torto', 'funil-torto', true, 1000) returning id`,
    [ORG_GANHO_PRIMEIRO],
  );
  const funilTorto = rows[0]!.id;
  await pool.query(
    `insert into crm_stages (organization_id, pipeline_id, name, slug, position, is_won, is_lost) values
       ($1, $2, 'Ganho',   'ganho-torto',   0, true,  false),
       ($1, $2, 'Perdido', 'perdido-torto', 1, false, true),
       ($1, $2, 'Entrada', 'entrada-torta', 2, false, false)`,
    [ORG_GANHO_PRIMEIRO, funilTorto],
  );

  // ORG_ENTRADA_CONFIGURADA: funil próprio com TRÊS etapas abertas — a de
  // entrada declarada (a do meio) NÃO é a primeira, que é o que separa a regra
  // nova do comportamento antigo. O funil vizinho e a etapa dele existem para
  // provar que uma configuração apontando para fora do funil não é obedecida.
  await criarOrg(ORG_ENTRADA_CONFIGURADA, "org-nascimento-entrada-configurada");
  await pool.query("delete from crm_stages where organization_id = $1", [ORG_ENTRADA_CONFIGURADA]);
  await pool.query("delete from crm_pipelines where organization_id = $1", [
    ORG_ENTRADA_CONFIGURADA,
  ]);

  const { rows: funis } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug, is_default, position) values
       ($1, 'Funil de captação', 'funil-de-captacao', true,  1000),
       ($1, 'Funil vizinho',     'funil-vizinho',     false, 2000)
     returning id`,
    [ORG_ENTRADA_CONFIGURADA],
  );
  funilConfigurado = funis[0]!.id;
  funilVizinho = funis[1]!.id;

  const { rows: etapas } = await pool.query<{ id: string; slug: string }>(
    `insert into crm_stages (organization_id, pipeline_id, name, slug, position, is_won, is_lost) values
       ($1, $2, 'Conversas iniciadas', 'conversas-iniciadas', 0, false, false),
       ($1, $2, 'Em atendimento',      'em-atendimento',      1, false, false),
       ($1, $2, 'Proposta',            'proposta',            2, false, false),
       ($1, $3, 'Entrada do vizinho',  'entrada-do-vizinho',  0, false, false)
     returning id, slug`,
    [ORG_ENTRADA_CONFIGURADA, funilConfigurado, funilVizinho],
  );
  const porSlug = new Map(etapas.map((e) => [e.slug, e.id]));
  etapaIniciada = porSlug.get("conversas-iniciadas")!;
  etapaEmAtendimento = porSlug.get("em-atendimento")!;
  etapaProposta = porSlug.get("proposta")!;
  etapaDoVizinho = porSlug.get("entrada-do-vizinho")!;
});

afterAll(async () => {
  await pool.query("delete from organizations where id = any($1)", [
    [ORG_VIVA, ORG_SEM_FUNIL, ORG_SO_FECHADAS, ORG_GANHO_PRIMEIRO, ORG_ENTRADA_CONFIGURADA],
  ]);
  await pool.end();
});

describe("o lead NASCE", () => {
  it("a organização nasce com funil padrão — sem isto, todo caminho feliz abaixo é vazio", async () => {
    // Controle positivo do AMBIENTE: o caminho feliz depende de um TRIGGER
    // (`fn_seed_default_pipeline_for_org`). Se ele sumisse do baseline, os casos
    // seguintes cairiam em `sem_funil_de_entrada` e alguém leria isso como
    // "a regra está funcionando" em vez de "o produto perdeu o funil padrão".
    const destino = await funilDeEntrada(db, ORG_VIVA);
    expect(destino, "org recém-criada tem de ter funil de entrada").not.toHaveProperty("erro");
  });

  it("entra na primeira etapa do funil padrão, ligado ao contato", async () => {
    const contato = await criarContato(ORG_VIVA, "Joana da Silva");
    const r = await garantirLeadDaConversa(db, {
      organizationId: ORG_VIVA,
      contactId: contato,
      conversationId: CONVERSA,
      nomeDoContato: "Joana da Silva",
    });

    expect(r.criado, `esperava criar, veio ${JSON.stringify(r)}`).toBe(true);
    if (!r.criado) return;

    const { rows } = await pool.query<{
      title: string;
      contact_id: string | null;
      status: string;
      stage_name: string;
      stage_position: string;
      pipeline_is_default: boolean;
    }>(
      `select l.title, l.contact_id, l.status, s.name as stage_name, s.position as stage_position,
              p.is_default as pipeline_is_default
         from crm_leads l
         join crm_stages s on s.id = l.stage_id
         join crm_pipelines p on p.id = l.pipeline_id
        where l.id = $1`,
      [r.leadId],
    );
    const lead = rows[0]!;
    // O VÍNCULO — é literalmente o defeito medido: 13 de 15 leads da produção
    // tinham este campo nulo.
    expect(lead.contact_id, "o lead tem de apontar para o contato").toBe(contato);
    expect(lead.title).toBe("Joana da Silva");
    expect(lead.status).toBe("open");
    expect(lead.pipeline_is_default, "tem de nascer no funil de entrada").toBe(true);

    // E é a PRIMEIRA etapa aberta do funil, não uma qualquer.
    const { rows: primeira } = await pool.query<{ name: string }>(
      `select name from crm_stages
        where pipeline_id = (select pipeline_id from crm_leads where id = $1)
          and is_archived = false and is_won = false and is_lost = false
        order by position asc limit 1`,
      [r.leadId],
    );
    expect(lead.stage_name).toBe(primeira[0]!.name);
  });

  it("emite atividade de sistema — card que aparece sozinho destrói a confiança no automatismo", async () => {
    const contato = await criarContato(ORG_VIVA, "Registro Silva");
    const r = await garantirLeadDaConversa(db, {
      organizationId: ORG_VIVA,
      contactId: contato,
      conversationId: CONVERSA,
      nomeDoContato: "Registro Silva",
    });
    expect(r.criado).toBe(true);
    if (!r.criado) return;

    const { rows } = await pool.query<{
      type: string;
      actor_kind: string | null;
      source_module: string;
      source_id: string | null;
      contact_id: string | null;
      reason: string | null;
    }>(
      `select type, actor_kind, source_module, source_id, contact_id, reason
         from crm_lead_activities where lead_id = $1`,
      [r.leadId],
    );
    expect(rows, "uma linha na timeline, exatamente").toHaveLength(1);
    const at = rows[0]!;
    expect(at.type).toBe("lead_created");
    // `system` e não `ai`: quem criou foi o runtime, e afirmar autoria da IA sem
    // lastro é o que a 0071 existe para impedir.
    expect(at.actor_kind).toBe("system");
    expect(at.source_module).toBe("canal.ingest");
    expect(at.source_id, "a conversa que originou fica registrada").toBe(CONVERSA);
    expect(at.contact_id).toBe(contato);
    expect(at.reason).toBeTruthy();
  });

  it("o título vem do CADASTRO, não do payload — contato conhecido não vira 'Novo contato'", async () => {
    // O defeito era do próprio passo 1: `nomeDoContato` vinha de
    // `notifyNameOf(p)` cru. O WAHA manda inbound SEM `pushName` (2 de 271
    // medidos) e TODO ack vem assim — então um cliente que o CRM conhece pelo
    // nome abria um card chamado "Novo contato pelo WhatsApp".
    const contato = await criarContato(ORG_VIVA, "Conhecido Andrade");
    const r = await garantirLeadDaConversa(db, {
      organizationId: ORG_VIVA,
      contactId: contato,
      conversationId: CONVERSA,
      nomeDoContato: null, // a mensagem veio sem nome
    });
    expect(r.criado).toBe(true);
    if (!r.criado) return;
    const { rows } = await pool.query<{ title: string }>("select title from crm_leads where id = $1", [
      r.leadId,
    ]);
    expect(rows[0]!.title).toBe("Conhecido Andrade");
  });

  it("rótulo TÉCNICO no cadastro não vaza para o título do card", async () => {
    // Ler o cadastro abriu esta porta: 3 contatos da produção têm
    // `Contato 543134@lid` gravado. Sem a guarda, o kanban — que hoje está
    // limpo — receberia o resíduo no primeiro card.
    const contato = await criarContato(ORG_VIVA, "Contato 543134@lid");
    await pool.query("update contacts set phone_number = '+5531955554444' where id = $1", [contato]);
    const r = await garantirLeadDaConversa(db, {
      organizationId: ORG_VIVA,
      contactId: contato,
      conversationId: CONVERSA,
      nomeDoContato: "Contato 543134@lid",
    });
    expect(r.criado).toBe(true);
    if (!r.criado) return;
    const { rows } = await pool.query<{ title: string }>("select title from crm_leads where id = $1", [
      r.leadId,
    ]);
    expect(rows[0]!.title).not.toMatch(/@lid|@c\.us/);
    // Cai no telefone, que é informação útil — melhor que "Sem nome".
    expect(rows[0]!.title).toBe("+5531955554444");
  });

  it("sem nome do contato, o título ainda é legível — nunca identificador técnico", async () => {
    const contato = await criarContato(ORG_VIVA, null);
    const r = await garantirLeadDaConversa(db, {
      organizationId: ORG_VIVA,
      contactId: contato,
      conversationId: CONVERSA,
      nomeDoContato: "   ",
    });
    expect(r.criado).toBe(true);
    if (!r.criado) return;

    const { rows } = await pool.query<{ title: string }>("select title from crm_leads where id = $1", [
      r.leadId,
    ]);
    expect(rows[0]!.title).toBe("Novo contato pelo WhatsApp");
  });
});

describe("UM lead por DEMANDA, não um por mensagem", () => {
  it("a segunda mensagem não abre um segundo card", async () => {
    const contato = await criarContato(ORG_VIVA, "Repetido Souza");
    const dados = {
      organizationId: ORG_VIVA,
      contactId: contato,
      conversationId: CONVERSA,
      nomeDoContato: "Repetido Souza",
    };

    const primeira = await garantirLeadDaConversa(db, dados);
    const segunda = await garantirLeadDaConversa(db, dados);

    expect(primeira.criado).toBe(true);
    expect(segunda.criado).toBe(false);
    if (segunda.criado) return;
    expect(segunda.motivo).toBe("ja_existe");

    const { rows } = await pool.query<{ n: string }>(
      "select count(*) as n from crm_leads where contact_id = $1",
      [contato],
    );
    expect(rows[0]!.n, "um contato, um card").toBe("1");
  });

  it("depois de FECHADO, quem volta a escrever abre demanda nova", async () => {
    const contato = await criarContato(ORG_VIVA, "Voltou Pereira");
    const dados = {
      organizationId: ORG_VIVA,
      contactId: contato,
      conversationId: CONVERSA,
      nomeDoContato: "Voltou Pereira",
    };

    const primeira = await garantirLeadDaConversa(db, dados);
    expect(primeira.criado).toBe(true);
    if (!primeira.criado) return;

    await pool.query(
      "update crm_leads set status = 'won', closed_at = now() where id = $1",
      [primeira.leadId],
    );

    const segunda = await garantirLeadDaConversa(db, dados);
    // Sem o filtro `status='open'`, este caso devolveria `ja_existe` — é ele que
    // prova que a regra é "demanda aberta", não "contato já visto".
    expect(segunda.criado, "negócio fechado não bloqueia negócio novo").toBe(true);

    const { rows } = await pool.query<{ n: string }>(
      "select count(*) as n from crm_leads where contact_id = $1",
      [contato],
    );
    expect(rows[0]!.n).toBe("2");
  });
});

describe("quando o lead NÃO nasce — e cada recusa diz por quê", () => {
  it("quem pediu para sair não vira oportunidade", async () => {
    const contato = await criarContato(ORG_VIVA, "Saiu Lima");
    await pool.query(
      "update contacts set is_blocked = true, blocked_reason = 'stop_keyword' where id = $1",
      [contato],
    );

    const r = await garantirLeadDaConversa(db, {
      organizationId: ORG_VIVA,
      contactId: contato,
      conversationId: CONVERSA,
      nomeDoContato: "Saiu Lima",
    });

    expect(r.criado).toBe(false);
    if (r.criado) return;
    expect(r.motivo).toBe("contato_bloqueado");

    const { rows } = await pool.query<{ n: string }>(
      "select count(*) as n from crm_leads where contact_id = $1",
      [contato],
    );
    expect(rows[0]!.n, "nenhum card para quem pediu para sair").toBe("0");
  });

  it("organização sem funil padrão recusa com motivo próprio — e não pega o do vizinho", async () => {
    // ORG_VIVA TEM funil padrão e existe neste mesmo banco. Se o filtro de
    // organização falhasse, este caso criaria um lead no funil dela — e é
    // exatamente o vazamento entre tenants que não pode passar.
    const contato = await criarContato(ORG_SEM_FUNIL, "Órfão Costa");
    const r = await garantirLeadDaConversa(db, {
      organizationId: ORG_SEM_FUNIL,
      contactId: contato,
      conversationId: CONVERSA,
      nomeDoContato: "Órfão Costa",
    });

    expect(r.criado).toBe(false);
    if (r.criado) return;
    expect(r.motivo).toBe("sem_funil_de_entrada");

    const { rows } = await pool.query<{ n: string }>(
      "select count(*) as n from crm_leads where contact_id = $1",
      [contato],
    );
    expect(rows[0]!.n).toBe("0");
  });

  it("funil só com etapas de ganho/perda recusa por FALTA DE ETAPA, não por falta de funil", async () => {
    // Os dois motivos apontam para consertos diferentes: um é "crie um funil",
    // o outro é "seu funil não tem onde entrar". Colapsá-los num só mandaria
    // quem configura procurar no lugar errado.
    const contato = await criarContato(ORG_SO_FECHADAS, "Sem Etapa Dias");
    const r = await garantirLeadDaConversa(db, {
      organizationId: ORG_SO_FECHADAS,
      contactId: contato,
      conversationId: CONVERSA,
      nomeDoContato: "Sem Etapa Dias",
    });

    expect(r.criado).toBe(false);
    if (r.criado) return;
    expect(r.motivo).toBe("sem_etapa");
  });
});

describe("a etapa de entrada nunca é uma etapa de fechamento", () => {
  it("funil com 'Ganho' na posição 0 ainda faz o lead nascer em 'Entrada'", async () => {
    // Um funil pode ser montado em qualquer ordem — é do dono do negócio. Se a
    // regra fosse só "menor position", este lead nasceria GANHO: um negócio
    // fechado que ninguém vendeu, poluindo qualquer métrica de conversão.
    const contato = await criarContato(ORG_GANHO_PRIMEIRO, "Torto Alves");
    const r = await garantirLeadDaConversa(db, {
      organizationId: ORG_GANHO_PRIMEIRO,
      contactId: contato,
      conversationId: CONVERSA,
      nomeDoContato: "Torto Alves",
    });

    expect(r.criado, `esperava criar, veio ${JSON.stringify(r)}`).toBe(true);
    if (!r.criado) return;

    const { rows } = await pool.query<{ name: string; is_won: boolean; is_lost: boolean }>(
      `select s.name, s.is_won, s.is_lost from crm_stages s
         join crm_leads l on l.stage_id = s.id where l.id = $1`,
      [r.leadId],
    );
    expect(rows[0]!.name).toBe("Entrada");
    expect(rows[0]!.is_won).toBe(false);
    expect(rows[0]!.is_lost).toBe(false);
  });
});

describe("três mensagens seguidas NÃO viram três negócios", () => {
  /**
   * O defeito que este caso guarda foi medido em produção: um contato mandou
   * três mensagens em sequência ("oi", "tudo bem?", "queria marcar") e nasceram
   * TRÊS cards, os três no mesmo segundo, no mesmo funil e na mesma etapa.
   *
   * A causa era check-then-act: a consulta de "já existe aberto?" e o insert
   * eram dois passos, e três execuções simultâneas passavam as três pela
   * consulta antes de qualquer insert concluir.
   *
   * ⚠️ ESTE CASO SÓ VALE EM PARALELO. Chamar as três em sequência passaria mesmo
   * com o defeito — cada uma esperaria a anterior terminar, e a segunda veria o
   * card da primeira. É o `Promise.all` que reproduz o que o WhatsApp faz.
   */
  it("três entradas SIMULTÂNEAS do mesmo contato criam UM lead", async () => {
    const contato = await criarContato(ORG_VIVA, "Ana Simultânea");

    const resultados = await Promise.all(
      [1, 2, 3].map(() =>
        garantirLeadDaConversa(db, {
          organizationId: ORG_VIVA,
          contactId: contato,
          conversationId: CONVERSA,
          nomeDoContato: "Ana Simultânea",
        }),
      ),
    );

    const criados = resultados.filter((r) => r.criado).length;
    expect(criados, `esperava 1 criação, veio ${JSON.stringify(resultados)}`).toBe(1);

    // A prova que importa é a do BANCO, não a do retorno: um retorno pode dizer
    // "não criei" e a linha existir assim mesmo.
    const { rows } = await pool.query<{ n: string }>(
      "select count(*) as n from crm_leads where organization_id = $1 and contact_id = $2",
      [ORG_VIVA, contato],
    );
    expect(Number(rows[0]!.n), "mais de um card para o mesmo contato").toBe(1);
  });

  it("as duas que não criaram dizem `ja_existe`, e não `erro`", async () => {
    // A diferença importa para quem depura: `erro` manda procurar defeito onde
    // o sistema fez exatamente o certo.
    const contato = await criarContato(ORG_VIVA, "Bia Simultânea");
    const resultados = await Promise.all(
      [1, 2].map(() =>
        garantirLeadDaConversa(db, {
          organizationId: ORG_VIVA,
          contactId: contato,
          conversationId: CONVERSA,
          nomeDoContato: "Bia Simultânea",
        }),
      ),
    );
    const naoCriados = resultados.filter((r) => !r.criado);
    expect(naoCriados).toHaveLength(1);
    expect(naoCriados[0] && "motivo" in naoCriados[0] ? naoCriados[0].motivo : "?").toBe(
      "ja_existe",
    );
  });
});

/**
 * A ETAPA DE ENTRADA DECLARADA NO FUNIL (issue #3011, fatia 1).
 *
 * A conversa do Inbox vira card no funil de entrada (`is_default`) e, dentro
 * dele, na etapa que o funil declara em `settings.entrada_do_inbox` — a chave
 * `ativa` ligada e o `stage_id`. O que se mede aqui, contra o schema real:
 *
 * 1. SEM configuração, o card nasce na PRIMEIRA etapa aberta — o comportamento
 *    de hoje, congelado: é ele que impede a fatia nova de ser uma regressão
 *    silenciosa para toda instalação que nunca configurou nada.
 * 2. COM a chave ligada, o card nasce na etapa declarada, mesmo que ela não
 *    seja a primeira.
 * 3. Etapa declarada que NÃO é etapa utilizável deste funil — de outro funil,
 *    de outra organização, arquivada, de ganho/perda — não é obedecida: cai na
 *    primeira, porque um identificador com forma não é uma etapa que existe.
 * 4. Chave desligada volta à primeira etapa mesmo com a etapa ainda gravada.
 */
describe("a etapa de entrada declarada no funil (#3011, fatia 1)", () => {
  /** Grava a configuração do Inbox no funil de entrada desta org. */
  async function declararEntrada(bloco: Record<string, unknown> | null): Promise<void> {
    await pool.query(
      `update crm_pipelines
          set settings = case
                when $2::jsonb is null then coalesce(settings, '{}'::jsonb) - 'entrada_do_inbox'
                else coalesce(settings, '{}'::jsonb) || jsonb_build_object('entrada_do_inbox', $2::jsonb)
              end
        where id = $1`,
      [funilConfigurado, bloco === null ? null : JSON.stringify(bloco)],
    );
  }

  async function ondeNasceu(
    leadId: string,
  ): Promise<{ stage_id: string; pipeline_id: string; stage_name: string; padrao: boolean }> {
    const { rows } = await pool.query<{
      stage_id: string;
      pipeline_id: string;
      stage_name: string;
      padrao: boolean;
    }>(
      `select l.stage_id, l.pipeline_id, s.name as stage_name, p.is_default as padrao
         from crm_leads l
         join crm_stages s on s.id = l.stage_id
         join crm_pipelines p on p.id = l.pipeline_id
        where l.id = $1`,
      [leadId],
    );
    return rows[0]!;
  }

  it("SEM configuração, o card nasce na PRIMEIRA etapa do funil de entrada — o comportamento de hoje", async () => {
    // A reprodução do estado atual, ANTES: nenhuma chave gravada. Se a fatia
    // nova tivesse trocado o padrão em vez de acrescentar uma escolha, este
    // caso é o que ficaria vermelho.
    await declararEntrada(null);
    const contato = await criarContato(ORG_ENTRADA_CONFIGURADA, "Sem Config Silva");

    const r = await garantirLeadDaConversa(db, {
      organizationId: ORG_ENTRADA_CONFIGURADA,
      contactId: contato,
      conversationId: CONVERSA,
      nomeDoContato: "Sem Config Silva",
    });

    expect(r.criado, `esperava criar, veio ${JSON.stringify(r)}`).toBe(true);
    if (!r.criado) return;

    const destino = await ondeNasceu(r.leadId);
    expect(destino.pipeline_id, "o funil continua sendo o marcado como padrão").toBe(
      funilConfigurado,
    );
    expect(destino.padrao).toBe(true);
    expect(destino.stage_name, "sem configuração, a primeira etapa aberta").toBe(
      "Conversas iniciadas",
    );
    expect(destino.stage_id).toBe(etapaIniciada);
    // E o retorno da função concorda com o banco — quem chamou não pode receber
    // uma etapa e o card ter nascido noutra.
    expect(r.stageId).toBe(etapaIniciada);
    expect(r.pipelineId).toBe(funilConfigurado);
  });

  it("com a chave ligada, o card nasce na ETAPA DECLARADA — e a segunda mensagem não abre segundo card", async () => {
    await declararEntrada({ ativa: true, stage_id: etapaEmAtendimento });
    const contato = await criarContato(ORG_ENTRADA_CONFIGURADA, "Declarada Dias");
    const dados = {
      organizationId: ORG_ENTRADA_CONFIGURADA,
      contactId: contato,
      conversationId: CONVERSA,
      nomeDoContato: "Declarada Dias",
    };

    const primeira = await garantirLeadDaConversa(db, dados);
    expect(primeira.criado, `esperava criar, veio ${JSON.stringify(primeira)}`).toBe(true);
    if (!primeira.criado) return;

    const destino = await ondeNasceu(primeira.leadId);
    expect(destino.stage_name, "a etapa declarada vence a primeira do funil").toBe(
      "Em atendimento",
    );
    expect(destino.stage_id).toBe(etapaEmAtendimento);
    expect(destino.stage_id).not.toBe(etapaIniciada);
    // O funil NÃO é escolhido por esta configuração: continua o padrão.
    expect(destino.pipeline_id).toBe(funilConfigurado);
    expect(destino.padrao).toBe(true);

    // A configuração não afrouxa o "um card por demanda": a mensagem seguinte
    // do mesmo contato alimenta o card que já existe.
    const segunda = await garantirLeadDaConversa(db, dados);
    expect(segunda.criado).toBe(false);
    if (segunda.criado) return;
    expect(segunda.motivo).toBe("ja_existe");
    const { rows } = await pool.query<{ n: string }>(
      "select count(*) as n from crm_leads where contact_id = $1",
      [contato],
    );
    expect(rows[0]!.n, "um contato, um card").toBe("1");
  });

  it("etapa declarada de OUTRO funil não é obedecida — o card nasce na primeira, e nasce", async () => {
    // `z.uuid()` diz que o valor tem forma de identificador, não que a etapa
    // seja deste funil. Sem a conferência contra o banco, o card nasceria numa
    // etapa de outro funil — visível no quadro errado — ou não nasceria.
    await declararEntrada({ ativa: true, stage_id: etapaDoVizinho });
    const contato = await criarContato(ORG_ENTRADA_CONFIGURADA, "Vizinho Rocha");

    const r = await garantirLeadDaConversa(db, {
      organizationId: ORG_ENTRADA_CONFIGURADA,
      contactId: contato,
      conversationId: CONVERSA,
      nomeDoContato: "Vizinho Rocha",
    });

    expect(r.criado).toBe(true);
    if (!r.criado) return;
    const destino = await ondeNasceu(r.leadId);
    expect(destino.pipeline_id, "o card não vai para o funil do vizinho").toBe(funilConfigurado);
    expect(destino.stage_id).toBe(etapaIniciada);
  });

  it("etapa declarada de OUTRA organização não é obedecida — o tenant vale também na configuração", async () => {
    // ORG_VIVA existe neste banco e tem etapas próprias. Uma configuração que
    // apontasse para uma delas precisa morrer no filtro de organização: é a
    // mesma classe de vazamento entre tenants que o resto deste arquivo mede.
    const { rows } = await pool.query<{ id: string }>(
      "select id from crm_stages where organization_id = $1 order by position asc limit 1",
      [ORG_VIVA],
    );
    const etapaAlheia = rows[0]!.id;
    await declararEntrada({ ativa: true, stage_id: etapaAlheia });
    const contato = await criarContato(ORG_ENTRADA_CONFIGURADA, "Alheia Prado");

    const r = await garantirLeadDaConversa(db, {
      organizationId: ORG_ENTRADA_CONFIGURADA,
      contactId: contato,
      conversationId: CONVERSA,
      nomeDoContato: "Alheia Prado",
    });

    expect(r.criado).toBe(true);
    if (!r.criado) return;
    const destino = await ondeNasceu(r.leadId);
    expect(destino.stage_id, "nada nasce em etapa de outra empresa").toBe(etapaIniciada);
  });

  it("etapa declarada ARQUIVADA não é obedecida — arquivar é tirar do caminho", async () => {
    await declararEntrada({ ativa: true, stage_id: etapaProposta });
    await pool.query("update crm_stages set is_archived = true where id = $1", [etapaProposta]);
    const contato = await criarContato(ORG_ENTRADA_CONFIGURADA, "Arquivada Nunes");

    const r = await garantirLeadDaConversa(db, {
      organizationId: ORG_ENTRADA_CONFIGURADA,
      contactId: contato,
      conversationId: CONVERSA,
      nomeDoContato: "Arquivada Nunes",
    });

    await pool.query("update crm_stages set is_archived = false where id = $1", [etapaProposta]);

    expect(r.criado).toBe(true);
    if (!r.criado) return;
    const destino = await ondeNasceu(r.leadId);
    expect(destino.stage_id).toBe(etapaIniciada);
  });

  it("chave DESLIGADA volta para a primeira etapa, mesmo com a etapa declarada ainda gravada", async () => {
    await declararEntrada({ ativa: false, stage_id: etapaEmAtendimento });
    const contato = await criarContato(ORG_ENTRADA_CONFIGURADA, "Desligada Freitas");

    const r = await garantirLeadDaConversa(db, {
      organizationId: ORG_ENTRADA_CONFIGURADA,
      contactId: contato,
      conversationId: CONVERSA,
      nomeDoContato: "Desligada Freitas",
    });

    expect(r.criado).toBe(true);
    if (!r.criado) return;
    const destino = await ondeNasceu(r.leadId);
    expect(destino.stage_name).toBe("Conversas iniciadas");
    expect(destino.stage_id).toBe(etapaIniciada);
    // E o bloco continua lá: desligar não apaga a escolha.
    const { rows } = await pool.query<{ settings: { entrada_do_inbox?: unknown } }>(
      "select settings from crm_pipelines where id = $1",
      [funilConfigurado],
    );
    expect(rows[0]!.settings.entrada_do_inbox).toEqual({
      ativa: false,
      stage_id: etapaEmAtendimento,
    });
  });
});
