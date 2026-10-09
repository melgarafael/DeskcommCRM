/**
 * Pessoa no comando na hora do TURNO do fluxo — a política de handoff aplicada
 * também quando ninguém emitiu `ai.handoff_triggered`.
 *
 * A política do fluxo (`followup_flow_pointers.handoff_policy`) pausa ou cancela
 * a inscrição quando o handoff ABRE, mas reage ao EVENTO (`reactivity.ts`). Uma
 * conversa assumida à mão ("Assumir" na tela, o claim de um caso) não emite
 * esse evento, e o passo do fluxo chegava ao envio com uma pessoa no comando.
 *
 * "Pessoa no comando" é a MESMA régua que barra o envio: `isLeadInHandoff`
 * (contato em `force_human` ou IA silenciada agora). Assumir, atribuir e
 * transferir gravam silêncio `infinity`; a atribuição pelo rodízio
 * (`p_reason = 'routing'`) não cala a IA e por isso não conta aqui.
 *
 * `pause` ADIA o passo, e não grava `paused_handoff`. Esta checagem é uma
 * fotografia, e `paused_handoff` só sai por `ai.handoff_resolved`, que só o
 * "Devolver ao automático", a tool e o cron de devolução emitem. Liberar a
 * conversa, o silêncio de 5 min da resposta pela tela vencendo sozinho e o fim
 * de uma pausa de chamada devolvem o comando à IA sem esse evento: a inscrição
 * ficaria pausada para sempre, segurando `idx_followup_enrollments_one_live`.
 * Adiar é o `deferred` que a janela de envio já usa: o turno volta quando o
 * silêncio vence, ou em `ACTION_RECHECK_MAX_MS` quando a trava não tem fim, e
 * confere de novo. Cada adiamento é prova de vida para o dead-man.
 *
 * `cancel` termina a inscrição: estado final, não precisa de quem o retome.
 */
import type pg from 'pg';

import { isLeadInHandoff } from '@/lib/agent-engine/agent/human-handoff';
import { ACTION_RECHECK_MAX_MS } from './node-handlers';

export type DesfechoDaPessoaNoComando = { kind: 'adiada'; ate: Date } | { kind: 'cancelada' } | null;

export async function aplicarPessoaNoComandoAoTurno(
  pool: pg.Pool,
  alvo: {
    organizationId: string;
    enrollmentId: string;
    nodeId: string;
    contactId: string;
  },
  agora: Date,
): Promise<DesfechoDaPessoaNoComando> {
  if (!(await isLeadInHandoff(pool, alvo.organizationId, alvo.contactId))) return null;

  const { rows } = await pool.query<{
    status: string;
    current_node_id: string;
    steps_taken: number;
    handoff_policy: string | null;
    fim_do_silencio_ms: number | null;
  }>(
    `select e.status, e.current_node_id, e.steps_taken, p.handoff_policy,
            (select (extract(epoch from max(v.bot_silenced_until)) * 1000)::float8 from conversations v
              where v.organization_id = e.organization_id and v.contact_id = e.contact_id
                and v.bot_silenced_until is not null and v.bot_silenced_until <> 'infinity') as fim_do_silencio_ms
       from followup_enrollments e
       join followup_flow_pointers p on p.id = e.pointer_id and p.organization_id = e.organization_id
      where e.organization_id = $1 and e.id = $2`,
    [alvo.organizationId, alvo.enrollmentId],
  );
  const linha = rows[0];
  if (!linha) return null;
  if (linha.current_node_id !== alvo.nodeId) return null;
  if (linha.status !== 'active' && linha.status !== 'waiting_reply') return null;
  // Ausente vale `pause`, o default da coluna — a mesma leitura da varredura.
  const politica = linha.handoff_policy === 'allow' || linha.handoff_policy === 'cancel' ? linha.handoff_policy : 'pause';
  if (politica === 'allow') return null;

  if (politica === 'pause') {
    const teto = agora.getTime() + ACTION_RECHECK_MAX_MS;
    // Silêncio sem fim (`infinity`), já vencido ou ausente (a trava é `force_human`): confere de novo no teto.
    const fim = linha.fim_do_silencio_ms ?? teto;
    return { kind: 'adiada', ate: new Date(fim > agora.getTime() ? Math.min(fim, teto) : teto) };
  }

  // O evento e a mudança de estado andam juntos: sem o evento (já aplicado
  // nesta ocupação do nó), nada muda — mesma idempotência de `applyStep`.
  const { rowCount } = await pool.query(
    `with ev as (
       insert into followup_enrollment_events
         (organization_id, enrollment_id, node_id, event_type, payload, idempotency_key)
       values ($1, $2, $3, 'reactivity_handoff_cancel', '{"reason":"pessoa_no_comando"}'::jsonb, $4)
       on conflict (enrollment_id, idempotency_key) where idempotency_key is not null do nothing
       returning 1
     )
     update followup_enrollments
        set status = 'cancelled',
            outcome = 'handoff',
            cancel_reason = 'pessoa_no_comando',
            completed_at = $5::timestamptz,
            next_eval_at = null,
            claimed_until = null,
            updated_at = $5::timestamptz
      where organization_id = $1 and id = $2 and status in ('active', 'waiting_reply')
        and exists (select 1 from ev)`,
    [
      alvo.organizationId,
      alvo.enrollmentId,
      linha.current_node_id,
      `pessoa_no_comando:${linha.current_node_id}:${linha.steps_taken}`,
      agora.toISOString(),
    ],
  );
  return rowCount ? { kind: 'cancelada' } : null;
}
