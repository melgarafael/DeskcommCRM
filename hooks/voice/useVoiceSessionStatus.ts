"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

interface VoiceSessionStatus {
  configured: boolean;
  channelSessionId: string | null;
  status: string | null;
  paired: boolean;
  jid: string | null;
}

/** Estado do pareamento de chamada de voz da org — decide se o discador aparece. */
export function useVoiceSessionStatus() {
  return useQuery({
    queryKey: ["voice", "session-status"],
    queryFn: () => apiClient.get<{ data: VoiceSessionStatus }>("/api/v1/voice/sessions/status"),
    // Feature opt-in: não vale a pena refetch agressivo, e um erro (feature
    // desligada em algum ambiente) não pode virar spinner infinito na tela do
    // contato — cai no fallback de "não mostrar o botão" via `select` abaixo.
    staleTime: 60_000,
    select: (res) => res.data,
  });
}
