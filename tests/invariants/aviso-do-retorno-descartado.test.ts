/**
 * #4696 — O RETORNO COMBINADO QUE NÃO SAI PASSA A CONTAR.
 *
 * O defeito, medido no relato: quando o atendimento muda antes do disparo,
 * `assertCurrentServiceBoundary` lança `service_boundary_stale` e
 * `descartarFollowupObsoleto` encerra o job `followup_turn`. O descarte está
 * CERTO — mandar a mensagem escreveria ao cliente em nome de um atendimento que
 * já não existe. O que estava errado era o silêncio: 11 descartes em 17 dias, e
 * num deles o cliente esperava um contato que nunca sairia. Quem descobriu
 * manteve um script na VPS lendo `job_queue` para não perder o combinado.
 *
 * Este arquivo mede as duas pontas, na ordem em que a issue as pede:
 *
 *   1. ANTES (o silêncio): descarte por fronteira velha deixa o job `failed` e
 *      NADA na Central, NADA na ficha do contato;
 *   2. DEPOIS: UM aviso legível na Central (com contato, horário combinado e
 *      motivo em língua de gente, nunca o código do erro) e UMA linha na linha
 *      do tempo do contato;
 *   3. os controles: o mesmo contato descartado duas vezes no mesmo dia NÃO
 *      duplica o aviso; outra causa de descarte NÃO usa este aviso; e o followup
 *      que dispara normalmente não gera aviso nenhum.
 *
 * Roda no PostgreSQL descartável de `scripts/test-db.sh` (`pnpm test:db`), com o
 * baseline inteiro. Não mede LLM, tela nem transporte externo já iniciado.
 */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { descartarFollowupObsoleto } from "@/lib/atendimento/descartar-followup-obsoleto";
import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import { completeJob, type JobRow } from "@/lib/agent-engine/queue/queue";
import { disporJobAposFalha } from "@/workers/agent-worker/dispor-job-apos-falha";
import { sql } from "./psql-transporte";

const ORG = "46960001-0000-4000-8000-000000000001";
const CONTACT = "46960001-0000-4000-8000-000000000002";
const SESSION = "46960001-0000-4000-8000-000000000003";
const CONVERSATION = "46960001-0000-4000-8000-000000000004";
const OWNER = "46960001-0000-4000-8000-000000000005";
const PIPELINE = "46960001-0000-4000-8000-000000000006";
const STAGE = "46960001-0000-4000-8000-000000000007";
const LEAD = "46960001-0000-4000-8000-000000000008";

/**
 * O horário que estava combinado. Fixo e no passado do fuso da empresa
 * (America/Sao_Paulo, -03 o ano inteiro desde 2019): a frase do aviso tem de
 * dizer "14/11 às 15:00", e um instante fixo é o que faz a asserção medir a
 * formatação em vez do relógio de quem roda.
 */
const COMBINADO = "2026-11-14T18:00:00Z";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 3,
});
afterAll(() => pool.end());

/** O logger do worker não interessa aqui: o desfecho é o que está no banco. */
const logMudo = { warn: () => {} };

function value(query: string): number {
  return Number(sql(query).trim().split(/\r?\n/).at(-1));
}

function texto(query: string): string {
  return sql(query).trim().split(/\r?\n/).at(-1) ?? "";
}

/** O job do turno, com o texto original da aquisição (µs preservados). */
async function jobAtual(status = "running"): Promise<JobRow> {
  return (
    await pool.query<JobRow>(
      "select *, locked_at::text as claim_acquired_at from job_queue where organization_id=$1 and status=$2 order by created_at limit 1",
      [ORG, status],
    )
  ).rows[0]!;
}

function seedJob(combinadoPara = COMBINADO) {
  sql(`insert into public.job_queue (organization_id, contact_id, kind, status, payload, run_after, locked_by, locked_at)
    values ('${ORG}', '${CONTACT}', 'followup_turn', 'running',
      jsonb_build_object('service_boundary', jsonb_build_object(
        'organization_id', '${ORG}', 'contact_id', '${CONTACT}', 'conversation_id', '${CONVERSATION}',
        'service_revision', 1, 'demanda_id', null, 'demanda_revision', null),
        'purpose', 'send_message', 'node_id', 'enviar', 'source_step_key', 'retorno:0'),
      '${combinadoPara}'::timestamptz, 'worker-turno', now());`);
}

