"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { RoutingMode } from "@/lib/schemas/phone-numbers";

export interface PhoneNumberRow {
  id: string;
  number: string;
  label: string | null;
  routing_mode: RoutingMode;
  default_ai_agent_id: string | null;
  is_active: boolean;
  created_at: string;
  agent: { id: string; name: string } | null;
}

interface ListResponse {
  data: PhoneNumberRow[];
}

export function usePhoneNumbers() {
  return useQuery({
    queryKey: ["phone-numbers"],
    queryFn: async () => {
      const res = await apiClient.get<ListResponse>("/api/v1/phone-numbers");
      return res.data;
    },
  });
}

export interface CreatePhoneNumberInput {
  number: string;
  label?: string | null;
  routing_mode: RoutingMode;
  default_ai_agent_id?: string | null;
  is_active: boolean;
}

export function useCreatePhoneNumber() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePhoneNumberInput) =>
      apiClient.post<{ data: PhoneNumberRow }>("/api/v1/phone-numbers", input),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["phone-numbers"] }),
  });
}

export interface UpdatePhoneNumberInput {
  id: string;
  label?: string | null;
  routing_mode?: RoutingMode;
  default_ai_agent_id?: string | null;
  is_active?: boolean;
}

export function useUpdatePhoneNumber() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: UpdatePhoneNumberInput) =>
      apiClient.patch<{ data: PhoneNumberRow }>(`/api/v1/phone-numbers/${id}`, patch),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["phone-numbers"] }),
  });
}
