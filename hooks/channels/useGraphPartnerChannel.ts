"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

/**
 * Canal parceiro Graph-compatível (Datafy): conexão SÓ com o token; o servidor
 * descobre `phone_number_id`/`waba_id` via `GET /me`.
 *
 * O hook pode nomear o provider (a catraca `lint:channels` não varre `hooks/`),
 * mas o COMPONENTE que o importa não — por isso o caminho do arquivo é neutro.
 */
export interface GraphPartnerChannelState {
  channel_session_id?: string | null;
  connected: boolean;
  /** Existe token gravado? O token em si NUNCA volta. */
  hasToken: boolean;
  phoneNumberId: string | null;
  wabaId: string | null;
  displayName: string | null;
  phoneNumber: string | null;
  status: string | null;
  webhook: {
    callbackUrl: string;
    signatureOptional?: boolean;
  } | null;
}

export interface ConnectGraphPartnerInput {
  token: string;
}

export function useGraphPartnerChannel() {
  return useQuery({
    queryKey: ["graph-partner-channel"],
    queryFn: async () =>
      apiClient.get<{ data: GraphPartnerChannelState }>("/api/v1/channels/datafy"),
    staleTime: 15_000,
  });
}

export function useConnectGraphPartnerChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConnectGraphPartnerInput) =>
      apiClient.post<{ data: { connected: boolean; displayName: string; phoneNumber: string | null } }>(
        "/api/v1/channels/datafy",
        input,
      ),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["graph-partner-channel"] });
    },
  });
}
