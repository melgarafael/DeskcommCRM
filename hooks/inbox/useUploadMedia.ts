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

export function useUploadMedia() {
  return useMutation({
    mutationFn: async (args: { conversationId: string; file: File | Blob; filename?: string }) => {
      const form = new FormData();
      form.append("file", args.file, args.filename ?? (args.file instanceof File ? args.file.name : "audio"));
      const res = await fetch(`/api/v1/conversations/${args.conversationId}/media`, {
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