function avisos(): number {
  return value(
    `select count(*) from public.agent_inbox_items
      where organization_id='${ORG}' and kind='followup_descartado';`,
  );
}

function linhasDoContato(): number {
  return value(
    `select count(*) from public.crm_lead_activities
      where organization_id='${ORG}' and contact_id='${CONTACT}' and type='followup_discarded';`,
  );
}

beforeAll(() => {
  sql(`insert into auth.users (id,email) values ('${OWNER}','retorno-4696@invariant.test') on conflict do nothing;
    insert into public.organizations (id,slug,legal_name,display_name,timezone)
      values ('${ORG}','retorno-4696','Retorno','Retorno','America/Sao_Paulo') on conflict do nothing;
    insert into public.user_organizations (user_id,organization_id,role,accepted_at)
      values ('${OWNER}','${ORG}','agent',now()) on conflict do nothing;
    insert into public.contacts (id,organization_id,display_name)
      values ('${CONTACT}','${ORG}','Marina Prado') on conflict do nothing;
    insert into public.channel_sessions (id,organization_id,waha_session_name,webhook_secret_encrypted)
      values ('${SESSION}','${ORG}','retorno-4696','\\x00'::bytea) on conflict do nothing;
    insert into public.conversations (id,organization_id,contact_id,channel_session_id,status)
      values ('${CONVERSATION}','${ORG}','${CONTACT}','${SESSION}','open') on conflict do nothing;
    insert into public.crm_pipelines (id,organization_id,name,slug)
      values ('${PIPELINE}','${ORG}','Funil','funil-4696') on conflict do nothing;
    insert into public.crm_stages (id,organization_id,pipeline_id,name,slug,position)
      values ('${STAGE}','${ORG}','${PIPELINE}','Abertura','abertura-4696',1) on conflict do nothing;
    insert into public.crm_leads (id,organization_id,pipeline_id,stage_id,contact_id,title,status)
      values ('${LEAD}','${ORG}','${PIPELINE}','${STAGE}','${CONTACT}','Reforma da cozinha','open')
      on conflict do nothing;`);
});

beforeEach(() => {
  sql(`delete from public.job_queue where organization_id='${ORG}';
    delete from public.agent_inbox_items where organization_id='${ORG}';
    delete from public.crm_lead_activities where organization_id='${ORG}';
    update public.conversations set status='open', assigned_to_user_id=null, assignee_kind=null,
      bot_silenced_until=null, last_handoff_at=null where id='${CONVERSATION}';`);
});

