"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

export interface SystemVersion {
  current_version: string;
  is_owner: boolean;
  latest_version?: string;
  update_available?: boolean;
  off_release?: boolean;
  /** O host não conseguiu comparar a versão instalada com a última publicada. */
  compare_failed?: boolean;
  /** O host já viu ao menos uma tag `v*` publicada neste repositório. */
  has_known_release?: boolean;
  agent_online?: boolean;
  /**
   * A atualização terminou bem e o host ainda não confirmou (janela de até 5
   * min). Fora dela é `false` — o campo se fecha sozinho.
   */
  just_updated?: boolean;
  notes?: {
    /** Um por versão da faixa que tem aviso, do mais novo ao mais antigo. */
    requires_attention: Array<{ version: string; texto: string }>;
    /** Todas as seções entre a versão no ar e a alvo, da mais nova à mais antiga. */
    sections: Array<{ version: string; body: string }>;
    /** `false`: o texto recebido pode não alcançar a versão instalada. */
    complete: boolean;
  } | null;
  run?: {
    id: string;
    status: string;
    last_step: string | null;
    /** Quando o pedido foi registrado — a tela conta o tempo a partir daqui. */
    dispatched_at?: string;
    /** Versão que estava instalada quando o run começou. */
    from_version: string;
    /** Versão que o run tentou instalar. */
    to_version: string;
    /** Últimas linhas da saída do update.sh — o diagnóstico da falha. */
    log_tail: string;
  } | null;
}

/**
 * Estado da versão desta instalação. Fonte única do rodapé da sidebar e da
 * tela de atualização. Poll folgado (5 min) porque o agente do host só reporta
 * a cada 5 min — bater mais rápido não traria informação nova.
 */
export function useSystemVersion(opts?: { refetchInterval?: number }) {
  return useQuery({
    queryKey: ["system-version"],
    queryFn: async () => {
      const res = await apiClient.get<{ data: SystemVersion }>("/api/v1/system/version");
      return res.data;
    },
    staleTime: 60_000,
    refetchInterval: opts?.refetchInterval ?? 5 * 60_000,
  });
}
