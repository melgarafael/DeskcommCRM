"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { RuntimeIdentity, RuntimeConfirmation } from "@/lib/system/runtime-identity";
import type { RodadaDoBanco } from "@/lib/system/update-run";

export interface SystemVersion {
  current_version: string;
  identity?: RuntimeIdentity;
  runtime_services?: RuntimeConfirmation["services"] | null;
  manual_reconciliation_required?: boolean;
  /** O agente em execução confirmou suporte; ausência não autoriza força. */
  force_update_supported?: boolean;
  is_owner: boolean;
  latest_version?: string;
  official_latest_version?: string;
  update_available?: boolean;
  off_release?: boolean;
  /** O host não conseguiu comparar a versão instalada com a última publicada. */
  compare_failed?: boolean;
  /** O host já viu ao menos uma tag `v*` publicada neste repositório. */
  has_known_release?: boolean;
  agent_online?: boolean;
  /**
   * O retrato de `system_version` é VELHO demais para afirmar qualquer coisa
   * (#3488). `agent_online` responde "posso atualizar sozinho?" com 24h de
   * paciência; este campo responde "conferi isso agora?" com a régua da
   * frescura (`RETRATO_VELHO_APOS_MS`). É ele que impede a tela de dizer "é a
   * mais recente" com um retrato de horas atrás — ausente (resposta antiga)
   * mantém o comportamento anterior.
   */
  agent_stale?: boolean;
  /** Quando o host falou com o app pela última vez (ISO), para a tela dizer desde quando não sabe. */
  agent_last_seen_at?: string | null;
  /**
   * A instalação TEM SMTP usável (host E remetente, a mesma régua do kit).
   * Só chega a quem é dono do servidor (`is_platform_admin`) — é ele quem
   * configura em /admin/email. Fora do servidor único vem sempre `true`: lá o
   * login tem e-mail próprio e não há o que avisar.
   *
   * O painel de atualização mostra o aviso de "sem SMTP" a partir daqui
   * (#2755): o estado existe desde sempre, mas só no log do `update.sh`.
   */
  smtp_configured?: boolean;
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
    /** Quando o run fechou (ISO). `null` enquanto ele ainda está em curso. */
    finished_at?: string | null;
    /**
     * A volta foi feita pelo agente, sem ninguém pedir pela tela (#2757). É a
     * diferença entre "voltei" e "voltou sozinho", e ela é o assunto do aviso
     * que a tela mostra no desfecho `failed_rolled_back`.
     */
    volta_automatica?: boolean;
    /**
     * A falha deste run já foi superada por um deploy posterior (o host reporta
     * uma versão que o run não descreve). A tela deixa de mostrar o aviso dela.
     */
    superseded?: boolean;
    /**
     * O que a rodada contou sobre o banco — se a base estava ocupada (disputa),
     * quantas retentativas custou e em qual passada fechou. Vem da linha do run;
     * ausente quando ninguém mediu (rodada que não passou pelo banco), e a tela
     * fica calada nesse caso em vez de afirmar zero.
     */
    rodada_do_banco?: RodadaDoBanco | null;
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