describe("#4696 — o retorno descartado deixa de sumir sem aviso", () => {
  it("(a) descarte por service_boundary_stale cria UM aviso legível na Central", async () => {
    seedJob();
    const job = await jobAtual();

    // O caminho REAL do worker: o turno estoura `StaleServiceBoundaryError`
    // (o atendimento mudou entre o claim e o disparo) e `disporJobAposFalha`
    // decide o que fazer com o job. É aqui que o silêncio acontecia.
    await disporJobAposFalha(
      pool,
      job,
      "worker-turno",
      new StaleServiceBoundaryError(),
      true,
      logMudo,
    );

    // O descarte continua sendo o descarte: job encerrado, motivo técnico na fila.
    expect(
      value(
        `select count(*) from public.job_queue where id='${job.id}' and status='failed'
          and last_error='service_boundary_stale' and locked_by is null;`,
      ),
    ).toBe(1);

    // UM aviso, do kind novo, aberto e apontando para a conversa (destino clicável).
    expect(avisos()).toBe(1);
    expect(
      value(
        `select count(*) from public.agent_inbox_items
          where organization_id='${ORG}' and kind='followup_descartado' and status='open'
            and ref_kind='conversation' and ref_id='${CONVERSATION}';`,
      ),
    ).toBe(1);

    // A frase é de gente: contato, negócio, horário combinado — e NENHUM código
    // de erro. Quem abre a Central precisa saber o que o cliente deixa de receber.
    const titulo = texto(
      `select title from public.agent_inbox_items where organization_id='${ORG}' and kind='followup_descartado';`,
    );
    const corpo = texto(
      `select replace(body, E'\\n', ' ') from public.agent_inbox_items where organization_id='${ORG}' and kind='followup_descartado';`,
    );
    expect(titulo).toContain("Marina Prado");
    expect(corpo).toContain("Marina Prado");
    expect(corpo).toContain("Reforma da cozinha");
    expect(corpo).toContain("14/11 às 15:00");
    expect(corpo.toLowerCase()).toContain("mudou antes do horário combinado");
    for (const jargao of ["service_boundary_stale", "boundary", "stale", "job", "failed"]) {
      expect(corpo.toLowerCase(), `o corpo do aviso vazou o código/tema "${jargao}"`).not.toContain(
        jargao,
      );
    }
  });

  it("(b) dois descartes do mesmo contato no mesmo dia não viram duas notificações", async () => {
    seedJob();
    await descartarFollowupObsoleto(pool, await jobAtual(), "worker-turno", logMudo);

    // O mesmo contato, o mesmo dia, o mesmo combinado: o turno é reenfileirado
    // (o job id muda) e descartado de novo pelo mesmo motivo.
    seedJob();
    await descartarFollowupObsoleto(pool, await jobAtual(), "worker-turno", logMudo);

    expect(
      value(
        `select count(*) from public.job_queue where organization_id='${ORG}' and status='failed';`,
      ),
    ).toBe(2);
    expect(avisos()).toBe(1);
  });

  it("(c) descarte por OUTRO motivo não usa este aviso", async () => {
    seedJob();
    const job = await jobAtual();

    // Caminho real: `disporJobAposFalha` decide pelo TIPO do erro. Falha
    // terminal que não é fronteira velha encerra o job com o motivo cru — e
    // não é "o retorno combinado não vai sair", porque o atendimento não mudou.
    await disporJobAposFalha(
      pool,
      job,
      "worker-turno",
      new Error("agent_sem_credencial"),
      true,
      logMudo,
    );

    expect(
      value(
        `select count(*) from public.job_queue where id='${job.id}' and status='failed'
          and last_error='agent_sem_credencial';`,
      ),
    ).toBe(1);
    expect(avisos()).toBe(0);
    expect(linhasDoContato()).toBe(0);
  });

  it("(d) a linha do tempo do contato mostra que o retorno não sai", async () => {
    seedJob();
    await descartarFollowupObsoleto(pool, await jobAtual(), "worker-turno", logMudo);

    expect(linhasDoContato()).toBe(1);
    // Roteada para o NEGÓCIO do contato: é a rota da ficha
    // (`GET /api/v1/contacts/[id]/timeline` soma `contact_id` e os negócios dele).
    expect(
      value(
        `select count(*) from public.crm_lead_activities
          where organization_id='${ORG}' and contact_id='${CONTACT}' and type='followup_discarded'
            and lead_id='${LEAD}';`,
      ),
    ).toBe(1);
    const motivo = texto(
      `select reason from public.crm_lead_activities
        where organization_id='${ORG}' and contact_id='${CONTACT}' and type='followup_discarded';`,
    );
    expect(motivo).toContain("não será enviado");
    expect(motivo).toContain("14/11 às 15:00");
    expect(motivo.toLowerCase()).not.toContain("service_boundary_stale");
  });

  it("(e) followup que dispara normalmente não gera aviso (controle)", async () => {
    seedJob();
    const job = await jobAtual();

    // O caminho feliz do mesmo job: `completeJob` fecha o turno entregue.
    await completeJob(pool, job.id, "worker-turno", undefined, job.claim_acquired_at);

    expect(
      value(`select count(*) from public.job_queue where id='${job.id}' and status='done';`),
    ).toBe(1);
    expect(avisos()).toBe(0);
    expect(linhasDoContato()).toBe(0);
  });
});
