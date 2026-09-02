"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Contact } from "@/lib/types/contacts";

interface ContactResponse {
  data: Contact;
  meta?: { nuit_available?: boolean };
}

export function useContact(id: string) {
  return useQuery({
    queryKey: ["contact", id],
    enabled: !!id,
    queryFn: async () => {
      try {
        return await apiClient.get<ContactResponse>(`/api/v1/contacts/${id}`);
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
  });
}
