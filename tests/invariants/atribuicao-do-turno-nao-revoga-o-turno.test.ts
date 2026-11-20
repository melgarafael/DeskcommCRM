/**
 * #3926 — A ATRIBUIÇÃO PEDIDA PELO PRÓPRIO TURNO NÃO REVOGA ESSE TURNO.
 *
 * O defeito, medido em produção: agente publicado com o prompt pedindo, na mesma
 * resposta, mensagem ao cliente, mudança de etapa, `request_human_handoff` e
 * `crm_assign_conversation`. A mensagem saía e a conversa aparecia em "Minhas"
 * do atendente — mas o cartão "Por que a IA passou para você" não nascia e a
 * etapa não mudava. Causa: `fn_conversation_assign(reason='transfer')` insere em
 * `conversation_assignment_events`, o gatilho `trg_interromper_turnos_ao_assumir`
 * lê `transfer` como "uma pessoa assumiu" e marca o job do PRÓPRIO turno como
 * `failed`/`conversation_command_taken`. Dali em diante
 * `requireCurrentAutonomousTurn` (`guardServiceEffect`, a guarda que TODA
 * escrita do turno atravessa) recusa cada efeito com `service_boundary_stale`.
 *
 * A ordem do prompt não protege: as ferramentas da mesma etapa do modelo rodam
 * em paralelo, então a atribuição pode confirmar antes da passagem. Por isso
 * este arquivo reprova a CORRIDA (atribuição primeiro) e também a ordem
 * sequencial da issue (atribuição por último), para que o conserto não dependa
 * de qual delas aconteceu.
 *
 * O que ele prova, na ponta que importa:
 *   · GREEN — as três coisas do turno acontecem: etapa movida, passagem
 *     registrada em `passagens_de_atendimento` e conversa atribuída;
 *   · LADO OPOSTO — um HUMANO assumindo pela tela continua revogando o turno
 *     (a proteção não foi afrouxada), e a guarda segue recusando a escrita
 *     seguinte;
 *   · a poupança é POR JOB, não por conversa: um segundo turno vivo da mesma
 *     conversa continua sendo revogado;
 *   · sessão de pessoa NÃO consegue passar o `source_job_id` para se livrar da
 *     revogação — a função recusa (`source_job_requires_runtime_caller`).
 *
 * Roda no PostgreSQL descartável de `scripts/test-db.sh` (`pnpm test:db`), com o
 * baseline inteiro. Não mede LLM, tela nem transporte externo já iniciado.
 */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { guardServiceEffect, requireCurrentAutonomousTurn, withServiceJob } from "@/lib/atendimento/fronteira-server";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { motivoDoErro, sql } from "./psql-transporte";

const ORG = "39260001-0000-4000-8000-000000000001";
const CONTACT = "39260001-0000-4000-8000-000000000002";
const SESSION = "39260001-0000-4000-8000-000000000003";
const CONVERSATION = "39260001-0000-4000-8000-000000000004";
const OWNER = "39260001-0000-4000-8000-000000000005";
const PIPELINE = "39260001-0000-4000-8000-000000000006";
const STAGE_ABERTURA = "39260001-0000-4000-8000-000000000007";
const STAGE_QUALIFICADO = "39260001-0000-4000-8000-000000000008";
const LEAD = "39260001-0000-4000-8000-000000000009";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 3,
});
afterAll(() => pool.end());

function value(query: string): number {
  return Number(sql(query).trim().split("\n").at(-1));
}

/** O job do turno, com o texto original da aquisição (µs preservados). */
async function turnoAtual(): Promise<JobRow> {
  return (
    await pool.query<JobRow>(
      "select *, locked_at::text as claim_acquired_at from job_queue where organization_id=$1 and status='running' order by created_at limit 1",
      [ORG],
    )
  ).rows[0]!;
}

function seedTurno(status = "running") {
  sql(`insert into public.job_queue (organization_id, contact_id, kind, status, payload, locked_by, locked_at)
    values ('${ORG}', '${CONTACT}', 'inbound_turn', '${status}',
      jsonb_build_object('service_boundary', jsonb_build_object(
        'organization_id', '${ORG}', 'contact_id', '${CONTACT}', 'conversation_id', '${CONVERSATION}',
        'service_revision', 1, 'demanda_id', null, 'demanda_revision', null)),
      ${status === "running" ? "'worker-turno'" : "null"}, ${status === "running" ? "now()" : "null"});`);
}

/** O que `crm_assign_conversation` faz quando roda DENTRO do turno: informa o job. */
function atribuirComOrigem(jobId: string, reason = "transfer") {
  sql(
    `select public.fn_conversation_assign('${ORG}', '${CONVERSATION}', '${OWNER}', '${reason}', null, false, '${jobId}');`,
  );
}

