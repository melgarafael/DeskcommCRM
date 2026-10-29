"use client";
import { useMutation } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { ApiError, type ApiErrorBody } from "@/lib/api/types";

export interface UploadedMedia {
  storage_path: string;
  media_mime: string;
  media_size_bytes: number;
  kind: "image" | "video" | "audio" | "document";
}

/**
 * Onde o arquivo VAI SUBIR — e é aqui que o caminho se decide, não no render.
 *
 * `mensagem` (padrão) é a rota de sempre: bucket `whatsapp-media`, o arquivo
 * vira mensagem e vai para o cliente. `nota` é a rota nova
 * `/notes/media`, bucket `internal-media` — o arquivo vira anexo de nota
 * interna e NUNCA sai do nosso Storage. A bifurcação é uma escolha do caller
 * (o composer, que sabe em que modo está) porque é a única decisão que não dá
 * para derivar do arquivo: o mesmo PDF pode ser os dois.
 */
export type DestinoDoUpload = "mensagem" | "nota";

export function useUploadMedia() {
  return useMutation({
    mutationFn: async (args: {
      conversationId: string;
      file: File | Blob;
      filename?: string;
      destino?: DestinoDoUpload;
      /** Gravação do composer: o servidor converte para opus (F2, o AAC do iPhone). */
      notaDeVoz?: boolean;
    }) => {
      const form = new FormData();
      form.append("file", args.file, args.filename ?? (args.file instanceof File ? args.file.name : "audio"));
      if (args.notaDeVoz) form.append("nota_de_voz", "1");
      const rota = args.destino === "nota" ? "notes/media" : "media";
      const res = await fetch(`/api/v1/conversations/${args.conversationId}/${rota}`, {
        method: "POST",
        body: form,
      });
      const json = (await res.json()) as Partial<ApiErrorBody> & { data?: UploadedMedia };
      if (!res.ok || !json.data) {
        const e = json.error;
        throw new ApiError(res.status, e?.code ?? "upload_failed", e?.details, e?.request_id ?? "", e?.message);
      }
      return json.data;
    },
    onError: (err) => showApiError(err),
  });
}
