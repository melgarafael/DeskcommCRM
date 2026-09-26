import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { drainTick } from "@/lib/agent-engine/edge/crm/drain";
import { createLogger } from "@/lib/agent-engine/obs/logger";
import { haQuemAtendaASessao, palavrasDeQuemPodeAtender } from "@/lib/ai/agents/quem-atende-a-sessao";

/**
 * O JEV SÓ É PERGUNTADO ONDE O DRENO DEIXA O TURNO RODAR (conserto da revisão
 * da onda 3, F1).
 *
 * O worker de clima pergunta ao Jev pelos pedidos do cliente só onde o turno do
 * agente rodaria — é lá que a regra de hoje roda, e um pedido "que a regra
 * deixou passar" só existe onde ela foi consultada. A régua própria que o
 * worker tinha (o resolvedor de configuração, com o "agente único da empresa"
 * publicado em OUTRO número) contava pedidos num número em que o dreno pulava
 * o turno.
 *
 * A pergunta agora é UMA função, `haQuemAtendaASessao`, que o dreno
 * (`lib/agent-engine/edge/crm/drain.ts`) e o worker chamam. Cada cenário aqui
 * pergunta às duas pontas — o dreno enfileira? a função diz que há quem
 * atenda? — e elas têm de concordar, nos casos que a revisão nomeou: agente
 * pausado, arquivado, publicado em outro número, roteador com os membros todos
 * pausados, só o fallback. O portão do dreno em si é congelado em
 * `portao-de-capacidade-mede-quem-executa.test.ts`; os cenários são os dele.
 *
 * E a outra pergunta que o worker faz sobre quem atende: as palavras de
 * passagem de QUALQUER agente que pode atender a conversa
 * (`palavrasDeQuemPodeAtender`), pelo SQL de verdade.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:invariants` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});
const log = createLogger();

const ORG = "cca00426-0000-4000-8000-000000000001";
const CONTACT = "cca00426-0000-4000-8000-000000000002";

const DRAIN_KNOBS = {
  batchSize: 20,
  intervalMs: 100,
  idleIntervalMs: 100,
  debounceMs: 0,
  reapTimeoutMs: 300_000,
};

/** Um cenário completo e isolado: uma sessão de canal só dele. */
interface Cenario {
  session: string;
  conv: string;
  msg: string;
}

let seq = 0;
function proximoId(): string {
  seq += 1;
  return `cca00426-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

async function montarCenario(nome: string): Promise<Cenario> {
  const session = proximoId();
  const conv = proximoId();
  const msg = proximoId();
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, $3, 'WORKING', '\\x00'::bytea)`,
    [session, ORG, `jev-cap-${nome}`],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1, $2, $3, $4, 'open', false)`,
    [conv, ORG, CONTACT, session],
  );
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
                           type, direction, status, body, sent_via, sent_at)
     values ($1, $2, $3, $4, $5, 'text', 'inbound', 'delivered', 'oi', 'external_device', now())`,
    [msg, ORG, conv, session, CONTACT],
  );
  return { session, conv, msg };
}

/**
 * Cria um agente. `publicado: false` reproduz o agente DESPUBLICADO: a versão
 * virou `superseded` e `published_version_id` ficou nulo — não a pausa pela
 * tela, que grava só `paused_at` (jev-pergunta-so-com-quem-nao-esta-pausado).
 * Sem versão nenhuma o portão poderia passar por um motivo que o banco não tem.
 */
