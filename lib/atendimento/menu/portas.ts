/**
 * AS PORTAS DE PRODUÇÃO DO MENU — cada ação chama a régua que JÁ EXISTE.
 *
 * A regra desta fatia é não criar um segundo caminho para nada: o menu escolhe
 * ENTRE as réguas do produto, não escreve por conta própria.
 *
 *   • texto e arquivo → `sendMessageHandler` (`app/api/v1/messages/_handler.ts`),
 *     a porta de saída de TODOS os chamadores (Inbox, automação, agente, MCP) —
 *     a mesma que a Ouvidoria usa. O TIPO da mídia sai de
 *     `classificarMidiaComLegenda`, a régua do passo de mídia do follow-up;
 *   • fila → `triggerHandoff` (`lib/ai/handoff/orchestrator.ts`): silencia o
 *     bot, devolve a conversa para `pending` sem dono e registra a passagem.
 *     "A fila" é exatamente isso no vocabulário do Inbox
 *     (`lib/inbox/comando-da-conversa.ts`: "o automático saiu e nenhuma pessoa
 *     assumiu");
 *   • pessoa → `fn_conversation_assign` com `reason='transfer'`, a MESMA RPC da
 *     rota `/conversations/[id]/transfer`. Ela já confere que o destino é
 *     membro ativo da organização e já silencia o bot (`bot_silenced_until =
 *     'infinity'`), então não há nada a repetir aqui.
 *
 * ─── O que acontece quando a régua RECUSA ───────────────────────────────────
 *
 * Cada porta devolve `{ ok, motivo }` — nunca lança. Quem chama decide o que
 * fazer (o runtime cai para a fila, ou para humano), e o motivo vai para o log
 * com o nome que a régua deu (`nao_elegivel:…`, `assignee_not_eligible_member`).
 * Recusa silenciosa é o defeito que este contrato existe para impedir.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { triggerHandoff } from "@/lib/ai/handoff/orchestrator";
import { classificarMidiaComLegenda } from "@/lib/messaging/media/midia-com-legenda";
import type { MensagemDoMenu, PortasDoMenu } from "./atender";

/** A autoria do que o menu escreve: uma regra do produto, não a IA nem gente. */
const ATOR_DO_MENU = { type: "webhook_source", id: "menu-de-atendimento" } as const;

/**
 * O módulo de envio, resolvido UMA vez.
 *
 * `responde` e `enviaArquivo` são portas de uma mensagem cada, e mensagem chega
 * em rajada: sem o memo, cada envio pagava uma resolução de módulo. E o memo é
 * mais que custo — a MESMA promessa é o que garante que dois envios simultâneos
 * enxergam o mesmo módulo, e não duas resoluções independentes.
 *
 * A promessa é a que fica guardada (não o módulo): dois chamadores concorrentes
 * esperam a mesma carga em vez de dispararem uma cada. Uma falha limpa o memo —
 * o próximo envio tenta de novo em vez de herdar um erro para sempre.
 */
let envioPromessa: Promise<typeof import("@/app/api/v1/messages/_handler")> | null = null;
function moduloDeEnvio(): Promise<typeof import("@/app/api/v1/messages/_handler")> {
  envioPromessa ??= import("@/app/api/v1/messages/_handler").catch((erro: unknown) => {
    envioPromessa = null;
    throw erro;
  });
  return envioPromessa;
}

