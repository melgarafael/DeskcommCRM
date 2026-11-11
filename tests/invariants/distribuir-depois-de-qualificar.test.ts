/**
 * DISTRIBUIR A CONVERSA SÓ DEPOIS QUE A IA QUALIFICAR (issue #3966) — invariante
 * de banco, worker REAL.
 *
 * ## O defeito que este arquivo mede
 *
 * Com rodízio/carga ligado, a conversa era distribuída NO NASCIMENTO:
 * `trg_conversation_routing_requested` (AFTER INSERT) → `conversation.
 * routing_requested` → `routing-worker`, e `decideRouting` não perguntava se
 * havia agente de IA atendendo. A atribuição grava `assignee_kind='user'` e o
 * gate da IA (`lib/ai/elegibilidade/gate.ts:188`) cala o agente com o motivo
 * `conversa_de_humano`. Num número com agente de qualificação, o lead recebia a
 * primeira resposta da IA e era entregue a uma pessoa em menos de um minuto.
 *
 * ## Por que a prova é de BANCO e não de unidade pura
 *
 * A distribuição mora no banco em duas pontas: o gatilho emite o evento (com o
 * índice único de evento ativo), e quem dá o dono é `fn_channel_routing_claim`
 * → `fn_conversation_assign`, com carga, capacidade, jornada e a escrita de
 * `assignee_kind`. Um dublê provaria que o objeto foi lido — não que a conversa
 * ficou SEM dono no Postgres de verdade, nem que o segundo tick não a
 * redistribuiu. Aqui o `runRoutingWorker` roda contra o Postgres efêmero do
 * `pnpm test:db` (ponte `tests/support/routing-pg-supabase.ts`), com as réguas,
 * RPCs e gatilhos reais.
 *
 * ## A regra que os casos abaixo fecham, um por um
 *
 *   RED   opção desligada ⇒ distribuída no primeiro tick (o defeito, e o
 *         comportamento de quem não ligar a opção — byte a byte o de hoje);
 *   GREEN opção ligada + agente no número ⇒ a conversa fica COM a IA, sem dono;
 *   GREEN ao passar para humano ⇒ distribuída UMA vez, e a IA cala
 *         (`conversa_de_humano`) como hoje;
 *   (b)   sem agente no número ⇒ distribuída na hora;
 *   (c)   IA pausada / silenciada / contato em `ai_opt_out` ⇒ distribuída;
 *   (d)   limite de espera esgotado ⇒ distribuída mesmo sem sinal;
 *   (e)   worker rodando duas vezes ⇒ um dono e UMA linha de rodízio;
 *   (f)   outra organização ⇒ o estado dela decide, não o desta;
 *   (g)   conversa já distribuída ⇒ não volta ao rodízio (sem loop).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

import { decidirElegibilidade } from "@/lib/ai/elegibilidade/gate";
import { runRoutingWorker } from "@/lib/routing/worker";
import { createAdminClient } from "@/lib/supabase/admin";

import { routingPgSupabase } from "../support/routing-pg-supabase";
import { GOV_AGENT_A as ana, GOV_AGENT_B as bruno, GOV_ORG as org, GOV_SESSION as canal, seedGov } from "./gov-helpers";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 5,
});
const query = (text: string, args: unknown[] = []) => pool.query(text, args);

// Fixtures próprias (namespace eeeeeeee-): o seed do gov usa cccc…, e os dois
// convivem no mesmo banco por arquivo sem colisão.
const AGENTE = "eeeeeeee-1111-4000-8000-000000000001";
const VERSAO = "eeeeeeee-2222-4000-8000-000000000001";
const CONV_A = "eeeeeeee-4444-4000-8000-000000000001";
const CONTATO_A = "eeeeeeee-3333-4000-8000-000000000001";
const CONV_CASO = "eeeeeeee-4444-4000-8000-000000000002";
const CONTATO_CASO = "eeeeeeee-3333-4000-8000-000000000002";
const CONV_SEM_AGENTE = "eeeeeeee-4444-4000-8000-000000000003";
const CONTATO_SEM_AGENTE = "eeeeeeee-3333-4000-8000-000000000003";
const CONV_LIMITE = "eeeeeeee-4444-4000-8000-000000000004";
const CONTATO_LIMITE = "eeeeeeee-3333-4000-8000-000000000004";
const CONV_OUTRA_ORG = "eeeeeeee-4444-4000-8000-000000000005";
const CONTATO_OUTRA_ORG = "eeeeeeee-3333-4000-8000-000000000005";

const CONVERSAS = [CONV_A, CONV_CASO, CONV_SEM_AGENTE, CONV_LIMITE];
const CONTATOS = [CONTATO_A, CONTATO_CASO, CONTATO_SEM_AGENTE, CONTATO_LIMITE];

// Organização B: harness próprio, canal próprio, para o caso (f).
const OUTRA_ORG = "eeeeeeee-0000-4000-8000-000000000002";
const OUTRA_SESSAO = "eeeeeeee-2222-4000-8000-000000000002";
const OUTRA_ANA = "eeeeeeee-1111-4000-8000-000000000002";

const conversa = async (id: string, orgId: string = org) =>
  (
    await query(
      "select assigned_to_user_id, assignee_kind, status, bot_silenced_until from conversations where organization_id=$1 and id=$2",
      [orgId, id],
    )
  ).rows[0] as {
    assigned_to_user_id: string | null;
    assignee_kind: string | null;
    status: string;
    bot_silenced_until: string | null;
  };

const eventoDe = async (id: string) =>
  (
    await query(
      "select status, attempts, consumed_by from event_log where organization_id=$1 and entity_id=$2 and event_type='conversation.routing_requested' order by created_at desc limit 1",
      [org, id],
    )
  ).rows[0] as { status: string; attempts: number; consumed_by: string[] } | undefined;

const linhasDeRodizio = async (id: string) =>
  (
    await query(
      "select count(*)::int n from conversation_assignment_events where organization_id=$1 and conversation_id=$2 and reason='routing'",
      [org, id],
    )
  ).rows[0] as { n: number };

/**
 * Contatos e conversas do arquivo (namespace eeeeeeee-), idempotentes. Cada
 * conversa tem contato PRÓPRIO: `uniq_conversations_1to1_per_contact_session`
 * permite uma só 1:1 por (org, contato, sessão).
 */
