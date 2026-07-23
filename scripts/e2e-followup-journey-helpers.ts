/**
 * Helpers de SQL cru pro E2E de jornada completa (Task 8.3):
 * `tests/e2e/followup-journey.spec.ts`. Cobre as 3 coisas que a API pública
 * genuinamente não expõe (confirmado por leitura das rotas antes de escrever
 * este script, mesma doutrina de scripts/seed-e2e-followup-promise.ts):
 *
 *   1. Fast-forward de `next_eval_at` — não dá pra dormir 5min/15min reais
 *      por chamada de tick; a spec pula o relógio via UPDATE direto.
 *   2. Simular uma resposta inbound sem WAHA real — insere `messages` +
 *      atualiza `conversations.last_inbound_at` + emite `message.received`
 *      via `emit_event()` (a MESMA função que `lib/waha/ingest.ts` chama no
 *      webhook real), pra `lib/followup/reactivity.ts` acordar o enrollment
 *      `waiting_reply` do jeito real (drenado por
 *      `POST /api/v1/cron/event-log-drain`, não simulado na mão).
 *   3. Injetar a DECISÃO do LLM em `completeTurnForEnrollment`
 *      (`lib/followup/turn-bridge.ts`) — o seam explícito documentado no
 *      brief da 8.3: model ids do gateway de dev são fictícios, então a spec
 *      NÃO roda um agente de IA real; ela chama a MESMA função que o worker
 *      24/7 chamaria depois de uma chamada de LLM real, com um resultado
 *      CONTROLADO. Tudo o resto (build/publish/link na UI, engine avançando
 *      nó a nó via `runFollowupTick`, roteamento de aresta, fila) é real.
 *
 * Conecta em Postgres DIRETO via `SUPABASE_DB_URL` (mesmo padrão de
 * `lib/agent-engine/db/pool.ts` / `scripts/flywheel-judge-live.ts`) — não
 * usa o client service-role supabase-js porque `createPgAdminClient`
 * (turn-bridge.ts) só existe em sabor `pg.Pool` (é o adapter que o worker
 * 24/7 usa em produção; não existe adapter Supabase equivalente ainda).
 *
 * CLI de subcomandos, 1 processo por chamada (mesmo padrão de
 * execFileSync(["npx","tsx",...]) já usado pelos outros specs) — cada
 * subcomando imprime 1 linha de JSON em stdout que a spec faz JSON.parse.
 *
 * Run: npx tsx scripts/e2e-followup-journey-helpers.ts <comando> [args...]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { createPgAdminClient, completeTurnForEnrollment, type TurnResult } from "@/lib/followup/turn-bridge";

const envFile = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
const env: Record<string, string> = {};
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
}

const DB_URL = env.SUPABASE_DB_URL;
if (!DB_URL) throw new Error("Missing SUPABASE_DB_URL in .env.local");

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  org_id: string;
  followup_agent_fixtures?: { credential_id: string; channel_session_id: string };
}

function loadCreds(): Creds {
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

function out(value: unknown): void {
  console.log(JSON.stringify(value));
}

async function main(): Promise<void> {
  const [, , cmd, ...args] = process.argv;
  const pool = new pg.Pool({ connectionString: DB_URL, max: 2 });

  try {
    switch (cmd) {
      // ---- prepara os fixtures de agente pra PUBLICAR (não só salvar draft)
      // ---- — a credential nasce sem validated_at e a sessão nasce 'STARTING'
      // ---- (seed-e2e-followup-agent.ts, Task 7.2 — não precisava publicar).
      case "prepare-agent-fixtures": {
        const creds = loadCreds();
        const fixtures = creds.followup_agent_fixtures;
        if (!fixtures) throw new Error("followup_agent_fixtures ausente em .e2e-creds.json — rode seed-e2e-followup-agent.ts antes");
        await pool.query(`update ai_provider_credentials set validated_at = now() where id = $1`, [
          fixtures.credential_id,
        ]);
        await pool.query(`update channel_sessions set status = 'WORKING' where id = $1`, [
          fixtures.channel_session_id,
        ]);
        out({ ok: true });
        break;
      }

      // ---- seed-silent-contact <thresholdMinutes> <tag> — contato novo +
      // ---- conversa cujo last_inbound_at já é mais velho que o threshold do
      // ---- gatilho de silêncio (reusa o channel_session dos fixtures do
      // ---- agente — não precisa de um 2º canal só pra isto).
      case "seed-silent-contact": {
        const thresholdMinutes = Number(args[0]);
        const tag = args[1] ?? "journey";
        if (!Number.isFinite(thresholdMinutes)) throw new Error("thresholdMinutes inválido");
        const creds = loadCreds();
        const fixtures = creds.followup_agent_fixtures;
        if (!fixtures) throw new Error("followup_agent_fixtures ausente em .e2e-creds.json");

        const contactName = `Cliente Silêncio E2E ${tag} ${Date.now()}`;
        const { rows: contactRows } = await pool.query<{ id: string }>(
          `insert into contacts (organization_id, display_name) values ($1, $2) returning id`,
          [creds.org_id, contactName],
        );
        const contactId = contactRows[0]!.id;

        const lastInboundAt = new Date(Date.now() - (thresholdMinutes + 5) * 60_000).toISOString();
        const { rows: convRows } = await pool.query<{ id: string }>(
          `insert into conversations (organization_id, contact_id, channel_session_id, status, last_inbound_at, last_message_at, last_message_preview)
           values ($1, $2, $3, 'open', $4, $4, 'Oi, tudo bem?')
           returning id`,
          [creds.org_id, contactId, fixtures.channel_session_id, lastInboundAt],
        );
        const conversationId = convRows[0]!.id;

        out({ contactId, contactName, conversationId, channelSessionId: fixtures.channel_session_id });
        break;
      }

      // ---- fast-forward-enrollment <enrollmentId> — pula o relógio: o
      // ---- próximo tick vai encontrar o enrollment devido, sem dormir
      // ---- os 5min/15min reais do wait/grace.
      case "fast-forward-enrollment": {
        const enrollmentId = args[0];
        if (!enrollmentId) throw new Error("enrollmentId obrigatório");
        const { rows } = await pool.query(
          `update followup_enrollments set next_eval_at = now() - interval '1 second', claimed_until = null
           where id = $1 returning id, current_node_id, status, next_eval_at`,
          [enrollmentId],
        );
        out(rows[0] ?? null);
        break;
      }

      case "get-enrollment": {
        const enrollmentId = args[0];
        if (!enrollmentId) throw new Error("enrollmentId obrigatório");
        const { rows } = await pool.query(`select * from followup_enrollments where id = $1`, [enrollmentId]);
        out(rows[0] ?? null);
        break;
      }

      // ---- find-enrollment <orgId> <pointerId> <contactId> — usado logo
      // ---- após a varredura de silêncio pra descobrir o id que ela criou
      // ---- (a API de sweep não devolve id nenhum — é um cron fire-and-forget).
      case "find-enrollment": {
        const [orgId, pointerId, contactId] = args;
        if (!orgId || !pointerId || !contactId) throw new Error("orgId, pointerId, contactId obrigatórios");
        const { rows } = await pool.query(
          `select * from followup_enrollments
           where organization_id = $1 and pointer_id = $2 and contact_id = $3
           order by started_at desc limit 1`,
          [orgId, pointerId, contactId],
        );
        out(rows[0] ?? null);
        break;
      }

      // ---- find-job <contactId> <purpose> — última linha de job_queue
      // ---- (kind='followup_turn') que o engine REALMENTE enfileirou pro
      // ---- nó action/ai_classify — prova que o enqueue aconteceu de verdade,
      // ---- não só que o enrollment avançou.
      case "find-job": {
        const [contactId, purpose] = args;
        if (!contactId || !purpose) throw new Error("contactId, purpose obrigatórios");
        const { rows } = await pool.query(
          `select id, kind, status, payload from job_queue
           where contact_id = $1 and kind = 'followup_turn' and payload->>'purpose' = $2
           order by created_at desc limit 1`,
          [contactId, purpose],
        );
        out(rows[0] ?? null);
        break;
      }

      // ---- simulate-inbound <orgId> <conversationId> <contactId> <channelSessionId> <body>
      // ---- — insere a mensagem inbound + atualiza a conversa + emite
      // ---- message.received via emit_event() (mesma função que o webhook
      // ---- real da WAHA chama em lib/waha/ingest.ts) pra
      // ---- lib/followup/reactivity.ts acordar o enrollment waiting_reply
      // ---- quando o event-log-drain drenar esta linha.
      case "simulate-inbound": {
        const [orgId, conversationId, contactId, channelSessionId, body] = args;
        if (!orgId || !conversationId || !contactId || !channelSessionId || !body) {
          throw new Error("orgId, conversationId, contactId, channelSessionId, body obrigatórios");
        }
        const { rows: msgRows } = await pool.query<{ id: string }>(
          `insert into messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, body)
           values ($1, $2, $3, $4, 'text', 'inbound', 'received', $5)
           returning id`,
          [orgId, conversationId, channelSessionId, contactId, body],
        );
        const messageId = msgRows[0]!.id;

        await pool.query(
          `update conversations set last_inbound_at = now(), last_message_at = now(), last_message_preview = $2
           where id = $1`,
          [conversationId, body.slice(0, 280)],
        );

        const { rows: eventRows } = await pool.query<{ emit_event: string }>(
          `select emit_event($1, 'message', $2, $3::jsonb, '{}'::jsonb, $4) as emit_event`,
          [
            "message.received",
            messageId,
            JSON.stringify({ conversation_id: conversationId, contact_id: contactId, channel_session_id: channelSessionId, body_preview: body.slice(0, 280) }),
            orgId,
          ],
        );

        out({ messageId, eventId: eventRows[0]!.emit_event });
        break;
      }

      // ---- complete-turn <orgId> <enrollmentId> <nodeId> <resultJson> — o
      // ---- SEAM: injeta a decisão do LLM (send/classify) via a MESMA
      // ---- completeTurnForEnrollment que o worker 24/7 chamaria depois de
      // ---- uma chamada real de modelo — ver header do arquivo.
      case "complete-turn": {
        const [orgId, enrollmentId, nodeId, resultJson] = args;
        if (!orgId || !enrollmentId || !nodeId || !resultJson) {
          throw new Error("orgId, enrollmentId, nodeId, resultJson obrigatórios");
        }
        const result = JSON.parse(resultJson) as TurnResult;
        const db = createPgAdminClient(pool);
        await completeTurnForEnrollment(db, orgId, enrollmentId, nodeId, result);
        out({ ok: true });
        break;
      }

      // ---- list-events <enrollmentId> — event_type em ordem, prova que os
      // ---- passos (action_sent, ai_classified, ...) realmente aconteceram.
      case "list-events": {
        const enrollmentId = args[0];
        if (!enrollmentId) throw new Error("enrollmentId obrigatório");
        const { rows } = await pool.query<{ event_type: string }>(
          `select event_type from followup_enrollment_events where enrollment_id = $1 order by created_at`,
          [enrollmentId],
        );
        out(rows.map((r) => r.event_type));
        break;
      }

      // ---- cleanup-flow-enrollments <pointerId> — apaga TODOS os enrollments
      // ---- de um pointer, não só o do contato desta run. O gatilho de
      // ---- silêncio é cross-contato de propósito (varre a org inteira) — um
      // ---- fluxo de teste que fica 'active' entre ticks pode enrollar
      // ---- QUALQUER contato silencioso real da org de dev, não só o que
      // ---- esta run semeou. Chamado ANTES de desativar o pointer (a
      // ---- desativação já impede NOVOS enrollments; isto limpa os que já
      // ---- foram criados nos ticks intermediários).
      case "cleanup-flow-enrollments": {
        const pointerId = args[0];
        if (!pointerId) throw new Error("pointerId obrigatório");
        await pool.query(
          `delete from followup_enrollment_events where enrollment_id in (select id from followup_enrollments where pointer_id = $1)`,
          [pointerId],
        );
        const { rowCount } = await pool.query(`delete from followup_enrollments where pointer_id = $1`, [pointerId]);
        out({ ok: true, deleted: rowCount });
        break;
      }

      // ---- cleanup-contact <contactId> — apaga o que a jornada semeou
      // ---- (mensagens → eventos de enrollment → enrollments → conversas →
      // ---- contato, na ordem que respeita as FKs RESTRICT/CASCADE do
      // ---- baseline) — não deixa lixo acumulando no dev DB compartilhado.
      case "cleanup-contact": {
        const contactId = args[0];
        if (!contactId) throw new Error("contactId obrigatório");
        await pool.query(
          `delete from messages where conversation_id in (select id from conversations where contact_id = $1)`,
          [contactId],
        );
        await pool.query(
          `delete from followup_enrollment_events where enrollment_id in (select id from followup_enrollments where contact_id = $1)`,
          [contactId],
        );
        await pool.query(`delete from followup_enrollments where contact_id = $1`, [contactId]);
        await pool.query(`delete from conversations where contact_id = $1`, [contactId]);
        await pool.query(`delete from contacts where id = $1`, [contactId]);
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
  console.error("❌ e2e-followup-journey-helpers falhou:", err instanceof Error ? err.message : err);
  process.exit(1);
});
