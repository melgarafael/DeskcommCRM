"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { ApiError, type ApiErrorBody } from "@/lib/api/types";
import type { MidiaDeTemplate } from "@/lib/templates/midias";

/**
 * Sobe UMA imagem nova para a Resposta rápida (#2526) — o lado cliente do
 * `POST /api/v1/message-templates/:id/midias`.
 *
 * Igual a `useUploadMedia`, mas sem `conversationId`: o destino é o TEMPLATE, e
 * é a rota que gera o caminho no bucket privado `whatsapp-media`. A rota devolve
 * a lista COMPLETA já gravada — é ela que a tela usa como base para o PATCH de
 * remoção, para os dois não disputarem a ordem da lista.
 */
export function useUploadTemplateMedia() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      templateId: string;
      file: File;
      midiasEsperadas?: readonly MidiaDeTemplate[];
      substituirAudio?: string;
    }): Promise<MidiaDeTemplate[]> => {
      const form = new FormData();
      form.append("file", args.file, args.file.name);
      if (args.midiasEsperadas !== undefined) {
        form.append("midias_esperadas", JSON.stringify(args.midiasEsperadas));
      }
      if (args.substituirAudio !== undefined) form.append("substituir_audio", args.substituirAudio);
      const res = await fetch(`/api/v1/message-templates/${args.templateId}/midias`, {
        method: "POST",
        body: form,
      });
      const json = (await res.json()) as Partial<ApiErrorBody> & { data?: { midias: MidiaDeTemplate[] } };
      if (!res.ok || !json.data) {
        const e = json.error;
        throw new ApiError(
          res.status,
          e?.code ?? "upload_failed",
          e?.details,
          e?.request_id ?? "",
          e?.message,
        );
      }
      return json.data.midias ?? [];
    },
    // Cada imagem que entra muda a lista e o compositor (mesma chave): sem
    // isto, a edição com upload deixava "Imagens 4" na tela até recarregar.
    onSuccess: () => qc.invalidateQueries({ queryKey: ["message-templates"] }),
    onError: (err) => showApiError(err),
  });
}
