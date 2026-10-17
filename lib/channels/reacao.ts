/**
 * lib/channels/reacao.ts — A REAÇÃO NÃO É MENSAGEM (#2797, fatias 1 e 2).
 *
 * Reação é a resposta mais comum do WhatsApp, e o CRM a tratava de dois jeitos
 * ruins, um por canal: no WAHA o evento nem era assinado (`message.reaction`
 * fora de `WHATSAPP_HOOK_EVENTS`); no canal oficial ela chegava dentro de
 * `messages[]` e virava linha de `messages` SEM emoji e SEM alvo — que ainda
 * CARIMBAVA a conversa como mensagem nova (última mensagem, janela de 24h,
 * prévia vazia, contador de não lidas). O cliente que reagia 👍 à proposta era
 * cobrado pelo follow-up de silêncio e aparecia como "não respondeu".
 *
 * Este módulo é o ÚNICO lugar que grava uma reação, e vale para os dois
 * canais. O contrato, tirado da issue:
 *
 *   - a reação vira linha `type='reaction'` LIGADA ao alvo — o ponteiro
 *     `reply_to_message_id` e o `metadata.reaction = { emoji,
 *     target_external_id, author }`;
 *   - `direction` vem de quem reagiu (`fromMe` no WAHA; a Cloud API só entrega
 *     reação do contato);
 *   - a idempotência é pela chave externa da PRÓPRIA reação (`unique
 *     (organization_id, external_id)`) — a Meta re-entrega tudo que não recebe
 *     2xx, e o WAHA também reentrega;
 *   - emoji vazio = reação REMOVIDA: apaga a anterior do MESMO autor sobre o
 *     MESMO alvo (o WhatsApp guarda uma reação por autor por mensagem);
 *   - SEM ALVO ENCONTRADO: descartada com log. Nunca linha cega — uma reação
 *     apontando para mensagem que o CRM não conhece não tem o que contar, e a
 *     linha solta seria exatamente o defeito que esta issue veio consertar.
 *
 * E o que ele NÃO faz, de propósito (a fatia 2): NÃO chama
 * `fn_mark_conversation_message`. É essa RPC que move `last_message_at`,
 * `last_inbound_at`, a prévia e o contador de não lidas — quem chama é quem
 * decide se a conversa foi "carimbada". A reação atualiza o fio, não fala.
 * (Fóruns futuros da mesma issue — reação como sinal de vida para o
 * follow-up, comando por emoji, desenho da Inbox — moram fora deste módulo.)
 *
 * ─── Por que o ALVO é resolvido ANTES de qualquer escrita ───────────────────
 *
 * Sem alvo não há linha: é a régua que separa "reação que o Inbox desenha
 * sobre o balão" de "linha órfã que ninguém sabe de quem é". Resolver antes do
 * INSERT também dá de graça o `conversation_id` e o `contact_id` da linha —
 * os dois saem do PRÓPRIO alvo, então uma reação em grupo cai na conversa do
 * grupo sem precisar de caminho separado.
 *
 * ─── O autor, e por que ele é só para a remoção ─────────────────────────────
 *
 * `author` é a identidade do autor DENTRO DO CANAL (o jid no WAHA, o `wa_id`
 * na Cloud API) — as duas grafias nunca se encontram, e não precisam: o
 * filtro que apaga a reação antiga corre na MESMA organização e no MESMO alvo,
 * que é onde só o autor importa. Cada canal entrega o seu; ver
 * `autorDaReacao` em `lib/waha/ingest.ts` e o `from` do evento Meta.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

export type DesfechoDaReacao =
  /** A linha nasceu ligada ao alvo. */
  | { status: "gravada"; messageId: string | null; conversationId: string }
  /** Era uma REMOÇÃO: a reação anterior do mesmo autor sobre o mesmo alvo saiu. */
  | { status: "removida"; conversationId: string }
  /** O alvo não está no CRM (ou o payload não trouxe id nenhum). Nada gravado. */
  | { status: "sem_alvo" }
  /** O `unique (organization_id, external_id)`: a mesma reação já entrou. */
  | { status: "duplicada" }
  /** O banco recusou a leitura ou a escrita — quem chama decide se tenta de novo. */
  | { status: "falha"; motivo: string; codigo: string | null };