async function semearFixtures() {
  const nomes = ["A", "Caso", "Sem agente", "Limite"] as const;
  for (let i = 0; i < CONVERSAS.length; i += 1) {
    await query(
      "insert into contacts (id, organization_id, display_name) values ($1,$2,$3) on conflict (id) do nothing",
      [CONTATOS[i], org, `Contato 3966 ${nomes[i]}`],
    );
    await query(
      "insert into conversations (id, organization_id, contact_id, channel_session_id, status) values ($1,$2,$3,$4,'open') on conflict (id) do nothing",
      [CONVERSAS[i], org, CONTATOS[i], canal],
    );
  }
}

/** A opção na ORGANIZAÇÃO — o caminho que o PATCH de /settings/routing grava. */
async function configurar(
  opcoes: { espera: boolean; limite?: number; mode?: string },
  orgId: string = org,
) {
  await query(
    "update organizations set settings = coalesce(settings,'{}'::jsonb) || jsonb_build_object('routing', jsonb_build_object('mode',$2::text,'distribute_only_after_qualification',$3::boolean,'qualification_wait_minutes',$4::int)) where id=$1",
    [orgId, opcoes.mode ?? "round_robin", opcoes.espera, opcoes.limite ?? 1440],
  );
}

/**
 * O agente de qualificação do número: `ai_agents` com versão PUBLICADA ligada à
 * sessão — é o que `agenteAtende` exige (`published_version_id` + sem
 * `paused_at`). `pausado` e `semVersaoPublicada` cobrem o caso (c).
 */