/** O que a tela faz quando uma PESSOA assume: sessão de verdade, sem job de origem. */
function assumirComoPessoa(reason = "claim") {
  sql(`set role authenticated;
    select set_config('request.jwt.claims','{"sub":"${OWNER}"}',false);
    select public.fn_conversation_assign('${ORG}','${CONVERSATION}','${OWNER}','${reason}',null,false);`);
}

/** As duas escritas do turno, cada uma atrás da guarda REAL. */
async function escritasDoTurno() {
  await guardServiceEffect();
  await pool.query("update public.crm_leads set stage_id=$1 where id=$2", [STAGE_QUALIFICADO, LEAD]);
  await guardServiceEffect();
  await pool.query(
    `insert into public.passagens_de_atendimento
      (organization_id, contact_id, conversation_id, motor, origem, motivo_codigo, title, body)
     values ($1,$2,$3,'engine','runtime_nativo','requested_human',
       'Cliente quer falar com uma pessoa',
       'A IA tentou resolver pelo autoatendimento e passou a conversa para o time.')`,
    [ORG, CONTACT, CONVERSATION],
  );
}

function etapaDoCard(): string {
  return sql(`select stage_id from public.crm_leads where id='${LEAD}';`);
}

function passagens(): number {
  return value(
    `select count(*) from public.passagens_de_atendimento where organization_id='${ORG}' and conversation_id='${CONVERSATION}';`,
  );
}

beforeAll(() => {
  sql(`insert into auth.users (id,email) values ('${OWNER}','turno-3926@invariant.test') on conflict do nothing;
    insert into public.organizations (id,slug,legal_name,display_name) values ('${ORG}','turno-3926','Turno','Turno') on conflict do nothing;
    insert into public.user_organizations (user_id,organization_id,role,accepted_at) values ('${OWNER}','${ORG}','agent',now()) on conflict do nothing;
    insert into public.contacts (id,organization_id,display_name) values ('${CONTACT}','${ORG}','Cliente fictício') on conflict do nothing;
    insert into public.channel_sessions (id,organization_id,waha_session_name,webhook_secret_encrypted)
      values ('${SESSION}','${ORG}','turno-3926','\\x00'::bytea) on conflict do nothing;
    insert into public.conversations (id,organization_id,contact_id,channel_session_id,status)
      values ('${CONVERSATION}','${ORG}','${CONTACT}','${SESSION}','open') on conflict do nothing;
    insert into public.crm_pipelines (id,organization_id,name,slug) values ('${PIPELINE}','${ORG}','Funil','funil-3926') on conflict do nothing;
    insert into public.crm_stages (id,organization_id,pipeline_id,name,slug,position)
      values ('${STAGE_ABERTURA}','${ORG}','${PIPELINE}','Abertura','abertura-3926',1),
             ('${STAGE_QUALIFICADO}','${ORG}','${PIPELINE}','Qualificado','qualificado-3926',2)
      on conflict do nothing;
    insert into public.crm_leads (id,organization_id,pipeline_id,stage_id,contact_id,title)
      values ('${LEAD}','${ORG}','${PIPELINE}','${STAGE_ABERTURA}','${CONTACT}','Negócio fictício')
      on conflict do nothing;`);
});

beforeEach(() => {
  sql(`delete from public.job_queue where organization_id='${ORG}';
    delete from public.passagens_de_atendimento where organization_id='${ORG}';
    delete from public.conversation_assignment_events where organization_id='${ORG}';
    update public.conversations set assigned_to_user_id=null, assigned_to_user_name=null, assignee_kind=null,
      bot_silenced_until=null, last_handoff_at=null, status='open' where id='${CONVERSATION}';
    update public.crm_leads set stage_id='${STAGE_ABERTURA}' where id='${LEAD}';`);
});

