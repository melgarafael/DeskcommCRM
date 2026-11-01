import { assertAgendaEffectSupabase } from "@/lib/agenda/efeito";
import { protecaoAgendaSupabase } from "@/lib/agenda/protecao-followup";
import {
  AgendaPuladoError,
  MOTIVO_DO_PULO,
  decidirNoEnvio,
  lerEscolhaNoEnvio,
  type EscolhaNoEnvio,
} from "@/lib/agenda/escolha-no-envio";
import { registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import { renderTemplate } from "@/lib/automation/template";
import { serviceForAutomation } from "@/lib/atendimento/origem-automacao";
import { checkDailyLimit, espacarEnvio } from "@/lib/automation/throttle";
import { adiarAteAJanelaAbrir } from "@/lib/automation/janela-do-canal";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { reportarEnvio, type MensagemEnviada } from "@/lib/automation/desfecho-do-envio";
import { checarGuardasDeContato } from "@/lib/automation/guarda-do-contato";
import { classificarMidiaComLegenda, type TipoDeMidiaComLegenda } from "@/lib/messaging/media/midia-com-legenda";
import { recusaDeMidiaForaDaJanela } from "@/lib/messaging/media/recusa-de-midia-fora-da-janela";
import { mensagemDeErro } from "@/lib/automation/actions/erro-legivel";

async function postponeUntil(ctx: ActionCtx, config: Record<string, unknown>): Promise<string | null> {
  const escolha = lerEscolhaNoEnvio(config);
  const contato = checarGuardasDeContato(ctx);
  if (contato.ok) {
    const protection = (await protecaoAgendaSupabase(ctx.admin, ctx.organizationId, [contato.contact.id])).get(contato.contact.id)!;
    if (protection.motivo === "leitura_indisponivel") throw new Error("agenda_read_failed");
    // #3813 — a escolha do passo manda: `enviar`/`nao_enviar` NÃO adiam o evento.
    const decisao = decidirNoEnvio(protection, escolha);
    if (decisao.acao === "adiar") return decisao.reavaliar_em;
  }
  const sessionId = typeof config.channel_session_id === "string" ? config.channel_session_id : null;
  if (!sessionId) return null; // config inválida falha no execute, não adia

  // A janela vem dos knobs DO NÚMERO (fuso do tenant, domingo configurável) —
  // a mesma régua da tela de Conexões e do agente. Ver janela-do-canal.ts.
  const foraDaJanela = await adiarAteAJanelaAbrir(ctx.admin, ctx.organizationId, sessionId);
  if (foraDaJanela) return foraDaJanela;

  const daily = await checkDailyLimit(ctx.admin, ctx.organizationId, sessionId);
  return daily.allowed ? null : (daily.retry_at ?? null);
}

async function execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const sessionId = typeof config.channel_session_id === "string" ? config.channel_session_id : null;
  const template = typeof config.template === "string" ? config.template : null;
  if (!sessionId || !template) {
    return { type: "send_whatsapp_message", status: "failed", error: "missing_config" };
  }
  // MÍDIA OPCIONAL (#2734, ampliada pelo #2972): quando vier, o texto atual é a
  // LEGENDA, e o que sai é uma mensagem de mídia — imagem, vídeo, áudio (como
  // nota de voz) ou documento — pelo MESMO caminho do Inbox e das campanhas
  // (`sendMessageHandler`), nunca por um segundo envio. O que não for um arquivo
  // identificável (sem MIME declarado e sem extensão conhecida) é recusado AQUI,
  // antes de nascer linha nenhuma.
  const mediaUrl =
    typeof config.media_url === "string" && config.media_url.trim() ? config.media_url.trim() : null;
  let midia: { type: TipoDeMidiaComLegenda; mime: string } | null = null;
  if (mediaUrl) {
    const classificada = classificarMidiaComLegenda(mediaUrl);
    if (!classificada.ok) {
      return { type: "send_whatsapp_message", status: "failed", error: classificada.motivo };
    }
    midia = { type: classificada.type, mime: classificada.mime };
  }
  // Guardas compartilhadas com send_ai_message — ver guarda-do-contato.ts
  // (existe/bloqueado/telefone/consentimento, este último um gate FIXO).
  const guarda = checarGuardasDeContato(ctx);
  if (!guarda.ok) return { type: "send_whatsapp_message", status: "skipped", detail: { reason: guarda.reason } };
  const contact = guarda.contact;

  // #3813 — "Quando o contato tiver horário marcado", escolhido NO PASSO da regra
  // (`config.quando_ha_compromisso`). O mesmo objeto vai para a guarda daqui e
  // para a do handler de envio: uma escolha que valesse só na primeira seria
  // desfeita pela segunda, e a mensagem não sairia mesmo autorizada.
  const escolha: EscolhaNoEnvio = lerEscolhaNoEnvio(config);
  const contextoDeEnvio = { organizationId: ctx.organizationId, contactId: contact.id, escolhaNoEnvio: escolha };

  // O espaçamento é COMPARTILHADO com a ação de IA (mesmo número, mesmo
  // contador) — ver lib/automation/throttle.ts.
  try {
    await assertAgendaEffectSupabase(ctx.admin, contextoDeEnvio);
    const boundary = await serviceForAutomation(ctx, contact.id, sessionId);
    const conversationId = boundary.conversation_id;
    // CANAL OFICIAL, janela fechada: a mídia NÃO sai — e o texto NÃO sai sozinho
    // no lugar dela. A recusa é explícita, com motivo, para o operador saber por
    // que a regra não entregou. Canal de QR e parceiros sem janela passam direto
    // (o helper consulta a matriz de capabilities). Só o caminho COM mídia passa
    // por esta régua: o envio de texto puro segue com o contrato de antes.
    if (midia) {
      const recusa = await recusaDeMidiaForaDaJanela(ctx.admin, {
        organizationId: ctx.organizationId,
        conversationId,
        agora: new Date(),
      });
      if (recusa) return { type: "send_whatsapp_message", status: "failed", error: recusa };
    }
    await espacarEnvio(sessionId);
    const body = renderTemplate(template, ctx.context);
    const message = await sendMessageHandler(
      ctx.admin,
      {
        organization_id: ctx.organizationId,
        serviceBoundary: boundary,
        proactiveContext: contextoDeEnvio,
        actor: { type: "webhook_source", id: ctx.ruleId },
        requestId: `rule:${ctx.ruleId}`,
      },
      // Com mídia: o `body` é a LEGENDA e o `type` diz ao canal o que é o arquivo.
      // Sem mídia: comportamento de sempre (texto puro).
      (midia
        ? {
            conversation_id: conversationId,
            type: midia.type,
            body,
            media_url: mediaUrl,
            media_mime: midia.mime,
          }
        : { conversation_id: conversationId, type: "text", body }) as Parameters<typeof sendMessageHandler>[2],
    );
    // O desfecho vem do ESTADO DA MENSAGEM, nunca da ausência de exceção:
    // `sendMessageHandler` marca `failed`/`queued` e devolve normalmente (ver
    // lib/automation/desfecho-do-envio.ts para o defeito medido).
    return await reportarEnvio(ctx, "send_whatsapp_message", message as unknown as MensagemEnviada, conversationId);
  } catch (err) {
    // #3813 — escolha `nao_enviar`: o pulo tem MOTIVO e vira `skipped` (o mesmo
    // canal dos outros pulos: `guarda-do-contato`, `elegibilidade`), não falha.
    // Antes desta escolha o `AgendaDeferredError` chegava aqui e o run dizia
    // "falhou" para uma recusa que é decisão de produto.
    if (err instanceof AgendaPuladoError) {
      return {
        type: "send_whatsapp_message",
        status: "skipped",
        detail: { reason: MOTIVO_DO_PULO, appointment_id: err.protection.appointment_id },
      };
    }
    return {
      type: "send_whatsapp_message",
      status: "failed",
      error: mensagemDeErro(err),
    };
  }
}

registerAction({ type: "send_whatsapp_message", postponeUntil, execute });