async function criarAgente(
  sessionId: string,
  opts: { publicado: boolean; nome: string; palavras?: string[] },
): Promise<string> {
  const agent = proximoId();
  const version = proximoId();
  // O nome vem de fora porque `ai_agents_name_unique` é por organização, e
  // todos os cenários deste arquivo dividem a mesma org: um literal fixo aqui
  // faz o segundo insert morrer em 23505 e o caso nunca chega a exercitar o
  // portão — ele fica vermelho por erro de fixture, que lê como defeito.
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt, kind)
     values ($1, $2, $3, 'você é um atendente', 'mcp_agent')`,
    [agent, ORG, `Agente Portão ${opts.nome}`],
  );
  // As palavras de passagem entram no insert: versão publicada é imutável.
  // Sem `palavras`, vale o default da coluna.
  const palavras = opts.palavras === undefined ? "" : ", handoff_keywords";
  await pool.query(
    `insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt,
                                    provider, model, channel_session_id, status, published_at${palavras})
     values ($1, $2, $3, 1, 'você é um atendente', 'anthropic', 'claude-sonnet-4-6', $4, $5, now()${palavras ? ", $6" : ""})`,
    [version, ORG, agent, sessionId, opts.publicado ? "published" : "superseded", ...(opts.palavras ? [opts.palavras] : [])],
  );
  if (opts.publicado) {
    await pool.query(`update ai_agents set published_version_id = $1 where id = $2`, [version, agent]);
  }
  return agent;
}

async function criarRouter(
  sessionId: string,
  opts: { fallback?: string | null; membro?: string | null },
): Promise<string> {
  const router = proximoId();
  await pool.query(
    `insert into ai_routers (id, organization_id, name, channel_session_id, is_active, fallback_agent_id)
     values ($1, $2, 'Roteador Portão', $3, true, $4)`,
    [router, ORG, sessionId, opts.fallback ?? null],
  );
  if (opts.membro) {
    await pool.query(
      `insert into ai_router_members (organization_id, router_id, agent_id, intent_name, intent_description)
       values ($1, $2, $3, 'suporte', 'dúvidas de suporte')`,
      [ORG, router, opts.membro],
    );
  }
  return router;
}

/**
 * O dreno e o worker do Jev respondem juntos: há quem atenda? Os dois TÊM de
 * concordar — é a mesma função — e a resposta é a do dreno (nasceu job?).
 */
async function portao(c: Cenario): Promise<boolean> {
  const doJev = await haQuemAtendaASessao(pool, ORG, c.session);
  const doDreno = await drenaEGeraJob(c);
  expect(doJev, "o worker do Jev e o dreno discordam sobre quem atende").toBe(doDreno);
  return doDreno;
}

/** Drena o evento do cenário e responde: nasceu job? */
async function drenaEGeraJob(c: Cenario): Promise<boolean> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into event_log (organization_id, event_type, entity_kind, entity_id, payload, status)
     values ($1::uuid, 'ai_agent.dispatch_requested', 'message', $2::uuid,
             jsonb_build_object('organization_id', $1::text, 'conversation_id', $3::text,
                                'contact_id', $4::text, 'channel_session_id', $5::text,
                                'inbound_message_id', $2::text),
             'pending')
     returning id`,
    [ORG, c.msg, c.conv, CONTACT, c.session],
  );
  const eventId = rows[0]!.id;

  await drainTick(pool, DRAIN_KNOBS, log);

  const { rows: jobs } = await pool.query<{ n: number }>(
    "select count(*)::int as n from job_queue where source_event_id = $1",
    [eventId],
  );
  return jobs[0]!.n > 0;
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'jev-quem-atende', 'Jev Quem Atende', 'Jev Quem Atende')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1, $2, 'Lead Portão', '+5511900000099') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("o dreno e o worker do Jev respondem igual: há quem atenda o número?", () => {
  it("agente publicado no número: os dois dizem que sim", async () => {
    const c = await montarCenario("publicado");
    await criarAgente(c.session, { publicado: true, nome: "publicado" });
    expect(await portao(c)).toBe(true);
  });

  it("agente PAUSADO e sem roteador: os dois dizem que não", async () => {
    const c = await montarCenario("pausado");
    await criarAgente(c.session, { publicado: false, nome: "pausado" });
    expect(await portao(c)).toBe(false);
  });

  it("agente ARQUIVADO com versão publicada: os dois dizem que não", async () => {
    const c = await montarCenario("arquivado");
    const agente = await criarAgente(c.session, { publicado: true, nome: "arquivado" });
    await pool.query(`update ai_agents set archived_at = now() where id = $1`, [agente]);
    expect(await portao(c)).toBe(false);
  });

  it("o único agente da empresa, publicado em OUTRO número: os dois dizem que não aqui — e que sim lá", async () => {
    const outro = await montarCenario("outro-numero-a");
    await criarAgente(outro.session, { publicado: true, nome: "outro-numero" });
    const c = await montarCenario("outro-numero-b");
    expect(await portao(c)).toBe(false);
    expect(await portao(outro), "no número dele, atende (controle)").toBe(true);
  });

  it("roteador ativo com os membros todos pausados: os dois dizem que não", async () => {
    const c = await montarCenario("membros-pausados");
    const membro = await criarAgente(c.session, { publicado: false, nome: "membro-pausado" });
    await criarRouter(c.session, { membro });
    expect(await portao(c)).toBe(false);
  });

  it("roteador ativo só com o fallback publicado (em outro número): os dois dizem que sim", async () => {
    const longe = await montarCenario("so-fallback-longe");
    const fallback = await criarAgente(longe.session, { publicado: true, nome: "so-fallback" });
    const c = await montarCenario("so-fallback");
    await criarRouter(c.session, { fallback });
    expect(await portao(c)).toBe(true);
  });
});

