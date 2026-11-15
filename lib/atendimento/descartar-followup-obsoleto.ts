import type { Pool } from "pg";
import { logger } from "@/lib/logger";
import type { Logger } from "@/lib/agent-engine/obs/logger";
import { claimOfJob } from "@/lib/agent-engine/queue/claim";
import { cancelJob, type JobRow } from "@/lib/agent-engine/queue/queue";
import { registrarRetornoDescartado } from "@/lib/atendimento/aviso-retorno-descartado";

/** Descartar o turno não cancela a inscrição: pause/cancel continuam sendo
 * decisões do fluxo. O rastro permite retomar sem falso worker morto.
 * Só o worker (sem auth.uid de uma sessão) chama esta função.
 *
 * ═══ O DESCAPE É CORRETO; O SILÊNCIO NÃO ERA (#4696) ═══
 *
 * Quando o atendimento muda antes do disparo (`service_boundary_stale` em
 * `assertCurrentServiceBoundary`), mandar a mensagem combinada seria escrever
 * ao cliente em nome de um atendimento que já não existe. A regra de fronteira
 * fica como está. O que faltava era CONTAR: até aqui o job ia para `failed` e
 * nada aparecia na Central nem na ficha do contato — 11 descartes em 17 dias no
 * relato, um deles com o cliente esperando um contato que nunca sairia.
 *
 * Por isso o descarte e o aviso são a MESMA transação: o aviso nasce no commit
 * que encerra o job, e não numa passada posterior que poderia não acontecer (o
 * worker morre entre as duas com a mesma facilidade com que morre antes de
 * qualquer uma). Cada rastro é isolado em savepoint DENTRO de
 * `registrarRetornoDescartado`: aviso que falha não pode derrubar o descarte.
 */
export async function descartarFollowupObsoleto(
  pool: Pool,
  job: JobRow,
  workerId: string,
  log: Pick<Logger, "warn"> = logger,
): Promise<void> {
  const claim = claimOfJob(job);
  if (!claim || job.kind !== "followup_turn") return;
  const tx = await pool.connect();
  try {
    await tx.query("begin");
    const { rows } = await tx.query(
      `select id from job_queue where organization_id=$1 and id=$2
         and kind='followup_turn' and status='running' and locked_by=$3
         and locked_at=$4::timestamptz for update`,
      [job.organization_id, job.id, workerId, claim.acquired_at],
    );
    if (rows.length) {
      await tx.query(
        `select fn_followup_turno_descartado($1,$2) where public.fn_autonomous_turn_revoked($1,$2)`,
        [job.organization_id, job.id],
      );
      const descartado = await cancelJob(tx, job.id, workerId, "service_boundary_stale", claim.acquired_at);
      // O aviso nasce no MESMO commit do descarte. `cancelJob` devolve `null`
      // se o lease mudou entre o `for update` e o update — e aí o descarte não
      // é deste ciclo, então o aviso também não é (o próximo ciclo conta, e o
      // dedup por conversa garante um só).
      if (descartado) {
        const conversa = conversaDoJob(job);
        const contato = job.contact_id;
        if (conversa && contato) {
          const rastro = await registrarRetornoDescartado(
            tx,
            {
              organizationId: job.organization_id,
              contactId: contato,
              conversationId: conversa,
              jobId: job.id,
              combinadoPara: job.run_after ?? null,
            },
            log,
          );
          if (rastro.falhou) {
            // Uma das escritas ESTOUROU (`falhou` é `!aviso.ok || !linha.ok`):
            // o descarte vale, mas o rastro ficou pela metade ou some. O log é a última testemunha — por isso é `warn` e
            // nomeia o job. Aviso deduplicado e ficha sem negócio aberto NÃO
            // entram aqui: são o desfecho normal, não falha.
            log.warn("followup_descartado_sem_rastro", {
              job_id: job.id,
              organization_id: job.organization_id,
              contact_id: job.contact_id,
            });
          }
        }
      }
    } else {
      // Não registra descarte nem altera o lease que já pertence a outro ciclo.
      log.warn("followup_stale_discard_lease_changed", {
        job_id: job.id, organization_id: job.organization_id, kind: job.kind,
      });
    }
    await tx.query("commit");
  } catch (error) {
    await tx.query("rollback");
    throw error;
  } finally {
    tx.release();
  }
}

/**
 * A conversa do atendimento, da fronteira que o job carrega.
 *
 * `service_boundary.conversation_id` é gravado na emissão do turno (é a
 * identidade do atendimento, não o estado atual — a razão de existir da
 * `fronteira.ts`). Sem ele não há aviso com destino clicável, e aviso sem
 * destino é meio aviso: a pessoa lê que uma mensagem não sai e não tem para
 * onde ir.
 */
function conversaDoJob(job: JobRow): string | null {
  const fronteira = job.payload?.service_boundary as { conversation_id?: unknown } | null | undefined;
  const conversa = fronteira?.conversation_id;
  return typeof conversa === "string" && conversa.length > 0 ? conversa : null;
}
