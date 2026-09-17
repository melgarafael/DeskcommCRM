"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

export interface OfficialChannelState {
  channel_session_id?: string | null;
  connected: boolean;
  /** Existe token gravado? O token em si NUNCA volta — ver a rota. */
  hasToken: boolean;
  phoneNumberId: string | null;
  wabaId: string | null;
  displayName: string | null;
  phoneNumber: string | null;
  status: string | null;
  webhook: {
    callbackUrl: string;
    verifyToken: string | null;
    /**
     * De onde vem o token que vale. `instalacao` = cadastrado na tela de
     * administração: existe, mas não volta num GET (foi mostrado uma vez, lá).
     * Opcional: ausente é lido como desconhecido, e a tela cai no aviso genérico.
     */
    verifyTokenOrigem?: "ambiente" | "instalacao" | null;
    /** Onde se cadastra o App da Meta — só para quem pode abrir a tela da instalação. */
    configurarEm?: string | null;
    fields: string[];
  } | null;
}

export interface ConnectInput {
  phone_number_id: string;
  waba_id: string;
  token: string;
}

export function useOfficialChannel() {
  return useQuery({
    queryKey: ["official-channel"],
    queryFn: async () => apiClient.get<{ data: OfficialChannelState }>("/api/v1/channels/official"),
    staleTime: 15_000,
  });
}

export function useConnectOfficialChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConnectInput) =>
      apiClient.post<{ data: { connected: boolean; displayName: string; phoneNumber: string | null } }>(
        "/api/v1/channels/official",
        input,
      ),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["official-channel"] });
    },
  });
}
