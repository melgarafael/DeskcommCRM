/**
 * Helpers de SQL cru para os E2E do GATE DE ELEGIBILIDADE DA IA (J20):
 *
 *   tests/e2e/j20-elegibilidade-respondi.spec.ts          (J20.6)
 *   tests/e2e/j20-elegibilidade-followup.spec.ts          (J20.12)
 *   tests/e2e/j20-elegibilidade-atendimento-manual.spec.ts (J20.18)
 *
 * Mesma doutrina de `scripts/e2e-followup-journey-helpers.ts`: cobre só o que a
 * API pública genuinamente não expõe. Aqui são três coisas:
 *
 *   1. Rodar UM tick do drain do agent-engine
 *      (`lib/agent-engine/edge/crm/drain.ts`, `drainTick`) — o consumidor de
 *      `ai_agent.dispatch_requested` que carrega o gate. Em produção ele roda
 *      no `workers/agent-worker` (processo 24/7); a suíte E2E não sobe worker,
 *      então o tick é chamado aqui, pela MESMA função, contra `SUPABASE_DB_URL`.
 *   2. Ler `job_queue` / `event_log` / `contacts` / `conversations` /
 *      `followup_enrollments` direto — a prova de "a IA foi (ou não) liberada"
 *      é uma linha de fila que nasceu (ou um evento que virou `done` sem job),
 *      e nada disso tem rota REST.
 *   3. Semear com precisão os dois estados de partida que o gate distingue:
 *      contato AUTORIZADO (origem elegível carimbou `contacts.ai_authorized_at`)
 *      e contato NÃO autorizado — sem depender de rodar o webhook do Respondi
 *      quando o caso sob teste é outro (J20.12 e J20.18).
 *
 * Conecta em Postgres DIRETO via `SUPABASE_DB_URL` (mesmo padrão de
 * `lib/agent-engine/db/pool.ts` e de `e2e-followup-journey-helpers.ts`) — o
 * `drainTick` só existe em sabor `pg.Pool`.
 *
 * CLI de subcomandos, 1 processo por chamada: cada subcomando imprime 1 linha
 * de JSON em stdout que a spec faz `JSON.parse`.
 *
 * Run: npx tsx scripts/e2e-elegibilidade-helpers.ts <comando> [args...]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { drainTick } from "@/lib/agent-engine/edge/crm/drain";
import { createLogger } from "@/lib/agent-engine/obs/logger";
import { carregarEnvLocal } from "../scripts/lib/env-de-teste";

const env = carregarEnvLocal();

const DB_URL = env.SUPABASE_DB_URL;
if (!DB_URL) throw new Error("Falta SUPABASE_DB_URL no ambiente (.env.e2e / .env.local)");

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  org_id: string;
  elegibilidade?: {
    channel_session_id: string;
    waha_path_token: string;
    credential_id: string;
    pipeline_id: string;
    stage_id: string;
    webhook_source_id: string;
    webhook_source_token: string;
  };
}

function loadCreds(): Creds {
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

function out(value: unknown): void {
  console.info(JSON.stringify(value));
}

/** E.164 único por chamada — `contacts_phone_e164_format` exige `^\+\d{8,15}$`. */
function telefoneUnico(): string {
  return `+55119${String(Date.now()).slice(-8)}`;
}

