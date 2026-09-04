"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { LgpdAnonymizeInput } from "@/lib/schemas/contacts";

interface AnonymizeResponse {
  data: {
    contact_id: string;
    anonymized_at: string | null;
    /**
     * `resumed` é o desfecho que faltava: o contato já constava anonimizado e a
     * cascata completou o que tinha ficado para trás. Sem ele, esse caso caía em
     * `already_anonymized` e a tela dizia que nada acontecera bem na hora em que
     * a redação pendente acontecia.
     */
    action: "anonymized" | "resumed" | "already_anonymized";
    redacted_lead_ids: string[];
    redacted_activities: number;
  };
}

export function useAnonymizeContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: LgpdAnonymizeInput) =>
      apiClient.post<AnonymizeResponse>("/api/v1/lgpd/anonymize", input),
    onError: showApiError,
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["contact", vars.contact_id] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
    },
  });
}
