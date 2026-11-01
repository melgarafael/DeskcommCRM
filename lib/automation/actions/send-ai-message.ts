import { assertAgendaEffectSupabase } from "@/lib/agenda/efeito";
import { protecaoAgendaSupabase } from "@/lib/agenda/protecao-followup";
import {
  AgendaPuladoError,
  MOTIVO_DO_PULO,
  decidirNoEnvio,
  lerEscolhaNoEnvio,
  type EscolhaNoEnvio,
} from "@/lib/agenda/escolha-no-envio";
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
import { mensagemDeErro } from "@/lib/automation/actions/erro-legivel";
import { comercialExigeHumanoViaSupabase, restricaoComercialBarra } from "@/lib/escalacao/assunto-comercial";
import { triggerHandoff } from "@/lib/ai/handoff/orchestrator";

const TIPO = "send_ai_message";

/**
 * #3813 — o pulo por compromisso é `skipped` COM MOTIVO, não falha.
 *
 * Devolver `null` para "não é pulo" mantém os dois `catch` deste arquivo (o da
 * geração do texto e o do envio) com o desfecho que já tinham.
 */
function puloPorAgenda(err: unknown): ActionResultDetail | null {
  if (!(err instanceof AgendaPuladoError)) return null;
  return {
    type: TIPO,
    status: "skipped",
    detail: { reason: MOTIVO_DO_PULO, appointment_id: err.protection.appointment_id },
  };
}