describe("#3926 — a atribuição do próprio turno não derruba o turno", () => {
  it("CORRIDA (atribuição confirma antes): etapa move, passagem nasce e a conversa fica atribuída", async () => {
    seedTurno();
    const job = await turnoAtual();

    // A ferramenta de atribuir terminou primeiro — é o que o AI SDK permite,
    // porque as chamadas da mesma etapa do modelo rodam em paralelo.
    atribuirComOrigem(job.id);

    // O resto do turno segue: são estas duas escritas que sumiam em produção.
    await withServiceJob(pool, job, escritasDoTurno);

    expect(etapaDoCard()).toBe(STAGE_QUALIFICADO);
    expect(passagens()).toBe(1);
    expect(
      value(
        `select count(*) from public.conversations where id='${CONVERSATION}' and assigned_to_user_id='${OWNER}';`,
      ),
    ).toBe(1);
    // O turno continua sendo o dono do próprio comando.
    expect(
      value(`select count(*) from public.job_queue where id='${job.id}' and status='running';`),
    ).toBe(1);
    await expect(requireCurrentAutonomousTurn(pool, job)).resolves.toBeUndefined();
  });

  it("ORDEM DA ISSUE (atribuição por último): as três coisas do turno ficam registradas", async () => {
    seedTurno();
    const job = await turnoAtual();

    await withServiceJob(pool, job, escritasDoTurno);
    atribuirComOrigem(job.id);

    expect(etapaDoCard()).toBe(STAGE_QUALIFICADO);
    expect(passagens()).toBe(1);
    expect(
      value(
        `select count(*) from public.conversations where id='${CONVERSATION}' and assigned_to_user_id='${OWNER}';`,
      ),
    ).toBe(1);
    expect(
      value(`select count(*) from public.job_queue where id='${job.id}' and status='running';`),
    ).toBe(1);
  });

  it("LADO OPOSTO: uma PESSOA assumindo pela tela continua revogando o turno", async () => {
    seedTurno();
    const job = await turnoAtual();

    assumirComoPessoa("claim");

    expect(
      value(
        `select count(*) from public.job_queue where id='${job.id}' and status='failed'
          and last_error='conversation_command_taken' and locked_at is null and locked_by is null;`,
      ),
    ).toBe(1);
    await expect(requireCurrentAutonomousTurn(pool, job)).rejects.toThrow("service_boundary_stale");
    // E o efeito seguinte do turno é recusado — a proteção segue de pé.
    await expect(withServiceJob(pool, job, escritasDoTurno)).rejects.toThrow("service_boundary_stale");
    expect(etapaDoCard()).toBe(STAGE_ABERTURA);
    expect(passagens()).toBe(0);
  });

  it("LADO OPOSTO (transferência por outra pessoa): também revoga", async () => {
    seedTurno();
    const job = await turnoAtual();

    assumirComoPessoa("transfer");

    expect(
      value(`select count(*) from public.job_queue where id='${job.id}' and status='failed';`),
    ).toBe(1);
    await expect(requireCurrentAutonomousTurn(pool, job)).rejects.toThrow("service_boundary_stale");
  });

  it("a poupança é POR JOB: outro turno vivo da mesma conversa continua revogado", async () => {
    seedTurno();
    const job = await turnoAtual();
    // Um turno irmão pendente na MESMA conversa (ex.: follow-up enfileirado).
    seedTurno("pending");

    atribuirComOrigem(job.id);

    expect(
      value(`select count(*) from public.job_queue where id='${job.id}' and status='running';`),
    ).toBe(1);
    expect(
      value(
        `select count(*) from public.job_queue where organization_id='${ORG}' and id<>'${job.id}' and status='failed';`,
      ),
    ).toBe(1);
  });

  it("sessão de pessoa NÃO consegue se livrar da revogação passando o job do turno", async () => {
    seedTurno();
    const job = await turnoAtual();

    expect(() =>
      sql(`set role authenticated;
        select set_config('request.jwt.claims','{"sub":"${OWNER}"}',false);
        select public.fn_conversation_assign('${ORG}','${CONVERSATION}','${OWNER}','claim',null,false,'${job.id}');`),
    ).toThrow(/source_job_requires_runtime_caller/);

    // Nada mudou: a conversa não foi assumida e o turno segue vivo.
    expect(
      value(
        `select count(*) from public.conversations where id='${CONVERSATION}' and assigned_to_user_id is null;`,
      ),
    ).toBe(1);
    expect(
      value(`select count(*) from public.job_queue where id='${job.id}' and status='running';`),
    ).toBe(1);
  });

  it("o fato da atribuição guarda o job de origem — e fica nulo quando quem atribui é gente", async () => {
    seedTurno();
    const job = await turnoAtual();

    atribuirComOrigem(job.id);
    expect(
      sql(
        `select coalesce(source_job_id::text,'-') from public.conversation_assignment_events
          where organization_id='${ORG}' and conversation_id='${CONVERSATION}' and reason='transfer';`,
      ),
    ).toBe(job.id);

    sql(`delete from public.job_queue where organization_id='${ORG}';
      update public.conversations set assigned_to_user_id=null, assigned_to_user_name=null,
        assignee_kind=null, bot_silenced_until=null, status='open' where id='${CONVERSATION}';`);
    assumirComoPessoa("claim");
    expect(
      sql(
        `select coalesce(source_job_id::text,'-') from public.conversation_assignment_events
          where organization_id='${ORG}' and conversation_id='${CONVERSATION}' and reason='claim';`,
      ),
    ).toBe("-");
  });

  it("controle do instrumento: o gatilho é a única coisa que muda o job (sem atribuição, tudo passa)", async () => {
    seedTurno();
    const job = await turnoAtual();
    await withServiceJob(pool, job, escritasDoTurno);
    expect(etapaDoCard()).toBe(STAGE_QUALIFICADO);
    expect(passagens()).toBe(1);
    expect(() => motivoDoErro(new Error("x"))).not.toThrow();
  });
});
