"use client";
import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { randomId } from "@/lib/random-id";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Message } from "@/lib/types/messaging";

interface SendArgs {
  conversation_id: string;
  body?: string;
  media_url?: string;
  media_mime?: string;
  media_storage_path?: string;
  media_size_bytes?: number;
  type?: string;
  /**
   * Definição aprovada — o caminho de volta quando a janela de 24h fechou. A
   * rota já aceitava estes campos; só o front nunca os mandava, então não havia
   * como disparar um modelo pelo inbox.
   */
  template_name?: string;
  template_language?: string;
  template_values?: Record<string, string>;
  /** A mensagem citada — id da NOSSA linha; o handler traduz para o do canal. */
  reply_to_message_id?: string;
  metadata?: Record<string, unknown>;
}

interface MessagesPage {
  data: Message[];
  meta?: { cursor?: string | null; has_more?: boolean };
}

export function useSendMessage() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: SendArgs) =>
      apiClient.post<{ data: Message }>("/api/v1/messages", input),
    onMutate: async (args) => {
      if (args.media_storage_path || args.media_url || args.type === "contact") return {};

      const queryKey = ["messages", args.conversation_id];
      await qc.cancelQueries({ queryKey });

      const tempId = `temp-${randomId()}`;
      const tempMsg: Message = {
        id: tempId,
        organization_id: "",
        conversation_id: args.conversation_id,
        channel_session_id: "",
        contact_id: "",
        external_id: null,
        type: args.type ?? "text",
        direction: "outbound",
        status: "queued",
        ack: null,
        error_code: null,
        error_message: null,
        body: args.body ?? null,
        media_url: args.media_url ?? null,
        media_mime: args.media_mime ?? null,
        media_size_bytes: null,
        media_storage_path: null,
        reply_to_message_id: args.reply_to_message_id ?? null,
        sent_via: "user",
        sent_by_user_id: null,
        sent_at: new Date().toISOString(),
        delivered_at: null,
        read_at: null,
        metadata: { _optimistic: true },
        // Mensagem que acaba de sair não foi editada nem apagada — mas os
        // campos precisam existir: sem eles o otimista não é do mesmo tipo do
        // que volta do servidor, e a bolha passaria a renderizar dois formatos.
        edited_at: null,
        revoked_at: null,
        created_at: new Date().toISOString(),
      };

      qc.setQueryData<InfiniteData<MessagesPage>>(queryKey, (old) => {
        if (!old) return old;
        const pages = [...old.pages];
        if (pages.length > 0) {
          // A primeira página contém as mensagens mais recentes. As páginas
          // seguintes são carregadas para trás no histórico.
          const newest = pages[0]!;
          pages[0] = {
            ...newest,
            data: [...newest.data, tempMsg],
          };
        }
        return { ...old, pages };
      });

      return { tempId };
    },
    onSuccess: (result, args, context) => {
      const real = result.data;
      const queryKey = ["messages", args.conversation_id];
      qc.setQueryData<InfiniteData<MessagesPage>>(queryKey, (old) => {
        if (!old || old.pages.length === 0) return old;
        // O Realtime pode ter buscado a mensagem real antes da resposta do
        // POST. Remover ambas as cópias antes de inseri-la evita duplicação.
        const pages = old.pages.map((page) => ({
          ...page,
          data: page.data.filter((m) => m.id !== context?.tempId && m.id !== real.id),
        }));
        pages[0] = { ...pages[0]!, data: [...pages[0]!.data, real] };
        return { ...old, pages };
      });
    },
    onError: (err, args, context) => {
      if (context?.tempId) {
        qc.setQueryData<InfiniteData<MessagesPage>>(["messages", args.conversation_id], (old) =>
          old
            ? {
                ...old,
                pages: old.pages.map((page) => ({
                  ...page,
                  data: page.data.filter((m) => m.id !== context.tempId),
                })),
              }
            : old,
        );
      }
      showApiError(err);
    },
    onSettled: (_data, _err, args) => {
      qc.invalidateQueries({ queryKey: ["messages", args.conversation_id] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}