export function portasDoMenu(admin: SupabaseClient, entrada: MensagemDoMenu): PortasDoMenu {
  return {
    async responde({ texto, chave }) {
      const { sendMessageHandler } = await moduloDeEnvio();
      const mensagem = await sendMessageHandler(
        admin,
        {
          organization_id: entrada.organizationId,
          actor: ATOR_DO_MENU,
          requestId: chave,
        },
        {
          conversation_id: entrada.conversationId,
          type: "text",
          body: texto,
          metadata: { idempotency_key: chave, menu_de_atendimento: true },
        },
      );
      // O envio NÃO lança quando o canal recusa: ele devolve a linha com
      // `status='failed'`. Ler o status é a única forma de saber se o cliente
      // recebeu — o mesmo conserto que o aviso da passagem precisou.
      return (mensagem as unknown as { status?: string | null } | null)?.status !== "failed";
    },

    async liberaPosse({ metadata }) {
      // Só o dono da posse chega aqui (o perdedor nunca envia, logo nunca
      // libera), então a escrita não precisa de condição: ela devolve a
      // conversa ao `metadata` de antes, sem a chave do menu.
      try {
        const { error } = await admin
          .from("conversations")
          .update({ metadata })
          .eq("organization_id", entrada.organizationId)
          .eq("id", entrada.conversationId);
        return !error;
      } catch {
        return false;
      }
    },

    async tomaPosse({ metadata }) {
      // ── A TRAVA DA CORRIDA (#5137), e por que ela mora AQUI ──────────────
      //
      // Um UPDATE com o filtro no próprio jsonb: o PostgREST traduz o
      // `.is("metadata->menu_de_atendimento", null)` para
      // `"metadata"->'menu_de_atendimento' IS NULL` e o banco avalia o WHERE e
      // grava na MESMA instrução, sob o lock da linha. Quem chega depois
      // encontra a chave gravada e o UPDATE não casa — zero linhas, sem erro.
      //
      // O `.select("id")` é o que transforma "quantas linhas" em resposta: sem
      // ele o PostgREST devolve `data: null` nos dois desfechos e não haveria
      // como saber se ESTE chamador ganhou a posse. Uma linha = ganhou.
      //
      // Não é RPC nem migration de propósito: o estado mora em
      // `conversations.metadata`, e a condição sobre uma chave ausente de jsonb
      // é exatamente o que o filtro do PostgREST sabe fazer. Uma função SQL a
      // mais seria um segundo caminho para a mesma linha.
      try {
        const { data, error } = await admin
          .from("conversations")
          .update({ metadata })
          .eq("organization_id", entrada.organizationId)
          .eq("id", entrada.conversationId)
          .is("metadata->menu_de_atendimento", null)
          .select("id");
        if (error) return { ok: false, motivo: "erro_de_escrita" };
        return Array.isArray(data) && data.length > 0
          ? { ok: true }
          : { ok: false, motivo: "menu_em_disputa" };
      } catch {
        return { ok: false, motivo: "erro_de_escrita" };
      }
    },

    async enviaArquivo({ mediaUrl, legenda, chave }) {
      const classificada = classificarMidiaComLegenda(mediaUrl);
      if (!classificada.ok) return false;
      const { sendMessageHandler } = await moduloDeEnvio();
      const mensagem = await sendMessageHandler(
        admin,
        {
          organization_id: entrada.organizationId,
          actor: ATOR_DO_MENU,
          requestId: chave,
        },
        {
          conversation_id: entrada.conversationId,
          type: classificada.type,
          media_url: mediaUrl,
          media_mime: classificada.mime,
          ...(legenda !== null && legenda.trim() !== "" ? { body: legenda } : {}),
          metadata: { idempotency_key: chave, menu_de_atendimento: true },
        },
      );
      return (mensagem as unknown as { status?: string | null } | null)?.status !== "failed";
    },

    async passaParaFila({ chave }) {
      const resultado = await triggerHandoff({
        organizationId: entrada.organizationId,
        conversationId: entrada.conversationId,
        reason: "requested_human",
        // O menu é runtime DETERMINÍSTICO do núcleo: a passagem não veio de um
        // modelo e não veio de um humano. Sem esta origem, a linha da passagem
        // diria "motor B" e nada mais.
        origem: "runtime_nativo",
        metadata: { menu_de_atendimento: true, chave },
      });
      return { ok: resultado.triggered, motivo: resultado.reason };
    },

    async passaParaPessoa({ userId, chave }) {
      const { data, error } = await admin.rpc("fn_conversation_assign" as never, {
        p_organization_id: entrada.organizationId,
        p_conversation_id: entrada.conversationId,
        p_to_user_id: userId,
        p_reason: "transfer",
      } as never);
      if (error) return { ok: false, motivo: error.message.slice(0, 160) };
      const linha = Array.isArray(data) ? data[0] : data;
      if (!linha) return { ok: false, motivo: "conversa_nao_encontrada" };
      return { ok: true, motivo: chave };
    },
  };
}