async function semearAgente(
  opcoes: { pausado?: boolean; semVersaoPublicada?: boolean; orgId?: string; sessao?: string; agente?: string; versao?: string } = {},
) {
  const orgId = opcoes.orgId ?? org;
  const agente = opcoes.agente ?? AGENTE;
  const versao = opcoes.versao ?? VERSAO;
  const sessao = opcoes.sessao ?? canal;
  await query(
    "insert into ai_agents (id, organization_id, name, system_prompt, kind, is_active, paused_at) values ($1,$2,$3,'qualifica','mcp_agent',true,$4) on conflict (id) do nothing",
    [agente, orgId, `agente-3966-${agente.slice(-2)}`, opcoes.pausado ? new Date() : null],
  );
  if (opcoes.semVersaoPublicada) return;
  await query(
    "insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status, published_at) values ($1,$2,$3,1,'qualifica','anthropic','claude-sonnet-4-6',$4,'published',now()) on conflict (id) do nothing",
    [versao, orgId, agente, sessao],
  );
  await query("update ai_agents set published_version_id=$2 where id=$1 and organization_id=$3", [
    agente,
    versao,
    orgId,
  ]);
}

/**
 * O pedido de roteamento, do jeito que o banco o produz: reabre o evento da
 * conversa (o gatilho só emite no INSERT, e o seed já rodou) e, quando não há
 * evento nenhum, usa a porta real (`fn_request_channel_routing`).
 */
async function pedirRoteamento(id: string, orgId: string = org) {
  const reaberto = await query(
    "update event_log set status='pending', next_attempt_at=null, attempts=0, consumed_by='{}'::text[] where organization_id=$1 and entity_id=$2 and event_type='conversation.routing_requested'",
    [orgId, id],
  );
  if (reaberto.rowCount === 0) {
    await query("select fn_request_channel_routing($1,$2)", [orgId, id]);
  }
}

async function rodarWorker(now: Date = new Date()) {
  const adapter = routingPgSupabase(pool);
  vi.mocked(createAdminClient).mockReturnValue(adapter.client as never);
  const resultado = await runRoutingWorker({ now });
  expect(adapter.errors).toEqual([]);
  return resultado;
}

/** O gate da IA lido com o estado REAL da conversa (mesma função do motor). */
const gateDaConversa = (assigneeKind: string | null) =>
  decidirElegibilidade({
    orgStatus: "active",
    canalDesativado: false,
    modo: "open",
    forceHuman: false,
    contatoInterno: false,
    contatoDaEquipe: false,
    aiOptOut: false,
    botSilencedUntil: null,
    assigneeKind,
    // A régua da main ganhou o "IA com o dono": `false` mantém o comportamento
    // que este helper já media — dono humano na conversa veta a IA.
    iaComDono: false,
    aiAuthorizedAt: null,
    preGoLiveAtivo: false,
    numeroDeTesteAutorizado: false,
    agora: new Date(),
    ttlMs: 86_400_000,
  });

beforeAll(() => seedGov());
afterAll(() => pool.end());

beforeEach(async () => {
  // Estado de partida: sem agente, sem a opção, conversas sem dono e sem as
  // marcas de passagem — cada caso monta só o que precisa.
  await query("delete from ai_agent_versions where organization_id=$1", [org]);
  await query("delete from ai_agents where organization_id=$1", [org]);
  await query(
    "update organizations set settings = coalesce(settings,'{}'::jsonb) - 'routing' where id=$1",
    [org],
  );
  await query("delete from conversation_assignment_events where organization_id=$1", [org]);
  await query("delete from agent_cases where organization_id=$1", [org]);
  await query("delete from lead_state where organization_id=$1", [org]);
  await semearFixtures();
  await query(
    "update contacts set force_human=false, ai_opt_out=false, is_blocked=false where organization_id=$1 and id = any($2)",
    [org, CONTATOS],
  );
  await query(
    "update conversations set assigned_to_user_id=null, assigned_to_user_name=null, assigned_at=null, assignee_kind=null, status='open', bot_silenced_until=null, last_handoff_at=null, created_at=now(), sector_id=null where organization_id=$1 and id = any($2)",
    [org, CONVERSAS],
  );
  await query("update user_organizations set revoked_at=null, role='agent' where organization_id=$1 and user_id=any($2)", [
    org,
    [ana, bruno],
  ]);
  for (const user of [ana, bruno]) {
    await query(
      "insert into attendant_availability (organization_id, user_id, is_available, capacity, schedule) values ($1,$2,true,10,'{}') on conflict (organization_id,user_id) do update set is_available=true, capacity=10, schedule='{}'",
      [org, user],
    );
  }
  // SÓ os eventos deste arquivo — e por ÚLTIMO, depois da disponibilidade.
  // `trg_routing_availability_changed` acorda a fila de TODA conversa sem dono
  // da organização a cada upsert acima (inclusive as do seed do gov), e o worker
  // as distribuiria junto: as contagens por desfecho deixariam de ser as nossas.
  // Apagar depois de tudo é o que torna cada caso medido, em vez de "o worker
  // fez alguma coisa".
  await query(
    "delete from event_log where event_type='conversation.routing_requested' and organization_id = any($1)",
    [[org, OUTRA_ORG]],
  );
});

