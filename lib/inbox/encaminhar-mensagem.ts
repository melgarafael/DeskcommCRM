/**
 * ENCAMINHAR UMA MENSAGEM — o gesto do botão "Encaminhar" do chat (#2835).
 *
 * ─── Por que este arquivo existe, e o que ele NÃO faz ───────────────────────
 *
 * A issue pede "um botão no chat" e diz que "o transporte do canal já faz
 * isso". A tentação é abrir um caminho de envio novo (um `POST /api/v1/forward`
 * falando com o transporte) — e é justamente o que NÃO se deve fazer: o envio
 * do Inbox já tem dono, e é `sendMessageHandler` (o mesmo handler de
 * `POST /api/v1/messages`). Um segundo caminho divergiria do primeiro no dia
 * em que um dos dois ganhasse um guard (janela de 24h, canal desativado,
 * assinatura do emissor), e o sintoma seria uma mensagem saindo por um lugar
 * onde a regra não vale.
 *
 * Então encaminhar é LER a mensagem de origem e MANDAR o conteúdo pelo MESMO
 * caminho: `sendMessageHandler`, com a conversa de destino no lugar da atual.
 * Nada mais. É esta reutilização que o teste prova (o spy do handler é
 * chamado com a conversa escolhida e o conteúdo original), e é ela que faz o
 * encaminhamento herdar todos os guards do envio normal — inclusive a
 * marcação de `failed`/`queued` quando o canal do destino não pode enviar.
 *
 * ─── Escopo entregue, e o que ficou de fora ─────────────────────────────────
 *
 * ENTREGUE: texto (com legenda de mídia) e mídia EXTERNA (`media_url`, a URL
 * do CDN do WhatsApp que o inbound carrega). O destino é uma conversa
 * existente da organização, escolhida na tela.
 *
 * FORA DO ESCOPO, de propósito e declarado: mídia guardada no NOSSO Storage
 * (`media_storage_path`). Ela é escopada à conversa dona (o handler recusa
 * `media_storage_path` que não pertença à conversa do envio — `isMediaPathOwnedBy`),
 * e copiar o objeto para a pasta do destino é um trabalho que a issue não pede
 * e que este PR não inventa. Uma mensagem só de mídia interna cai no motivo
 * claro de `motivoParaNaoEncaminhar`, nunca num envio mudo.
 *
 * ─── O destino sem canal válido falha ALTO (critério c) ─────────────────────
 *
 * Quando a conversa de destino não existe na organização, não tem sessão de
 * canal, ou a sessão está DESATIVADA pelo operador, a resposta é um `ApiError`
 * com motivo — nunca a mensagem saindo e falhando em silêncio depois. O mesmo
 * `canalDesativado` da lei do produto (#2318) é quem decide o último caso, para
 * que a tela e o envio concordem sobre o que é "desativado".
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ApiError } from "@/lib/api/types";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { canalDesativado } from "@/lib/channels/desativado";
import { traduzir } from "@/lib/i18n/dicionario";
import type { SendMessageInput } from "@/lib/schemas";
import type { Message } from "@/lib/types/messaging";

type SB = SupabaseClient;

/** As colunas da mensagem de origem que o encaminhamento de fato lê. */
const COLUNAS_DA_ORIGEM =
  "id, organization_id, conversation_id, type, body, media_url, media_storage_path, media_mime, revoked_at";

export interface MensagemDeOrigem {
  id: string;
  organization_id: string;
  conversation_id: string;
  type: string | null;
  body: string | null;
  media_url: string | null;
  media_storage_path: string | null;
  media_mime: string | null;
  revoked_at: string | null;
}

export interface EncaminharParams {
  /** A mensagem do chat que será encaminhada. */
  messageId: string;
  /** A conversa de destino — existente e acessível à organização. */
  conversationIdDestino: string;
}

/**
 * O motivo pelo qual esta origem NÃO pode ser encaminhada — ou `null` quando
 * nada impede.
 *
 * Devolve um CÓDIGO, e não a frase: quem recusa precisa dizer POR QUE, e a
 * frase tem de passar pelo dicionário (há espanhol na tela). Uma frase
 * pré-montada voltaria como chave de runtime para o `traduzir` — a mesma dívida
 * que o guarda de i18n proíbe. O código é estável e o texto sai em
 * `mensagemDoMotivo`, com um literal por ramo.
 */
export type MotivoNaoEncaminhavel = "apagada" | "midia_interna" | "sem_conteudo";

export function motivoParaNaoEncaminhar(origem: MensagemDeOrigem): MotivoNaoEncaminhavel | null {
  if (origem.revoked_at) return "apagada";
  // Mídia interna (nosso Storage) sem URL externa e sem texto: nada
  // transportável pelo caminho do envio sem copiar o objeto — fora do escopo.
  if (origem.media_storage_path && !origem.media_url && !origem.body) return "midia_interna";
  if (!origem.body && !origem.media_url) return "sem_conteudo";
  return null;
}

/**
 * A frase do motivo, por LITERAL — um ramo por código, para o `traduzir`
 * receber texto que o código escreveu (nunca uma chave montada em runtime).
 */
export function mensagemDoMotivo(
  motivo: MotivoNaoEncaminhavel,
  t: (texto: string) => string,
): string {
  switch (motivo) {
    case "apagada":
      return t("Esta mensagem foi apagada e não pode ser encaminhada.");
    case "midia_interna":
      return t("Esta mensagem só tem mídia guardada no CRM, que ainda não pode ser encaminhada.");
    case "sem_conteudo":
      return t("Só é possível encaminhar mensagens de texto ou mídia.");
  }
}

