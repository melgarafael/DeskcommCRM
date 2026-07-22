"use client";
import { useMutation } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";

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
      const json = (await res.json()) as { data?: UploadedMedia; error?: { code: string; message: string } };
      if (!res.ok || !json.data) {
        throw Object.assign(new Error(json.error?.message ?? "upload_failed"), {
          code: json.error?.code,
          status: res.status,
        });
      }
      return json.data;
    },
    onError: (err) => showApiError(err),
  });
}