describe("o defeito (RED) e o conserto (GREEN)", () => {
  it("RED literal — opção DESLIGADA: a IA atende e a conversa é distribuída no primeiro tick", async () => {
    // É o mundo de hoje e o de quem não liga a opção: nada muda.
    await configurar({ espera: false });
    await semearAgente();
    await pedirRoteamento(CONV_A);

    const primeiroTick = await rodarWorker();

    expect(primeiroTick.outcomes.assigned).toBe(1);
    // A conversa nasce, a IA responde a 1ª mensagem, e MESMO ASSIM ganha dono.
    const depois = await conversa(CONV_A);
    expect(depois.assigned_to_user_id).not.toBeNull();
    expect(depois.assignee_kind).toBe("user");
    // E o gate cala a IA que deveria qualificar — o motivo medido.
    expect(gateDaConversa(depois.assignee_kind)).toMatchObject({
      permite: false,
      motivo: "conversa_de_humano",
    });
  });

  it("GREEN — opção LIGADA com agente no número: a conversa NÃO é distribuída enquanto a IA atende", async () => {
    await configurar({ espera: true });
    await semearAgente();
    await pedirRoteamento(CONV_A);

    const primeiroTick = await rodarWorker();

    expect(primeiroTick.outcomes.waiting_qualification).toBe(1);
    expect(primeiroTick.outcomes.assigned).toBe(0);
    const depois = await conversa(CONV_A);
    expect(depois).toMatchObject({
      assigned_to_user_id: null,
      assignee_kind: null,
      status: "open",
    });
    // O evento continua PENDENTE (é ele que traz o worker de volta) e a espera
    // NÃO gasta tentativa — senão cairia no backoff de `max_retries` em 5 min.
    expect(await eventoDe(CONV_A)).toMatchObject({ status: "pending", attempts: 0 });
    // E nenhuma linha de rodízio foi escrita: a conversa não foi de ninguém.
    expect((await linhasDeRodizio(CONV_A)).n).toBe(0);
  });

  it("GREEN — a passagem para humano distribui UMA vez, e aí a IA cala como hoje", async () => {
    await configurar({ espera: true });
    await semearAgente();
    await pedirRoteamento(CONV_A);
    expect((await rodarWorker()).outcomes.waiting_qualification).toBe(1);

    // A passagem nativa (`performHumanHandoff`): trava o contato, silencia a IA e
    // marca o instante — `status` só sai de `ai_handling`, e a conversa nasce
    // `open`, então são as MARCAS que carregam o fato.
    await query(
      "update contacts set force_human=true where organization_id=$1 and id=$2",
      [org, CONTATO_A],
    );
    await query(
      "update conversations set bot_silenced_until='infinity', last_handoff_at=now() where organization_id=$1 and id=$2",
      [org, CONV_A],
    );
    await pedirRoteamento(CONV_A);

    const segundoTick = await rodarWorker();
    expect(segundoTick.outcomes.assigned).toBe(1);
    const distribuida = await conversa(CONV_A);
    expect(distribuida).toMatchObject({ assigned_to_user_id: ana, assignee_kind: "user" });
    expect((await linhasDeRodizio(CONV_A)).n).toBe(1);
    expect(gateDaConversa(distribuida.assignee_kind)).toMatchObject({
      permite: false,
      motivo: "conversa_de_humano",
    });

    // (e) o worker roda de novo e NADA muda: um dono, uma linha de rodízio.
    const terceiroTick = await rodarWorker();
    expect(terceiroTick.outcomes.assigned).toBe(0);
    expect((await conversa(CONV_A)).assigned_to_user_id).toBe(ana);
    expect((await linhasDeRodizio(CONV_A)).n).toBe(1);
  });

  it("GREEN — o CASO pedindo pessoa encerra a espera (a qualificação acabou)", async () => {
    await configurar({ espera: true });
    await semearAgente();
    await query(
      "insert into agent_cases (organization_id, conversation_id, status, title, summary, blocker) values ($1,$2,'awaiting_human','quer falar com alguém','o lead pediu uma pessoa','precisa de humano')",
      [org, CONV_CASO],
    );
    await pedirRoteamento(CONV_CASO);

    expect((await rodarWorker()).outcomes.assigned).toBe(1);
    expect((await conversa(CONV_CASO)).assigned_to_user_id).not.toBeNull();
  });

  it("GREEN — o lead que a IA já qualificou não espera (o critério foi cumprido)", async () => {
    await configurar({ espera: true });
    await semearAgente();
    await query(
      "insert into lead_state (organization_id, contact_id, stage) values ($1,$2,'qualified')",
      [org, CONTATO_A],
    );
    await pedirRoteamento(CONV_A);

    expect((await rodarWorker()).outcomes.assigned).toBe(1);
  });
});