/**
 * AS PALAVRAS DE PASSAGEM DE QUEM PODE ATENDER — a outra pergunta que o worker
 * do Jev faz: a regra de hoje "pegou" o pedido de pessoa se a palavra de
 * QUALQUER agente que pode atender a conversa casar. O conjunto é o do portão
 * acima (a versão no número, o fallback e os membros do roteador ativo nele)
 * mais o agente da campanha que criou a conversa — e só quem pode executar.
 */
describe("palavras de passagem de quem pode atender a conversa", () => {
  const comPalavras = (sessao: string, nome: string, palavra: string, publicado = true): Promise<string> =>
    criarAgente(sessao, { publicado, nome, palavras: [palavra] });

  it("junta o do número, o do roteador (membro e fallback) e o da campanha; deixa de fora o pausado, o de fora e o de roteador inativo", async () => {
    const c = await montarCenario("palavras");
    const fora = await montarCenario("palavras-fora");
    const longe = await montarCenario("palavras-longe");
    await comPalavras(c.session, "palavras-no-numero", "no-numero");
    await comPalavras(c.session, "palavras-pausado", "pausado", false);
    const membro = await comPalavras(fora.session, "palavras-membro", "membro");
    const fallback = await comPalavras(fora.session, "palavras-fallback", "fallback");
    const daCampanha = await comPalavras(longe.session, "palavras-campanha", "campanha");
    await comPalavras(fora.session, "palavras-de-fora", "de-fora");
    const doInativo = await comPalavras(fora.session, "palavras-inativo", "roteador-inativo");

    // Um roteador ativo por número (índice único): o inativo nasce e desliga antes.
    const inativo = await criarRouter(c.session, { membro: doInativo });
    await pool.query(`update ai_routers set is_active = false where id = $1`, [inativo]);
    await criarRouter(c.session, { membro, fallback });

    const campanha = proximoId();
    await pool.query(
      `insert into campaigns (id, organization_id, name, channel_session_id, base_legal, lia_ref, agent_id)
       values ($1, $2, 'Campanha das palavras', $3, 'legitimate_interest', 'LIA-PALAVRAS', $4)`,
      [campanha, ORG, fora.session, daCampanha],
    );
    await pool.query(
      `insert into campaign_recipients (organization_id, campaign_id, contact_id, conversation_id, recipient_address, rendered_body)
       values ($1, $2, $3, $4, '+5511900000099', 'oi')`,
      [ORG, campanha, CONTACT, c.conv],
    );

    expect((await palavrasDeQuemPodeAtender(pool, ORG, c.session, c.conv)).sort()).toEqual([
      "campanha",
      "fallback",
      "membro",
      "no-numero",
    ]);
    // No número de fora, conta quem está publicado LÁ; a campanha é da outra
    // conversa, e o agente dela, publicado num terceiro número, não entra.
    expect((await palavrasDeQuemPodeAtender(pool, ORG, fora.session, fora.conv)).sort()).toEqual([
      "de-fora",
      "fallback",
      "membro",
      "roteador-inativo",
    ]);
  });
});
