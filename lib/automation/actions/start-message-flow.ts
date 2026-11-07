import { serviceForAutomation } from "@/lib/atendimento/origem-automacao";
/**
 * Ação `start_message_flow` — arma um fluxo publicado para o contato do
 * contexto. organization_id vem da regra, nunca do body.
 *
 * #2647: a ação alcança as DUAS superfícies, e cada uma pelo caminho do
 * PRODUTO — porque os dois caminhos são de fato diferentes:
 *
 *   * follow-up (padrão, `surface` ausente): `enrollFollowupFlow`, o mesmo
 *     caminho do POST de enrollments. Toda regra já gravada continua
 *     inscrevendo no MESMO fluxo; a única diferença é a guarda de opt-out,
 *     que vale para as duas superfícies.
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
 *
 * `replace_live_flow`: o contato só pode ter UMA inscrição viva
 * (`idx_followup_enrollments_one_live`), e sem a opção a regra perde para
 * qualquer fluxo que já estivesse andando. Medido em produção: o formulário
 * de pedido de uma loja não mandava a confirmação a quem já estava no
 * remarketing — justamente quem acabou de pedir. Com a opção, a regra encerra
 * a inscrição de OUTRO fluxo e inscreve neste. Nunca troca o mesmo fluxo
 * (recomeçaria a sequência) nem um fluxo pausado (uma pessoa está nele).
 */
import { registerAction } from "@/lib/automation/actions";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import { iniciarFluxoDeAtendimento } from "@/lib/followup/atendimento";
import { enrollFollowupFlow } from "@/lib/followup/enroll";
import { moduloLigado } from "@/lib/instalacao/modulos";

const TYPE = "start_message_flow";

/** Os estados de `idx_followup_enrollments_one_live`: os que bloqueiam a inscrição nova. */
const VIVOS = ["active", "waiting_reply", "paused_handoff", "paused_manual"] as const;
/** Os que a regra pode encerrar. Pausado é decisão de uma pessoa, e a regra não passa por cima. */
const SUBSTITUIVEIS = ["active", "waiting_reply"] as const;
export const MOTIVO_SUBSTITUIDO_POR_REGRA =
  "Substituído por outro fluxo iniciado por uma automação";
export const EVENTO_SUBSTITUIDO_POR_REGRA = "replaced_by_rule";

type Substituicao =
  | { ok: true; enrollmentId: string; pointerId: string }
  | { ok: false; reason: "same_flow" | "live_enrollment_paused" | "not_replaced" };

/**
 * Encerra a inscrição viva do contato em OUTRO fluxo. O `.in("status", ...)` no
 * UPDATE é a trava contra a corrida com o motor (mesma de `gatilho-caso.ts`): se
 * o tick concluiu a inscrição entre a leitura e aqui, a linha não casa e nada
 * terminal é ressuscitado.
 */
