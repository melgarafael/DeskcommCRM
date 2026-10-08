/**
 * Relógio do pipeline webhook → automação → follow-up → 1º envio.
 *
 * NÃO depende de agendador externo: onde não há cron de minuto, o dreno de
 * eventos não roda a tempo. Este código corre DENTRO do POST (captação ou
 * inbound).
 *
 * O crontab da VPS continua existindo como rede de segurança; não é requisito
 * desta jornada. Falha aqui nunca vira 5xx do webhook.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { env } from "@/lib/env";
import { drainEventLog } from "@/lib/event-log/drain";
import { comOrigemDeRequest } from "@/lib/event-log/origem-do-dreno";
import { ensureHandlersRegistered } from "@/lib/event-log/register-handlers";
import { idsDoContatoEGemeos } from "@/lib/channels/contato-por-telefone";
import { aplicarTextoNosFollowups } from "@/lib/followup/aplicar-inbound";
import {
  avancarEnrollmentAtivo,
  createSupabaseAdminClient,
  type TickDeps,
} from "@/lib/followup/engine";
import { enviarTextoFixoPendente } from "@/lib/followup/enviar-texto-fixo";
import { FOLLOWUP_GATILHO_LEAD_HANDLER_KEY } from "@/lib/followup/gatilho-lead.handler";
import { FOLLOWUP_GATILHO_RETORNO_HANDLER_KEY } from "@/lib/followup/gatilho-retorno.handler";
import type { EnrollmentRow } from "@/lib/followup/node-handlers";
import { applyReactivityEvent, createSupabaseReactivityClient } from "@/lib/followup/reactivity";
import { logger } from "@/lib/logger";

export { enviarTextoFixoPendente } from "@/lib/followup/enviar-texto-fixo";

export type SinalDeInbound = {
  organizationId: string;
  contactId: string;
  messageId?: string | null;
  texto?: string | null;
};

export type ContatoDoPipeline = {
  organizationId: string;
  contactId: string;
};

function tickDepsDe(admin: SupabaseClient): TickDeps {
  return {
    db: createSupabaseAdminClient(admin),
    clock: () => new Date(),
    enqueueJob: async (job) => {
      const { error } = await admin.from("job_queue").insert({
        organization_id: job.organization_id,
        contact_id: job.contact_id,
        kind: "followup_turn",
        payload: job.payload,
      });
      if (error) throw new Error(error.message);
    },
  };
}

/**
 * Arranca só o fluxo DESTE contato, e só nós `active`.
 * `waiting_reply` avança com a mensagem do WhatsApp (`aplicarTextoNosFollowups`),
 * não com um POST de captação — o claim global tratava a espera vencida como
 * timeout no mesmo request do webhook de contato.
 */
async function tickAtivosDoContato(
  admin: SupabaseClient,
  contato: ContatoDoPipeline,
  statuses: ReadonlyArray<"active" | "waiting_reply"> = ["active"],
  opts?: { mesmoAntesDoPrazo?: boolean },
): Promise<number> {
  const ids = await idsDoContatoEGemeos(admin, contato.organizationId, contato.contactId);
  let q = admin
    .from("followup_enrollments")
    .select("*")
    .eq("organization_id", contato.organizationId)
    .in("contact_id", ids)
    .in("status", [...statuses]);
  if (!opts?.mesmoAntesDoPrazo) {
    q = q.lte("next_eval_at", new Date().toISOString());
  }
  const { data, error } = await q.limit(8);
  if (error) throw new Error(error.message);
  const agora = new Date().toISOString();
  const rows = (
    opts?.mesmoAntesDoPrazo
      ? (data ?? []).filter(
          (r) => r.status === "waiting_reply" || (typeof r.next_eval_at === "string" && r.next_eval_at <= agora),
        )
      : (data ?? [])
  ) as EnrollmentRow[];
  const deps = tickDepsDe(admin);
  for (const row of rows) {
    await avancarEnrollmentAtivo(deps, row);
  }
  return rows.length;
}

async function acordarFollowupPorInbound(admin: SupabaseClient, sinal: SinalDeInbound): Promise<void> {
  const db = createSupabaseReactivityClient(admin);
  await applyReactivityEvent(db, () => new Date(), {
    id: sinal.messageId ?? `inbound:${sinal.contactId}`,
    organization_id: sinal.organizationId,
    event_type: "message.received",
    entity_kind: "message",
    entity_id: sinal.messageId ?? null,
    payload: { contact_id: sinal.contactId },
    metadata: { source: "kick-local-pipeline" },
    consumed_by: [],
    attempts: 0,
  });
}

async function acelerarDesteContato(
  admin: SupabaseClient,
  contato: ContatoDoPipeline,
  opts?: { incluirEsperaDeResposta?: boolean },
): Promise<void> {
  const ids = await idsDoContatoEGemeos(admin, contato.organizationId, contato.contactId);
  const statuses: ReadonlyArray<"active" | "waiting_reply"> = opts?.incluirEsperaDeResposta
    ? ["active", "waiting_reply"]
    : ["active"];
  for (let i = 0; i < 6; i++) {
    const claimed = await tickAtivosDoContato(admin, contato, statuses, {
      mesmoAntesDoPrazo: Boolean(opts?.incluirEsperaDeResposta),
    });
    const enviados = await enviarTextoFixoPendente(admin, ids);
    if (!claimed && !enviados) break;
  }
}

/**
 * O worker drena o `event_log` em laço (`runEventLogDrainLoop`, a cada 2 s com
 * trabalho e 10 s ocioso)? Quem declara é o compose que sobe o `worker` ao lado
 * do `app` — `docker-compose.prod.yml` e `docker-compose.local.yml`. Ausente
 * (dev com `npm run dev`, e2e, deploy sem worker) é "não", e o dreno inline
 * continua global como sempre foi.
 */