async function postponeUntil(ctx: ActionCtx, config: Record<string, unknown>): Promise<string | null> {
  const escolha = lerEscolhaNoEnvio(config);
  const contato = checarGuardasDeContato(ctx);
  if (contato.ok) {
    const protection = (await protecaoAgendaSupabase(ctx.admin, ctx.organizationId, [contato.contact.id])).get(contato.contact.id)!;
    if (protection.motivo === "leitura_indisponivel") throw new Error("agenda_read_failed");
    // #3813 — `enviar`/`nao_enviar` não adiam o evento; só o padrão adia.
    const decisao = decidirNoEnvio(protection, escolha);
    if (decisao.acao === "adiar") return decisao.reavaliar_em;
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

  // #3813 — a escolha do passo da regra, no MESMO objeto para a guarda daqui e
  // para a do handler de envio (escolha que vale só na primeira é desfeita pela
  // segunda).
  const escolha: EscolhaNoEnvio = lerEscolhaNoEnvio(config);
  const contextoDeEnvio = { organizationId: ctx.organizationId, contactId: contact.id, escolhaNoEnvio: escolha };

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
        error: mensagemDeErro(err, 160),
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

  const { dados, origem, origemDaAbordagem } = await dadosDoFormularioDoContexto(ctx);

  let boundary: ServiceBoundary;
  try { boundary = await serviceForAutomation(ctx, contact.id, sessionId); }
  catch (error) { return { type: TIPO, status: "failed", error: mensagemDeErro(error) }; }
  let texto: string;
  try {
    await assertAgendaEffectSupabase(ctx.admin, contextoDeEnvio);
    const gerado = await gerarAbordagemDeFormulario(pool, llmEdgeConfigFromEnv(env), {
      tenantId: ctx.organizationId,
      agentId,
      leadId: contact.id,
      instrucao,
      origem,
      dados,
      origemDaAbordagem,
    });
    if (!gerado.ok) {
      return { type: TIPO, status: "failed", error: gerado.reason, detail: { reason: gerado.reason } };
    }
    texto = gerado.texto;
  } catch (err) {
    // #3813 — pulo por compromisso (escolha `nao_enviar`) antes da causa genérica.
    const pulo = puloPorAgenda(err);
    if (pulo) return pulo;
    // Teto de gasto atingido, credencial inválida, provider fora. A causa vai
    // inteira para o registro do run — é o que a tela mostra a quem pergunta
    // "por que a IA não escreveu?".
    const causa = mensagemDeErro(err);
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

    // ─── #3274 — A RESTRIÇÃO COMERCIAL, TAMBÉM AQUI ──────────────────────────
    //
    // Esta ação escreve com IA e entrega por `sendMessageHandler` sem atravessar
    // a cadeia `before_send`. Nas outras portas que falam com o cliente, o gate
    // `commercial_restriction` barra o corpo com preço e passa a conversa para a
    // equipe (`#2877`, levado adiante pelo `#3270`). Sem esta régua, a automação
    // entregava exatamente o preço que a cadeia barra no `send_message` — o mesmo
    // defeito que o atalho do texto fixo do follow-up tinha, e o motivo desta
    // régua aqui ser a MESMA das outras portas, não uma cópia.
    //
    // A regra e a falha FECHADA vivem em `lib/escalacao/assunto-comercial.ts`
    // (o dono): `restricaoComercialBarra` só vai ao banco quando o corpo tem cara
    // de preço, e leitura que estoura vale como camada LIGADA. O desfecho é o do
    // veto de lá: motivo `commercial_requires_human` e passagem para a equipe
    // pelo caminho de CRM que já existe (`triggerHandoff`), sem evento novo.
    //
    // Fica DEPOIS de `autorizarContatoParaIA` de propósito: o orquestrador só
    // passa bot→humano uma conversa que a IA poderia estar atendendo agora, e no
    // gate `allowlist` é este carimbo que a torna elegível. Antes dele, o pedido
    // viraria um silêncio — nem a mensagem, nem a equipe avisada.
    if (
      await restricaoComercialBarra(
        texto,
        () => comercialExigeHumanoViaSupabase(ctx.admin, ctx.organizationId),
        (mensagem, contexto) =>
          logger.warn(`[automation.send_ai_message] ${mensagem}`, {
            organizationId: ctx.organizationId,
            ruleId: ctx.ruleId,
            ...contexto,
          }),
      )
    ) {
      logger.info("[automation.send_ai_message] mensagem não enviada — restrição comercial da organização", {
        organizationId: ctx.organizationId,
        ruleId: ctx.ruleId,
        conversationId,
      });
      const lead = ctx.context.lead as { id?: string } | undefined;
      const passagem = await triggerHandoff({
        serviceBoundary: boundary,
        conversationId,
        organizationId: ctx.organizationId,
        // O MESMO motivo e o MESMO texto que a cadeia usa ao vetar: quem lê a
        // passagem na tela de atendimento vê a mesma frase, venha ela do agente
        // do turno ou desta automação.
        reason: "low_confidence",
        origem: "runtime_nativo",
        motivoTexto: "Resposta comercial barrada; valores e negociação são exclusivos da equipe.",
        leadId: lead?.id ?? null,
        metadata: { source: "automation_rule", acao: TIPO, rule_id: ctx.ruleId },
      });
      // O motivo diz o que ACONTECEU: a frase de `commercial_requires_human` na
      // aba Atividade afirma que a conversa passou para a equipe, e o
      // orquestrador pode recusar a passagem (conversa fora do atendimento da
      // IA, falha de escrita). Nesse caso a mensagem também não sai, mas ninguém
      // foi avisado por esta execução — e a tela precisa dizer isso.
      return {
        type: TIPO,
        status: "skipped",
        detail: passagem.triggered
          ? { reason: "commercial_requires_human", conversation_id: conversationId, passagem_para_a_equipe: true }
          : {
              reason: "commercial_requires_human_sem_passagem",
              conversation_id: conversationId,
              passagem_para_a_equipe: false,
            },
      };
    }

    await espacarEnvio(sessionId);
    const message = await sendMessageHandler(
      ctx.admin,
      {
        organization_id: ctx.organizationId,
        serviceBoundary: boundary,
        proactiveContext: contextoDeEnvio,
        // Disparada por regra, ESCRITA pela IA: o carimbo segue a autoria (#652).
        // O `agent_id` é o agente publicado que escreveu (#3373) — sem ele, a
        // assinatura `por_agente` (#3310) não tem como saber quem assina e caía
        // no `nome_ia`, porque o `id` do ator é a REGRA, não o agente.
        actor: {
          type: "webhook_source",
          id: ctx.ruleId,
          textoEscritoPelaIA: true,
          agent_id: agentId,
        },
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
    const pulo = puloPorAgenda(err);
    if (pulo) return pulo;
    return {
      type: TIPO,
      status: "failed",
      error: mensagemDeErro(err),
    };
  }
}

registerAction({ type: TIPO, postponeUntil, execute });