/**
 * O corpo `input` do envio, montado a partir da mensagem de origem.
 *
 * Mesmo shape que o Inbox manda em `POST /api/v1/messages` — de propósito: o
 * destino é só a `conversation_id` trocada. O conteúdo (texto e/ou URL de
 * mídia) viaja igual; a origem fica gravada em `metadata` para a conversa de
 * destino guardar de onde a mensagem veio, sem inventar coluna.
 */
export function montarEntradaDeEncaminhamento(
  origem: MensagemDeOrigem,
  conversationIdDestino: string,
): SendMessageInput {
  const entrada: SendMessageInput = {
    conversation_id: conversationIdDestino,
    // Com mídia externa, o tipo é o da origem (image/video/…); só texto é
    // `text`. Um balão sem tipo certo sairia como texto com URL dentro.
    // O tipo vem do NOSSO banco (`messages.type`), logo dentro do vocabulário
    // do schema — o cast só acomoda o literal que `SendMessageInput` exige.
    type: (origem.media_url ? (origem.type ?? "text") : "text") as SendMessageInput["type"],
    metadata: {
      forwarded_from_message_id: origem.id,
      forwarded_from_conversation_id: origem.conversation_id,
    },
  };
  if (origem.body) entrada.body = origem.body;
  if (origem.media_url) {
    entrada.media_url = origem.media_url;
    if (origem.media_mime) entrada.media_mime = origem.media_mime;
  }
  return entrada;
}

/**
 * Lê a mensagem de origem da organização. `404` quando não existe (ou é de
 * outra organização — o filtro por `organization_id` é o que separa os
 * tenants, exatamente como no handler de envio).
 */
async function lerOrigem(supabase: SB, ctx: HandlerCtx, messageId: string): Promise<MensagemDeOrigem> {
  const { data, error } = await supabase
    .from("messages")
    .select(COLUNAS_DA_ORIGEM)
    .eq("id", messageId)
    .eq("organization_id", ctx.organization_id)
    .maybeSingle();
  if (error) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  }
  if (!data) {
    throw new ApiError(
      404,
      "not_found",
      undefined,
      ctx.requestId,
      traduzir("Mensagem não encontrada.", ctx.idioma ?? "pt-BR"),
    );
  }
  return data as unknown as MensagemDeOrigem;
}

/**
 * Valida o destino e FALHA ALTO quando ele não tem canal que possa enviar
 * (critério c). As três recusas, do mais óbvio ao mais sutil:
 *
 *   1. a conversa não existe nesta organização → `destino_invalido`;
 *   2. não tem sessão de canal → `destino_sem_canal`;
 *   3. a sessão está desativada pelo operador → `canal_desativado`.
 *
 * A leitura do canal usa a MESMA régua do produto (`canalDesativado`), para a
 * tela e o envio nunca discordarem sobre o que é "desativado".
 */
async function validarDestino(
  supabase: SB,
  ctx: HandlerCtx,
  conversationIdDestino: string,
): Promise<void> {
  const t = (texto: string) => traduzir(texto, ctx.idioma ?? "pt-BR");

  const { data: destino, error: erroDestino } = await supabase
    .from("conversations")
    .select("id, channel_session_id")
    .eq("id", conversationIdDestino)
    .eq("organization_id", ctx.organization_id)
    .maybeSingle();
  if (erroDestino) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, erroDestino.message);
  }
  const linha = destino as { id: string; channel_session_id: string | null } | null;
  if (!linha) {
    throw new ApiError(
      422,
      "destino_invalido",
      undefined,
      ctx.requestId,
      t("Escolha uma conversa de destino desta organização."),
    );
  }
  if (!linha.channel_session_id) {
    throw new ApiError(
      422,
      "destino_sem_canal",
      undefined,
      ctx.requestId,
      t("A conversa de destino não tem canal de envio."),
    );
  }

  const { data: sessao, error: erroSessao } = await supabase
    .from("channel_sessions")
    .select("id, metadata")
    .eq("id", linha.channel_session_id)
    .eq("organization_id", ctx.organization_id)
    .maybeSingle();
  if (erroSessao) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, erroSessao.message);
  }
  if (!sessao) {
    throw new ApiError(
      422,
      "destino_sem_canal",
      undefined,
      ctx.requestId,
      t("A conversa de destino não tem canal de envio."),
    );
  }
  if (canalDesativado((sessao as { metadata?: unknown }).metadata)) {
    throw new ApiError(
      422,
      "canal_desativado",
      undefined,
      ctx.requestId,
      t("O canal da conversa de destino está desativado. Reative-o para encaminhar."),
    );
  }
}

/**
 * Encaminha a mensagem `messageId` para a conversa `conversationIdDestino`,
 * pelo MESMO caminho de envio do Inbox (`sendMessageHandler`).
 *
 * Devolve a linha criada na conversa de destino, com o mesmo conteúdo da
 * origem. A mensagem ORIGINAL não é tocada — este caminho só a LÊ.
 */
export async function encaminharMensagem(
  supabase: SB,
  ctx: HandlerCtx,
  params: EncaminharParams,
): Promise<Message> {
  const origem = await lerOrigem(supabase, ctx, params.messageId);

  const motivo = motivoParaNaoEncaminhar(origem);
  if (motivo) {
    const t = (texto: string) => traduzir(texto, ctx.idioma ?? "pt-BR");
    throw new ApiError(422, "nao_encaminhavel", undefined, ctx.requestId, mensagemDoMotivo(motivo, t));
  }

  await validarDestino(supabase, ctx, params.conversationIdDestino);

  return sendMessageHandler(
    supabase,
    ctx,
    montarEntradaDeEncaminhamento(origem, params.conversationIdDestino),
  );
}