async function main(): Promise<void> {
  const [, , cmd, ...args] = process.argv;
  const pool = new pg.Pool({ connectionString: DB_URL, max: 3 });

  try {
    switch (cmd) {
      // ── drain-once ──────────────────────────────────────────────────────────
      // UM tick do drain do agent-engine (consumidor de
      // `ai_agent.dispatch_requested`). `debounceMs: 0` para o job de turno,
      // quando criado, nascer sem `run_after` no futuro — a spec o vê já.
      case "drain-once": {
        const log = createLogger();
        const drained = await drainTick(pool, {
          batchSize: 50,
          intervalMs: 1_000,
          idleIntervalMs: 5_000,
          debounceMs: 0,
          reapTimeoutMs: 60_000,
        }, log);
        out({ drained });
        break;
      }

      // ── job-inbound-turn <contactId> ────────────────────────────────────────
      // A linha de `job_queue` que PROVA que o drain liberou a IA para o turno.
      // `null` = nenhum job (a IA NÃO foi liberada).
      case "job-inbound-turn": {
        const contactId = args[0];
        if (!contactId) throw new Error("contactId obrigatório");
        const { rows } = await pool.query(
          `select id, kind, status, source_event_id
             from job_queue
            where contact_id = $1 and kind = 'inbound_turn'
            order by created_at desc limit 1`,
          [contactId],
        );
        out(rows[0] ?? null);
        break;
      }

      // ── dispatch-event <contactId> ─────────────────────────────────────────
      // O estado do `ai_agent.dispatch_requested` deste contato após o drain:
      // `done` sem job = o gate barrou (turno pulado, sem gasto).
      case "dispatch-event": {
        const contactId = args[0];
        if (!contactId) throw new Error("contactId obrigatório");
        const { rows } = await pool.query(
          `select e.id, e.status
             from event_log e
            where e.event_type = 'ai_agent.dispatch_requested'
              and e.payload->>'contact_id' = $1
            order by e.created_at desc limit 1`,
          [contactId],
        );
        out(rows[0] ?? null);
        break;
      }

      // ── set-authorized <contactId> [reason] ──────────────────────────────
      // Carimba `contacts.ai_authorized_at = now()` como uma origem elegível
      // faria (J20.18 quer partir de uma conversa JÁ autorizada). Não passa
      // pelo webhook do Respondi de propósito — o caso sob teste é outro.
      case "set-authorized": {
        const contactId = args[0];
        const reason = args[1] ?? "respondi:e2e-form:e2e-sub";
        if (!contactId) throw new Error("contactId obrigatório");
        const { rowCount } = await pool.query(
          `update contacts set ai_authorized_at = now(), ai_authorized_reason = $2 where id = $1`,
          [contactId, reason],
        );
        out({ ok: rowCount === 1 });
        break;
      }

      // ── conversation-for-contact <contactId> ─────────────────────────────
      case "conversation-for-contact": {
        const contactId = args[0];
        if (!contactId) throw new Error("contactId obrigatório");
        const { rows } = await pool.query(
          `select id, status, bot_silenced_until::text as bot_silenced_until
             from conversations where contact_id = $1
            order by created_at desc limit 1`,
          [contactId],
        );
        out(rows[0] ?? null);
        break;
      }

      // ── contact-authorization <contactId> ─────────────────────────────────
      case "contact-authorization": {
        const contactId = args[0];
        if (!contactId) throw new Error("contactId obrigatório");
        const { rows } = await pool.query(
          `select id, ai_authorized_at, ai_authorized_reason from contacts where id = $1`,
          [contactId],
        );
        out(rows[0] ?? null);
        break;
      }

      // ── conversation-silence <conversationId> ─────────────────────────────
      // O valor CRU de `bot_silenced_until` (`infinity` é literal, não data) +
      // o rastro de handoff.
      case "conversation-silence": {
        const conversationId = args[0];
        if (!conversationId) throw new Error("conversationId obrigatório");
        const { rows } = await pool.query(
          `select id, bot_silenced_until::text as bot_silenced_until,
                  last_handoff_at::text as last_handoff_at, last_handoff_reason
             from conversations where id = $1`,
          [conversationId],
        );
        out(rows[0] ?? null);
        break;
      }

      // ── find-contact-by-phone <phoneDigits> ───────────────────────────────
      // O contato que o webhook do Respondi criou (a spec passa os dígitos que
      // mandou no payload). `phone_number` é normalizado para E.164 na ingestão.
      case "find-contact-by-phone": {
        const digits = (args[0] ?? "").replace(/\D/g, "");
        if (digits.length < 8) throw new Error("phoneDigits inválido");
        const creds = loadCreds();
        const { rows } = await pool.query(
          `select id, phone_number, ai_authorized_at, ai_authorized_reason
             from contacts
            where organization_id = $1
              and regexp_replace(coalesce(phone_number, ''), '\\D', '', 'g') like '%' || $2
            order by created_at desc limit 1`,
          [creds.org_id, digits],
        );
        out(rows[0] ?? null);
        break;
      }

      // ── seed-silent-contact <autorizado:0|1> <thresholdMinutes> ───────────
      // Igual a seed-conversa mas com `last_inbound_at` mais VELHO que o
      // threshold do gatilho de silêncio — o estado que a varredura de
      // follow-up procura. (J20.12.)
      case "seed-silent-contact": {
        const autorizado = args[0] === "1";
        const thresholdMinutes = Number(args[1] ?? "5");
        if (!Number.isFinite(thresholdMinutes)) throw new Error("thresholdMinutes inválido");
        const creds = loadCreds();
        const fix = creds.elegibilidade;
        if (!fix) throw new Error("bloco `elegibilidade` ausente — rode scripts/seed-e2e-elegibilidade.ts");

        const phone = telefoneUnico();
        const nome = `Silêncio Elegibilidade ${autorizado ? "autorizado" : "sem-autorizacao"} ${Date.now()}`;
        const { rows: cRows } = await pool.query<{ id: string }>(
          `insert into contacts (organization_id, display_name, phone_number${autorizado ? ", ai_authorized_at, ai_authorized_reason" : ""})
           values ($1, $2, $3${autorizado ? ", now(), 'respondi:e2e-form:e2e-sub'" : ""})
           returning id`,
          [creds.org_id, nome, phone],
        );
        const contactId = cRows[0]!.id;
        const velho = new Date(Date.now() - (thresholdMinutes + 5) * 60_000).toISOString();
        const { rows: convRows } = await pool.query<{ id: string }>(
          `insert into conversations
             (organization_id, contact_id, channel_session_id, status,
              last_message_preview, last_message_at, last_inbound_at)
           values ($1, $2, $3, 'open', 'Oi, tudo bem?', $4, $4)
           returning id`,
          [creds.org_id, contactId, fix.channel_session_id, velho],
        );
        out({ contactId, conversationId: convRows[0]!.id, phone });
        break;
      }

      // ── enrollment-for-contact <contactId> ────────────────────────────────
      // A linha de `followup_enrollments` (ou `null`). J20.12: o autorizado TEM,
      // o não autorizado NÃO.
      case "enrollment-for-contact": {
        const contactId = args[0];
        if (!contactId) throw new Error("contactId obrigatório");
        const { rows } = await pool.query(
          `select id, pointer_id, status, current_node_id
             from followup_enrollments where contact_id = $1
            order by started_at desc limit 1`,
          [contactId],
        );
        out(rows[0] ?? null);
        break;
      }

      // ── cleanup-contact <contactId> ──────────────────────────────────────
      // Ordem que respeita as FKs do baseline. Não deixa lixo no dev DB
      // compartilhado.
      case "cleanup-contact": {
        const contactId = args[0];
        if (!contactId) throw new Error("contactId obrigatório");
        await pool.query(
          `delete from job_queue where contact_id = $1`,
          [contactId],
        );
        await pool.query(
          `delete from followup_enrollment_events where enrollment_id in
             (select id from followup_enrollments where contact_id = $1)`,
          [contactId],
        );
        await pool.query(`delete from followup_enrollments where contact_id = $1`, [contactId]);
        await pool.query(
          `delete from messages where conversation_id in
             (select id from conversations where contact_id = $1)`,
          [contactId],
        );
        await pool.query(
          `delete from event_log where payload->>'contact_id' = $1`,
          [contactId],
        );
        await pool.query(`delete from conversations where contact_id = $1`, [contactId]);
        // Um lead pode ter nascido pelo webhook do Respondi (J20.6). Timeline
        // (`crm_lead_activities`) sai no cascade do lead.
        await pool.query(`delete from crm_leads where contact_id = $1`, [contactId]);
        await pool.query(`delete from contacts where id = $1`, [contactId]);
        out({ ok: true });
        break;
      }

      // ── cleanup-flow <pointerId> ─────────────────────────────────────────
      // Desativa o pointer e apaga os enrollments que ticks intermediários
      // possam ter criado (a varredura de silêncio é cross-contato — pode ter
      // pego contato silencioso real do dev DB). Mesmo cuidado de
      // e2e-followup-journey-helpers.
      case "cleanup-flow": {
        const pointerId = args[0];
        if (!pointerId) throw new Error("pointerId obrigatório");
        await pool.query(
          `update followup_flow_pointers set status = 'disabled' where id = $1`,
          [pointerId],
        );
        await pool.query(
          `delete from followup_enrollment_events where enrollment_id in
             (select id from followup_enrollments where pointer_id = $1)`,
          [pointerId],
        );
        const { rowCount } = await pool.query(
          `delete from followup_enrollments where pointer_id = $1`,
          [pointerId],
        );
        out({ ok: true, enrollmentsRemovidos: rowCount });
        break;
      }

      // ── publish-agent [pointerId] ───────────────────────────────────────
      // Insere `ai_agents` (mcp_agent) + `ai_agent_versions` PUBLICADA, ligada
      // ao canal do gate. É SETUP, não o que está sob teste: o `POST
      // /api/v1/ai/agents` exige role `admin` (MFA), e o agente publicado só
      // precisa EXISTIR para o drain não pular por "nenhum agente publicado" e
      // para o gate de follow-up abrir. Idempotente por (org, name).
      //   - sem pointerId: `followup` fica desligado (J20.6)
      //   - com pointerId: `followup = {enabled:true, flow_pointer_ids:[id]}` (J20.12)
      //
      // O NOME depende de ter pointerId: as specs J20 rodam em paralelo contra o
      // mesmo banco e o `followup` é coluna compartilhada — se J20.6 e J20.12
      // dividissem a linha, o publish-agent de um sobrescreveria o `followup` do
      // outro (J20.12 quer `enabled:true`; J20.6, `false`). Agentes separados não
      // colidem, e `resolveAgentForAutomaticTrigger` do sweep escolhe justamente
      // o que ARMA o pointer, então o agente "sem followup" nunca é candidato.
      case "publish-agent": {
        const pointerId = args[0] ?? null;
        const creds = loadCreds();
        const fix = creds.elegibilidade;
        if (!fix) throw new Error("bloco `elegibilidade` ausente — rode scripts/seed-e2e-elegibilidade.ts");
        const nome = pointerId
          ? "E2E Elegibilidade — agente publicado (followup)"
          : "E2E Elegibilidade — agente publicado";
        const followup = pointerId
          ? JSON.stringify({ enabled: true, flow_pointer_ids: [pointerId] })
          : JSON.stringify({ enabled: false, flow_pointer_ids: [] });

        const cli = await pool.connect();
        try {
          await cli.query("begin");
          // As specs J20 rodam em paralelo contra o MESMO banco e mais de uma
          // chama `publish-agent` para o MESMO agente (mesmo `name`). Sem
          // serializar, dois workers leem `published_version_id` nulo ao mesmo
          // tempo, os dois entram no ramo de INSERT e o segundo colide (ou pior:
          // um deles tenta reescrever coluna vetada de uma versão que o outro
          // acabou de publicar → `trg_ai_agent_versions_content_immutable`).
          // O advisory lock de transação faz a segunda chamada esperar a
          // primeira COMMITAR e então enxergar o estado final.
          await cli.query("select pg_advisory_xact_lock(hashtext($1))", [`publish-agent:${creds.org_id}:${nome}`]);

          const { rows: aRows } = await cli.query<{ id: string; published_version_id: string | null }>(
            `insert into ai_agents (organization_id, name, system_prompt, kind, archived_at)
             values ($1, $2, 'Agente de teste E2E do gate de elegibilidade.', 'mcp_agent', null)
             on conflict (organization_id, name) do update set archived_at = null, kind = 'mcp_agent'
             returning id, published_version_id`,
            [creds.org_id, nome],
          );
          const agentId = aRows[0]!.id;

          // Uma versão publicada cujo canal/credencial JÁ batem com a fixture
          // serve os três casos — só o `followup` (coluna FORA do trigger de
          // imutabilidade) precisa acompanhar o `pointerId`. Procuramos por
          // conteúdo, não pelo ponteiro: o ponteiro pode estar atrás de um
          // INSERT concorrente que ainda não o moveu.
          const { rows: pub } = await cli.query<{ id: string }>(
            `select id from ai_agent_versions
              where agent_id = $1 and status = 'published'
                and channel_session_id = $2 and credential_id = $3
              order by version_number desc limit 1`,
            [agentId, fix.channel_session_id, fix.credential_id],
          );

          let versionId: string;
          if (pub[0]) {
            versionId = pub[0].id;
            await cli.query(
              `update ai_agent_versions set followup = $2::jsonb, published_at = now() where id = $1`,
              [versionId, followup],
            );
          } else {
            // Nenhuma versão publicada com o conteúdo certo. Um draft existente
            // pode ser promovido (o trigger só veta UPDATE de linha NÃO-draft);
            // senão, versão nova. Em ambos os casos, um número maior que o atual.
            const { rows: dr } = await cli.query<{ id: string }>(
              `select id from ai_agent_versions where agent_id = $1 and status = 'draft'
                order by version_number desc limit 1`,
              [agentId],
            );
            if (dr[0]) {
              versionId = dr[0].id;
              await cli.query(
                `update ai_agent_versions
                    set status = 'published', published_at = now(),
                        channel_session_id = $2, credential_id = $3, followup = $4::jsonb
                  where id = $1`,
                [versionId, fix.channel_session_id, fix.credential_id, followup],
              );
            } else {
              const { rows: nv } = await cli.query<{ id: string }>(
                `insert into ai_agent_versions
                   (organization_id, agent_id, version_number, system_prompt, provider, model,
                    credential_id, channel_session_id, status, published_at, followup)
                 values ($1, $2,
                         (select coalesce(max(version_number), 0) + 1 from ai_agent_versions where agent_id = $2),
                         'Agente de teste E2E.', 'anthropic', 'claude-sonnet-4-6',
                         $3, $4, 'published', now(), $5::jsonb)
                 returning id`,
                [creds.org_id, agentId, fix.credential_id, fix.channel_session_id, followup],
              );
              versionId = nv[0]!.id;
            }
          }
          await cli.query(`update ai_agents set published_version_id = $2 where id = $1`, [
            agentId,
            versionId,
          ]);
          await cli.query("commit");
          out({ agentId, versionId });
        } catch (e) {
          await cli.query("rollback").catch(() => {});
          throw e;
        } finally {
          cli.release();
        }
        break;
      }

      // ── archive-agent <agentId> ─────────────────────────────────────────
      // `ai_agents.archived_at` sozinho já tira o agente do `tem_agente` do
      // drain (a query dele filtra `a.archived_at is null`) e do gate de
      // follow-up. Não mexo no `status` da versão — o vocabulário do CHECK
      // varia e não é preciso aqui.
      case "archive-agent": {
        const agentId = args[0];
        if (!agentId) throw new Error("agentId obrigatório");
        await pool.query(`update ai_agents set archived_at = now() where id = $1`, [agentId]);
        out({ ok: true });
        break;
      }

      default:
        throw new Error(`comando desconhecido: ${cmd ?? "(vazio)"}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("❌ e2e-elegibilidade-helpers falhou:", err instanceof Error ? err.message : err);
  process.exit(1);
});