function workerDrenaOEventLog(): boolean {
  return /^(1|true|on|yes|sim)$/i.test(env.EVENT_LOG_WORKER_DRAINS.trim());
}

/**
 * Os handlers que INSCREVEM este contato num fluxo a partir desta mensagem: o
 * retorno depois de silêncio (`message.received`) e o lead que acabou de nascer
 * (`lead.created`). São os únicos cujo efeito o 2º tick deste request alcança —
 * sem eles no request, a primeira mensagem do fluxo espera o cron
 * `followup-flow-worker` (1 min), porque o laço do worker inscreve mas não
 * avança o fluxo de lead novo.
 *
 * Fica de fora o que não precisa do request: sentimento (LLM), push, mídia,
 * RAG, automações e a métrica de campanha seguem para o laço do worker. A
 * reatividade de `message.received` também fica: `acordarFollowupPorInbound`
 * já aplicou a mesma regra acima.
 */
const HANDLERS_DO_DRENO_DO_REQUEST = [
  FOLLOWUP_GATILHO_RETORNO_HANDLER_KEY,
  FOLLOWUP_GATILHO_LEAD_HANDLER_KEY,
] as const;

/**
 * Passo 1 do inbound: o follow-up DESTE contato reage à mensagem.
 *
 * Vem antes do despacho do agente (regra UMA VOZ, `aplicarEfeitosPosEntrada`):
 * o cliente que responde a um fluxo avança o fluxo antes de o turno ser pedido.
 */
export async function acelerarFollowupDoInbound(
  admin: SupabaseClient,
  inbound: SinalDeInbound,
): Promise<void> {
  try {
    // Mesma ordem do handler de event_log: acordar a espera QUE JÁ EXISTIA,
    // depois aplicar o texto. Aplicar primeiro estaciona um wait_started
    // novo (ALWAYS → menu) e o acordar seguinte acorda essa espera com a
    // mesma mensagem — o fluxo inteiro dispara de uma vez.
    try {
      await acordarFollowupPorInbound(admin, inbound);
    } catch (err) {
      logger.warn("[dev.pipeline] acordar follow-up falhou", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await aplicarTextoNosFollowups(admin, inbound);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn("[dev.pipeline] aplicar texto do inbound falhou", { error: detail });
    }
    await acelerarDesteContato(admin, {
      organizationId: inbound.organizationId,
      contactId: inbound.contactId,
    });
  } catch (err) {
    logger.warn("[dev.pipeline] acelerar follow-up falhou (lead/mensagem já gravados)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Passo 2: drena o `event_log` e dá o 2º tick no contato.
 *
 * Com worker drenando, o dreno é ESCOPADO (esta organização, só
 * `HANDLERS_DO_DRENO_DO_REQUEST`): o dreno global levava até 50 eventos de
 * QUALQUER organização — indexação de PDF, mídia, push — para dentro do tempo
 * do webhook. Sem worker, ele é a única coisa que roda os handlers a tempo, e
 * continua global.
 */
export async function drenarEventosDoInbound(
  admin: SupabaseClient,
  inbound?: SinalDeInbound,
): Promise<void> {
  try {
    ensureHandlersRegistered();
    try {
      // ⚠️ MARCADO COMO "dentro de requisição". Este dreno roda no meio do
      // webhook de mensagem, e o webhook do WhatsApp tem timeout e REENTREGA:
      // um handler que fale com um terceiro pela rede aqui pode transformar uma
      // mensagem entregue numa mensagem reentregue — e a reentrega dispara o
      // agente de novo. Quem precisa dessa informação a lê por `origemDoDreno()`
      // e se adia; quem não precisa não muda uma linha.
      const drain =
        inbound && workerDrenaOEventLog()
          ? await comOrigemDeRequest(() =>
              drainEventLog(admin, {
                limit: 10,
                escopo: {
                  organizationId: inbound.organizationId,
                  handlers: HANDLERS_DO_DRENO_DO_REQUEST,
                },
              }),
            )
          : await comOrigemDeRequest(() => drainEventLog(admin));
      logger.info("[dev.pipeline] event-log-drain", { ...drain });
    } catch (err) {
      logger.warn("[dev.pipeline] drain falhou; tick do follow-up segue", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (inbound) {
      await acelerarDesteContato(admin, {
        organizationId: inbound.organizationId,
        contactId: inbound.contactId,
      });
    }
  } catch (err) {
    logger.warn("[dev.pipeline] acelerar falhou (lead/mensagem já gravados)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function acelerarPipelineDeEventos(
  admin: SupabaseClient,
  inbound?: SinalDeInbound,
): Promise<void> {
  if (inbound) await acelerarFollowupDoInbound(admin, inbound);
  await drenarEventosDoInbound(admin, inbound);
}

export async function kickLocalPipeline(
  admin: SupabaseClient,
  contato?: ContatoDoPipeline,
): Promise<void> {
  // acelerarPipelineDeEventos já é fail-soft; o tick do contato NÃO era —
  // uma query incompleta (mock de teste ou PostgREST momentâneo) derrubava o
  // 200 da captação depois do lead já gravado. O contrato do cabeçalho vale
  // para o POST inteiro.
  try {
    await acelerarPipelineDeEventos(admin);
    if (contato) await acelerarDesteContato(admin, contato);
  } catch (err) {
    logger.warn("[dev.pipeline] kick falhou (lead/mensagem já gravados)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