async function substituirInscricaoViva(
  ctx: ActionCtx,
  contactId: string,
  pointerId: string,
): Promise<Substituicao> {
  const { data: viva, error } = await ctx.admin
    .from("followup_enrollments")
    .select("id, pointer_id, status, current_node_id")
    .eq("organization_id", ctx.organizationId)
    .eq("contact_id", contactId)
    .in("status", [...VIVOS])
    .maybeSingle();
  if (error) throw new Error(error.message);
  const atual = viva as {
    id: string;
    pointer_id: string;
    status: string;
    current_node_id: string | null;
  } | null;
  if (!atual) return { ok: false, reason: "not_replaced" };
  if (atual.pointer_id === pointerId) return { ok: false, reason: "same_flow" };
  if (!(SUBSTITUIVEIS as readonly string[]).includes(atual.status)) {
    return { ok: false, reason: "live_enrollment_paused" };
  }

  const agora = new Date().toISOString();
  const { data: encerradas, error: updErr } = await ctx.admin
    .from("followup_enrollments")
    .update({
      status: "cancelled",
      cancel_reason: MOTIVO_SUBSTITUIDO_POR_REGRA,
      outcome: null,
      next_eval_at: null,
      claimed_until: null,
      completed_at: agora,
      updated_at: agora,
    })
    .eq("organization_id", ctx.organizationId)
    .eq("id", atual.id)
    .in("status", [...SUBSTITUIVEIS])
    .select("id");
  if (updErr) throw new Error(updErr.message);
  if ((encerradas ?? []).length === 0) return { ok: false, reason: "not_replaced" };

  // O dossiê do fluxo encerrado diz POR QUE ele parou e qual regra o tirou.
  const { error: evErr } = await ctx.admin.from("followup_enrollment_events").insert({
    organization_id: ctx.organizationId,
    enrollment_id: atual.id,
    node_id: atual.current_node_id,
    event_type: EVENTO_SUBSTITUIDO_POR_REGRA,
    payload: { rule_id: ctx.ruleId, rule_name: ctx.ruleName, new_pointer_id: pointerId },
  });
  if (evErr) throw new Error(evErr.message);
  return { ok: true, enrollmentId: atual.id, pointerId: atual.pointer_id };
}

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

  // Quem pediu opt-out não é inscrito em fluxo nenhum, das DUAS superfícies.
  // Sem esta guarda, o contato bloqueado ganhava roteiro (ou follow-up) vivo,
  // a ficha mostrava o fluxo e o run dizia "Sucesso". O motor hidrata
  // `context.contact` com a linha inteira do banco — a mesma fonte que
  // `checarGuardasDeContato` lê nas ações que mandam mensagem.
  if ((ctx.context.contact as { is_blocked?: boolean } | undefined)?.is_blocked === true) {
    return { type: TYPE, status: "skipped", detail: { reason: "contact_blocked" } };
  }

  // Só `atendimento` desvia. Qualquer outra valor — incluindo ausente — é o
  // follow-up de sempre, que é o que toda regra existente aponta.
  const superficie: Superficie = config.surface === "atendimento" ? "atendimento" : "followup";
  if (superficie === "atendimento") {
    return armarRoteiroDeAtendimento(ctx, pointerId, contactId);
  }

  const inscrever = () =>
    enrollFollowupFlow(ctx.admin, {
      resolveServiceBoundary: () => serviceForAutomation(ctx, contactId),
      organizationId: ctx.organizationId,
      pointerId,
      contactId,
      actorUserId: null,
      requestId: `rule:${ctx.ruleId}`,
    });

  let result = await inscrever();
  let substituida: { enrollmentId: string; pointerId: string } | null = null;

  if (!result.ok && result.code === "conflict" && config.replace_live_flow === true) {
    const troca = await substituirInscricaoViva(ctx, contactId, pointerId);
    // Motivos LITERAIS, um por ramo: a aba Atividade traduz cada `reason` por
    // frase (`tests/unit/motivo-de-parada-tem-frase.test.ts` cobra o mapa).
    if (!troca.ok && troca.reason === "same_flow") {
      return {
        type: TYPE,
        status: "failed",
        error: "live_enrollment_exists",
        detail: { reason: "same_flow" },
      };
    }
    if (!troca.ok && troca.reason === "live_enrollment_paused") {
      return {
        type: TYPE,
        status: "failed",
        error: "live_enrollment_exists",
        detail: { reason: "live_enrollment_paused" },
      };
    }
    if (troca.ok) substituida = { enrollmentId: troca.enrollmentId, pointerId: troca.pointerId };
    // Uma tentativa só: se outra inscrição entrou no meio, o conflito volta
    // como sempre, em vez de a regra ficar disputando o contato.
    result = await inscrever();
  }

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
    detail: {
      enrollment_id: result.enrollment.id,
      ...(substituida
        ? {
            replaced_enrollment_id: substituida.enrollmentId,
            replaced_pointer_id: substituida.pointerId,
          }
        : {}),
    },
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
  // O módulo é opcional e por instalação: desligado, ninguém conduz o roteiro
  // (a tela some e o turno do agente não o lê). Armar ali seria um sucesso falso.
  if (!(await moduloLigado(ctx.admin, "fluxos_atendimento"))) {
    return { type: TYPE, status: "skipped", detail: { reason: "modulo_desligado" } };
  }

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