/**
 * As três chaves que a linha da reação HERDA DO ALVO: o ponteiro e os dois
 * campos que a tabela exige (`conversation_id` e `contact_id` NOT NULL).
 * Saem do alvo de propósito — não há resolução de contato aqui, e a reação
 * cai na conversa em que a mensagem reagida já nasceu (inclusive em grupo).
 */
type AlvoLido = {
  id: string;
  conversation_id: string | null;
  contact_id: string | null;
};

export async function gravarReacaoDeMensagem(
  admin: SupabaseClient,
  args: {
    organizationId: string;
    channelSessionId: string;
    /** Id da PRÓPRIA reação — é a chave de idempotência, não a do alvo. */
    externalId: string;
    /** Id da mensagem reagida, como o canal o entrega (pode vir composto). */
    alvoExternalId: string;
    /**
     * As formas em que o `external_id` do ALVO pode estar gravado. O WAHA é
     * assimétrico (o envio grava a cauda, o webhook traz o composto); a Cloud
     * API usa o `wamid` inteiro dos dois lados, então ali a lista tem um
     * elemento só.
     */
    candidatosDoAlvo: string[];
    /**
     * `_<cauda>` — o LIKE de sufixo que alcança qualquer formato de chat. `null`
     * desliga a segunda tentativa (canal cujo id é canônico).
     */
    sufixoDoAlvo: string | null;
    /** Emoji; `null` ou vazio = o autor REMOVEU a reação. */
    emoji: string | null;
    /** Quem reagiu, na grafia do canal. Só a remoção o lê. */
    author: string;
    direction: "inbound" | "outbound";
    sentAt: string;
    /** `sent_via` da linha, quando o canal tem esse carimbo. `null` omite. */
    sentVia: string | null;
    /** Só para o log — `waha`, `meta`, … */
    canal: string;
  },
): Promise<DesfechoDaReacao> {
  // ── O ALVO ────────────────────────────────────────────────────────────────
  //
  // DUAS tentativas, nesta ordem, e nunca juntas: `.in(...)` e `.like(...)` na
  // MESMA query são ANDados pelo builder, e o eco do envio grava a CAUDA enquanto
  // o webhook traz o composto — um AND entre as duas formas acharia NADA (medido:
  // as provas falhavam com "sem alvo" para alvo gravado à vista). Mesma
  // doutrina da citação: `resolverMensagemCitada` (lib/waha/ingest.ts).
  const lerAlvo = async (): Promise<{
    data: AlvoLido | null;
    error: { message?: string } | null;
  }> => {
    const porFormas = await admin
      .from("messages")
      .select("id, conversation_id, contact_id, external_id")
      .eq("organization_id", args.organizationId)
      .in("external_id", args.candidatosDoAlvo)
      .limit(1)
      .maybeSingle();
    if (porFormas.error) return { data: null, error: porFormas.error };
    if (porFormas.data) return { data: porFormas.data as AlvoLido, error: null };
    if (!args.sufixoDoAlvo) return { data: null, error: null };
    const porSufixo = await admin
      .from("messages")
      .select("id, conversation_id, contact_id, external_id")
      .eq("organization_id", args.organizationId)
      .like("external_id", `%\\${args.sufixoDoAlvo}`)
      .limit(1)
      .maybeSingle();
    if (porSufixo.error) return { data: null, error: porSufixo.error };
    return { data: (porSufixo.data as AlvoLido) ?? null, error: null };
  };

  let alvo: AlvoLido | null = null;
  try {
    const { data, error } = await lerAlvo();
    if (error) return { status: "falha", motivo: `alvo: ${error.message ?? ""}`.trim(), codigo: (error as { code?: string }).code ?? null };
    alvo = data ?? null;
  } catch (err) {
    return { status: "falha", motivo: `alvo: ${err instanceof Error ? err.message : "erro"}`, codigo: null };
  }

  if (!alvo) {
    // Descarte VISÍVEL: sem alvo não há o que ligar, e a linha órfã é o defeito
    // medido. `warn` porque a pergunta "cadê a reação?" precisa de resposta no
    // log; `info` sumiria no ruído e `error` acusaria defeito nosso.
    logger.warn(`[${args.canal}] reação sem alvo no CRM — descartada`, {
      organization_id: args.organizationId,
      external_id: args.externalId,
      alvo: args.alvoExternalId,
    });
    return { status: "sem_alvo" };
  }

  // ── A REMOÇÃO ─────────────────────────────────────────────────────────────
  if (!args.emoji) {
    // O WhatsApp guarda UMA reação por autor por mensagem: o "trocar o 👍 por
    // 😐" chega como dois eventos (remoção + reação nova), e apagar a anterior
    // é o que impede a fila de emojis antigos no balão. O apagão é restrito em
    // quatro chaves — organização, tipo, MESMO alvo e MESMO autor — porque um
    // filtro mais largo apagaria o gesto de outra pessoa.
    try {
      const { error } = await admin
        .from("messages")
        .delete()
        .eq("organization_id", args.organizationId)
        .eq("type", "reaction")
        .eq("reply_to_message_id", alvo.id)
        // Caminho jsonb: o autor mora em `metadata.reaction.author`. Linha sem
        // a chave vira NULL no `->>` e não casa — que é o comportamento certo.
        .eq("metadata->reaction->>author", args.author);
      if (error) return { status: "falha", motivo: `remocao: ${error.message ?? ""}`.trim(), codigo: error.code ?? null };
    } catch (err) {
      return { status: "falha", motivo: `remocao: ${err instanceof Error ? err.message : "erro"}`, codigo: null };
    }
    return { status: "removida", conversationId: alvo.conversation_id ?? "" };
  }

  // ── A LINHA ───────────────────────────────────────────────────────────────
  try {
    const { data, error } = await admin
      .from("messages")
      .insert({
        organization_id: args.organizationId,
        conversation_id: alvo.conversation_id,
        // NOT NULL na tabela, e sai do ALVO: a reação pertence à conversa que a
        // mensagem reagida já nasceu, então não há resolução de contato aqui.
        contact_id: alvo.contact_id,
        channel_session_id: args.channelSessionId,
        external_id: args.externalId,
        type: "reaction",
        direction: args.direction,
        status: args.direction === "inbound" ? "delivered" : "sent",
        // Sem corpo de propósito: o que a tela desenha é o emoji de
        // `metadata.reaction` sobre o BALÃO ALVO, e copiar o emoji para o
        // corpo faria a lista da Inbox tratar a reação como fala.
        body: null,
        sent_at: args.sentAt,
        ...(args.sentVia ? { sent_via: args.sentVia } : {}),
        reply_to_message_id: alvo.id,
        metadata: {
          reaction: {
            emoji: args.emoji,
            target_external_id: args.alvoExternalId,
            author: args.author,
          },
        },
      })
      .select("id")
      .maybeSingle();
    // 23505 = a mesma reação já entrou (reentrega do provedor). Não é erro.
    if (error) {
      if (error.code === "23505") return { status: "duplicada" };
      return { status: "falha", motivo: `mensagem: ${error.message ?? ""}`.trim(), codigo: error.code ?? null };
    }
    const messageId = (data as { id?: string } | null)?.id ?? null;
    return { status: "gravada", messageId, conversationId: alvo.conversation_id ?? "" };
  } catch (err) {
    return { status: "falha", motivo: `mensagem: ${err instanceof Error ? err.message : "erro"}`, codigo: null };
  }
}
