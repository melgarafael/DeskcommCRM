import { assertAgendaEffectSupabase } from "@/lib/agenda/efeito";
import { protecaoAgendaSupabase } from "@/lib/agenda/protecao-followup";
/**
 * Ação `send_ai_message` — "Mensagem escrita pela IA".
 *
 * Irmã de `send_whatsapp_message`: MESMAS guardas (contato, opt-out, janela de
 * envio do número, cap diário, espaçamento) e MESMO caminho de saída
 * (`sendMessageHandler`). A única diferença é de onde vem o texto — de um
 * agente publicado que leu o formulário, em vez de um template com
 * `{{nome}}`.
 *
 * As guardas são importadas da irmã de propósito. Reescrevê-las aqui faria a
 * ação nova nascer sem o conserto que a antiga acabou de receber (o desfecho
 * derivado do estado real da mensagem) — que é exatamente o modo de falha que
 * este repo já pagou antes: conserto por instância, não por classe.
 */
import { registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import { serviceForAutomation } from "@/lib/atendimento/origem-automacao";
import { assertServiceBoundarySupabase } from "@/lib/atendimento/origem";
import type { ServiceBoundary } from "@/lib/atendimento/fronteira";
import { adiarAteAJanelaAbrir } from "@/lib/automation/janela-do-canal";
import { checkDailyLimit, espacarEnvio } from "@/lib/automation/throttle";
import { reportarEnvio, type MensagemEnviada } from "@/lib/automation/desfecho-do-envio";
import { dadosDoFormularioDoContexto } from "@/lib/automation/dados-do-formulario";
import { checarGuardasDeContato } from "@/lib/automation/guarda-do-contato";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { gerarAbordagemDeFormulario } from "@/lib/agent-engine/agent/abordagem-de-formulario";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { llmEdgeConfigFromEnv } from "@/lib/agent-engine/edge/llm/credentials";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { autorizarContatoParaIA } from "@/lib/ai/elegibilidade/autorizacao";
import { decidirPreGoLiveDoCanalViaSupabase } from "@/lib/ai/elegibilidade/consulta-pre-go-live";

const TIPO = "send_ai_message";

async function postponeUntil(ctx: ActionCtx, config: Record<string, unknown>): Promise<string | null> {
  const contato = checarGuardasDeContato(ctx);
  if (contato.ok) {
    const protection = (await protecaoAgendaSupabase(ctx.admin, ctx.organizationId, [contato.contact.id])).get(contato.contact.id)!;
    if (protection.motivo === "leitura_indisponivel") throw new Error("agenda_read_failed");
    if (protection.adiar) return protection.reavaliar_em;
  }
  const sessionId = typeof config.channel_session_id === "string" ? config.channel_session_id : null;
  if (!sessionId) return null;
  const foraDaJanela = await adiarAteAJanelaAbrir(ctx.admin, ctx.organizationId, sessionId);
  if (foraDaJanela) return foraDaJanela;
  const daily = await checkDailyLimit(ctx.admin, ctx.organizationId, sessionId);
  return daily.allowed ? null : (daily.retry_at ?? null);
}

async function execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const sessionId = typeof config.channel_session_id === "string" ? config.channel_session_id : null;
  const agentId = typeof config.agent_id === "string" ? config.agent_id : null;
  const instrucao = typeof config.instruction === "string" ? config.instruction.trim() : "";
  if (!sessionId || !agentId || !instrucao) {
    return { type: TIPO, status: "failed", error: "missing_config" };
  }

  // Guardas compartilhadas com send_whatsapp_message — ver guarda-do-contato.ts
  // (esta ação nasceu sem o gate de consentimento que a irmã recebeu em
  // 2026-08-25; a promessa do cabeçalho deste arquivo já dizia "mesmas
  // guardas... importadas da irmã", e agora é verdade).
  const guarda = checarGuardasDeContato(ctx);
  if (!guarda.ok) return { type: TIPO, status: "skipped", detail: { reason: guarda.reason } };
  const contact = guarda.contact;

  // Esta ação abre um primeiro contato e por isso ainda não tem conversa para
  // passar pelo gate comum. No pré-go-live ela precisa parar AQUI, antes da
  // chamada paga ao modelo e antes de criar qualquer mensagem.
  try {
    const acesso = await decidirPreGoLiveDoCanalViaSupabase(ctx.admin, {
      organizationId: ctx.organizationId,
      channelSessionId: sessionId,
      contactPhoneNumber: contact.phone_number,
    });
    if (!acesso.permite) {
      return { type: TIPO, status: "skipped", detail: { reason: acesso.motivo } };
    }
  } catch (err) {
    return {
      type: TIPO,
      status: "skipped",
      detail: {
        reason: "elegibilidade_indeterminada",
        error: err instanceof Error ? err.message.slice(0, 160) : "erro",
      },
    };
  }

  // ─── O texto ───────────────────────────────────────────────────────────────
  //
  let pool;
  try {
    pool = getRequestPool();
  } catch {
    // `SUPABASE_DB_URL` ausente. É config da instalação, não erro deste lead —
    // a frase precisa dizer isso para quem lê a aba Atividade.
    return { type: TIPO, status: "failed", error: "ia_indisponivel", detail: { reason: "ia_indisponivel" } };
  }

  const { dados, origem, veioDeFormulario } = await dadosDoFormularioDoContexto(ctx);

  let boundary: ServiceBoundary;
  try { boundary = await serviceForAutomation(ctx, contact.id, sessionId); }
  catch (error) { return { type: TIPO, status: "failed", error: error instanceof Error ? error.message : String(error) }; }
  let texto: string;
  try {
    await assertAgendaEffectSupabase(ctx.admin, { organizationId: ctx.organizationId, contactId: contact.id });
    const gerado = await gerarAbordagemDeFormulario(pool, llmEdgeConfigFromEnv(env), {
      tenantId: ctx.organizationId,
      agentId,
      leadId: contact.id,
      instrucao,
      origem,
      dados,
      veioDeFormulario,
    });
    if (!gerado.ok) {
      return { type: TIPO, status: "failed", error: gerado.reason, detail: { reason: gerado.reason } };
    }
    texto = gerado.texto;
  } catch (err) {
    // Teto de gasto atingido, credencial inválida, provider fora. A causa vai
    // inteira para o registro do run — é o que a tela mostra a quem pergunta
    // "por que a IA não escreveu?".
    const causa = err instanceof Error ? err.message : String(err);
    logger.error("[automation.send_ai_message] a IA não conseguiu escrever", {
      organizationId: ctx.organizationId,
      ruleId: ctx.ruleId,
      agentId,
      causa,
    });
    return { type: TIPO, status: "failed", error: causa };
  }

  // ─── O envio ───────────────────────────────────────────────────────────────
  try {
    const conversationId = boundary.conversation_id;
    await assertServiceBoundarySupabase(ctx.admin, boundary);
    // ELEGIBILIDADE: a IA vai FALAR com este contato agora, por decisão de uma
    // regra de automação (tipicamente o `lead.created` de um formulário). Isso o
    // torna elegível para a resposta dele ser atendida — sem isto, no gate
    // `allowlist` a IA abriria a conversa e ignoraria o retorno do lead.
    await autorizarContatoParaIA(ctx.admin, {
      organizationId: ctx.organizationId,
      contactId: contact.id,
      reason: `automacao:${ctx.ruleId}`,
    });
    await espacarEnvio(sessionId);
    const message = await sendMessageHandler(
      ctx.admin,
      {
        organization_id: ctx.organizationId,
        serviceBoundary: boundary,
        proactiveContext: { organizationId: ctx.organizationId, contactId: contact.id },
        actor: { type: "webhook_source", id: ctx.ruleId },
        requestId: `rule:${ctx.ruleId}`,
      },
      { conversation_id: conversationId, type: "text", body: texto } as Parameters<
        typeof sendMessageHandler
      >[2],
    );
    const desfecho = await reportarEnvio(
      ctx,
      TIPO,
      message as unknown as MensagemEnviada,
      conversationId,
    );
    // O texto gerado entra no detalhe: sem ele, quem lê a Atividade não tem como
    // saber SE a instrução que escreveu produziu a mensagem que queria — e
    // ajustar a instrução às cegas é o que faz o dono desistir da IA.
    desfecho.detail = { ...(desfecho.detail ?? {}), texto_gerado: texto };
    return desfecho;
  } catch (err) {
    return {
      type: TIPO,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

registerAction({ type: TIPO, postponeUntil, execute });