describe("os lados opostos — nenhum deles pode ficar preso", () => {
  it("(b) SEM agente de IA no número: distribui na hora", async () => {
    await configurar({ espera: true });
    // sem `semearAgente()`: o número não tem agente nenhum.
    await pedirRoteamento(CONV_SEM_AGENTE);

    const tick = await rodarWorker();
    expect(tick.outcomes.assigned).toBe(1);
    expect((await conversa(CONV_SEM_AGENTE)).assigned_to_user_id).not.toBeNull();
  });

  it("(b') agente existe mas está PAUSADO: distribui (não há IA para qualificar)", async () => {
    await configurar({ espera: true });
    await semearAgente({ pausado: true });
    await pedirRoteamento(CONV_A);

    expect((await rodarWorker()).outcomes.assigned).toBe(1);
  });

  it("(b'') agente sem versão PUBLICADA: distribui (não responde, não qualifica)", async () => {
    await configurar({ espera: true });
    await semearAgente({ semVersaoPublicada: true });
    await pedirRoteamento(CONV_A);

    expect((await rodarWorker()).outcomes.assigned).toBe(1);
  });

  it("(c) IA silenciada nesta conversa: distribui", async () => {
    await configurar({ espera: true });
    await semearAgente();
    await query(
      "update conversations set bot_silenced_until=now() + interval '1 hour' where organization_id=$1 and id=$2",
      [org, CONV_A],
    );
    await pedirRoteamento(CONV_A);

    expect((await rodarWorker()).outcomes.assigned).toBe(1);
  });

  it("(c') contato com ai_opt_out: distribui (o 'sempre humano' não pode esperar a IA)", async () => {
    await configurar({ espera: true });
    await semearAgente();
    await query("update contacts set ai_opt_out=true where organization_id=$1 and id=$2", [
      org,
      CONTATO_A,
    ]);
    await pedirRoteamento(CONV_A);

    expect((await rodarWorker()).outcomes.assigned).toBe(1);
  });

  it("(d) LIMITE esgotado sem sinal nenhum: distribui mesmo assim", async () => {
    await configurar({ espera: true, limite: 60 });
    await semearAgente();
    // Nasceu há duas horas; o limite é de uma.
    await query(
      "update conversations set created_at=now() - interval '2 hours' where organization_id=$1 and id=$2",
      [org, CONV_LIMITE],
    );
    await pedirRoteamento(CONV_LIMITE);

    expect((await rodarWorker()).outcomes.assigned).toBe(1);
  });

  it("(f) outra ORGANIZAÇÃO intacta: o estado dela é que decide", async () => {
    await seedOutraOrg();
    await configurar({ espera: true }); // a org A espera…
    // …a org B ligou o RODÍZIO (que é opt-in) e não ligou a espera: o estado
    // dela decide, não o da org A.
    await configurar({ espera: false }, OUTRA_ORG);
    await semearAgente();
    await pedirRoteamento(CONV_A);
    await pedirRoteamento(CONV_OUTRA_ORG, OUTRA_ORG);

    await rodarWorker();

    // …e a org B, que nunca ligou a opção, distribui como sempre distribuiu.
    expect((await conversa(CONV_A)).assigned_to_user_id).toBeNull();
    expect((await conversa(CONV_OUTRA_ORG, OUTRA_ORG)).assigned_to_user_id).toBe(OUTRA_ANA);
  });

  it("(g) conversa já distribuída NÃO volta ao rodízio (sem loop)", async () => {
    await configurar({ espera: false });
    await semearAgente();
    await pedirRoteamento(CONV_A);
    expect((await rodarWorker()).outcomes.assigned).toBe(1);

    // Uma mensagem nova não reenfileira: a porta do banco recusa conversa com
    // dono (`fn_request_channel_routing`), e é isso que impede o loop.
    await query("select fn_request_channel_routing($1,$2)", [org, CONV_A]);
    expect(await eventoDe(CONV_A)).toMatchObject({ status: "done" });

    // Mesmo com um evento pendente sobrando (o que um replay deixaria), o worker
    // não reatribui e não escreve segunda linha de rodízio.
    await pedirRoteamento(CONV_A);
    const tick = await rodarWorker();
    expect(tick.outcomes.skipped_already_assigned).toBe(1);
    expect((await conversa(CONV_A)).assigned_to_user_id).toBe(ana);
    expect((await linhasDeRodizio(CONV_A)).n).toBe(1);
  });
});

