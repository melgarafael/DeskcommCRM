import { serviceForAutomation } from "@/lib/atendimento/origem-automacao";
/**
 * Ação `start_message_flow` — arma um fluxo publicado para o contato do
 * contexto. organization_id vem da regra, nunca do body.
 *
 * #2647: a ação alcança as DUAS superfícies, e cada uma pelo caminho do
 * PRODUTO — porque os dois caminhos são de fato diferentes:
 *
 *   * follow-up (padrão, `surface` ausente): `enrollFollowupFlow`, o mesmo
 *     caminho do POST de enrollments. Byte a byte como antes: toda regra já
 *     gravada continua inscrevendo no MESMO fluxo.
 *   * atendimento (`surface: "atendimento"`): `iniciarFluxoDeAtendimento`, a
 *     MESMA entrada da palavra-gatilho e do roteador. Não dá para reusar o
 *     enroll aqui — ele recusa superfície `atendimento` (`flow_not_enrollable`)
 *     e o BANCO recusaria o status `active` que o enroll insere
 *     (`trg_enrollment_superficie_coerente`, 23514): roteiro de atendimento só
 *     existe como `coletando`, conduzido no turno do agente.
 *
 * Consequência declarada a quem lê o run: armar o roteiro não EMPURRA mensagem
 * nenhuma. O roteiro passa a valer no próximo turno de conversa do contato —
 * é assim que a palavra-gatilho e o roteador já funcionam.
 *
 * Enroll não emite event_log; requestId `rule:{id}` fica no audit se houver
 * actor humano. Conflito de inscrição viva (23505) falha de forma explícita.
 */
import { registerAction } from "@/lib/automation/actions";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import { iniciarFluxoDeAtendimento } from "@/lib/followup/atendimento";
import { enrollFollowupFlow } from "@/lib/followup/enroll";

const TYPE = "start_message_flow";

/** As superfícies que a ação enxerga. Ausente = follow-up, o de sempre. */
type Superficie = "followup" | "atendimento";

function contactIdFromCtx(ctx: ActionCtx): string | null {
  const contact = ctx.context.contact as { id?: string } | undefined;
  if (typeof contact?.id === "string" && contact.id) return contact.id;
  const lead = ctx.context.lead as { contact_id?: string | null } | undefined;
  if (typeof lead?.contact_id === "string" && lead.contact_id) return lead.contact_id;
  return null;
}

export async function executeStartMessageFlow(
  ctx: ActionCtx,
  config: Record<string, unknown>,
): Promise<ActionResultDetail> {
  const pointerId = typeof config.flow_pointer_id === "string" ? config.flow_pointer_id : null;
  if (!pointerId) {
    return { type: TYPE, status: "failed", error: "missing_config" };
  }

  const contactId = contactIdFromCtx(ctx);
  if (!contactId) {
    return { type: TYPE, status: "skipped", detail: { reason: "no_contact" } };
  }

  // Só `atendimento` desvia. Qualquer outra valor — incluindo ausente — é o
  // follow-up de sempre, que é o que toda regra existente aponta.
  const superficie: Superficie = config.surface === "atendimento" ? "atendimento" : "followup";
  if (superficie === "atendimento") {
    return armarRoteiroDeAtendimento(ctx, pointerId, contactId);
  }

  const result = await enrollFollowupFlow(ctx.admin, {
    resolveServiceBoundary: () => serviceForAutomation(ctx, contactId),
    organizationId: ctx.organizationId,
    pointerId,
    contactId,
    actorUserId: null,
    requestId: `rule:${ctx.ruleId}`,
  });

  if (!result.ok) {
    if (result.code === "conflict") {
      return {
        type: TYPE,
        status: "failed",
        error: "live_enrollment_exists",
        detail: { reason: "live_enrollment_exists" },
      };
    }
    if (result.code === "flow_not_active") {
      return { type: TYPE, status: "skipped", detail: { reason: "flow_not_active" } };
    }
    return { type: TYPE, status: "failed", error: result.message, detail: { code: result.code } };
  }

  return {
    type: TYPE,
    status: "success",
    detail: { enrollment_id: result.enrollment.id },
  };
}

/**
 * O roteiro de atendimento (#2647): entre no MESMO ponto em que entram
 * palavra-gatilho e roteador — `iniciarFluxoDeAtendimento` grava o enrollment
 * como `coletando`, sem relógio, e o próximo turno do agente conduz a lista de
 * perguntas.
 *
 * O pool do Postgres é o do próprio roteiro (o módulo fala `pg`, não
 * PostgREST). Sem `SUPABASE_DB_URL` instalado não há por onde começar — e a
 * frase diz isso, não culpa o lead do evento.
 */
async function armarRoteiroDeAtendimento(
  ctx: ActionCtx,
  pointerId: string,
  contactId: string,
): Promise<ActionResultDetail> {
  let pool;
  try {
    pool = getRequestPool();
  } catch {
    return {
      type: TYPE,
      status: "failed",
      error: "banco_do_roteiro_indisponivel",
      detail: { reason: "banco_do_roteiro_indisponivel" },
    };
  }

  // O MESMO destino de serviço que o enroll de follow-up resolve: o roteiro
  // herda a conversa do contato em vez de nascer pendurado no vazio.
  const boundary = await serviceForAutomation(ctx, contactId);

  const enrollmentId = await iniciarFluxoDeAtendimento(pool, {
    organizationId: ctx.organizationId,
    contactId,
    flowPointerId: pointerId,
    conversationId: boundary.conversation_id,
    origem: "automacao",
  });

  // `null` cobre, de propósito, o que a própria função recusa: fluxo não
  // publicado ou de outra empresa, grafo que o motor não percorre, contato já
  // com roteiro vivo (um por contato) e roteiro já concluído sem `pode_recomecar`.
  if (enrollmentId === null) {
    return { type: TYPE, status: "skipped", detail: { reason: "roteiro_nao_iniciado" } };
  }

  return {
    type: TYPE,
    status: "success",
    detail: { enrollment_id: enrollmentId },
  };
}

registerAction({ type: TYPE, execute: executeStartMessageFlow });