/** Organização B: org, membro, sessão, contato e conversa próprios (caso f). */
async function seedOutraOrg() {
  await query("insert into auth.users (id, email) values ($1,'outra-org@invariant.test') on conflict do nothing", [
    OUTRA_ANA,
  ]);
  await query(
    "insert into organizations (id, slug, legal_name, display_name) values ($1,'outra-3966','Outra 3966','Outra 3966') on conflict do nothing",
    [OUTRA_ORG],
  );
  await query(
    "insert into user_organizations (user_id, organization_id, role, accepted_at) values ($1,$2,'agent',now()) on conflict do nothing",
    [OUTRA_ANA, OUTRA_ORG],
  );
  // `on conflict (id)` e NÃO `do nothing` sem arbiter: `channel_sessions` tem
  // unique DEFERRABLE em (org, telefone), e ON CONFLICT sem arbiter a rejeita
  // (mesma nota do gov-helpers). O arbiter por id é o único que este insert
  // disputa.
  await query(
    "insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted) values ($1,$2,'outra-3966','" + "\\x00" + "'::bytea) on conflict (id) do nothing",
    [OUTRA_SESSAO, OUTRA_ORG],
  );
  await query(
    "insert into contacts (id, organization_id, display_name) values ($1,$2,'Contato outra org') on conflict do nothing",
    [CONTATO_OUTRA_ORG, OUTRA_ORG],
  );
  await query(
    "insert into conversations (id, organization_id, contact_id, channel_session_id, status) values ($1,$2,$3,$4,'open') on conflict do nothing",
    [CONV_OUTRA_ORG, OUTRA_ORG, CONTATO_OUTRA_ORG, OUTRA_SESSAO],
  );
  await query(
    "insert into attendant_availability (organization_id, user_id, is_available, capacity, schedule) values ($1,$2,true,10,'{}') on conflict (organization_id,user_id) do update set is_available=true, capacity=10",
    [OUTRA_ORG, OUTRA_ANA],
  );
  await query("delete from conversation_assignment_events where organization_id=$1", [OUTRA_ORG]);
  await query(
    "update conversations set assigned_to_user_id=null, assignee_kind=null, status='open' where organization_id=$1",
    [OUTRA_ORG],
  );
}
