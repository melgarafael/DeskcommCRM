"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { ContaDeAnuncio, LinhaDeCampanha } from "@/lib/plataformas-de-anuncio/types";

/**
 * Os dois hooks da tela de Meta Ads.
 *
 * ─── Por que `retry: false` nos dois ────────────────────────────────────────
 *
 * Cada tentativa custa cota na plataforma — 2 chamadas por leitura de campanhas
 * (o endpoint de insights não traz `effective_status`, então status vem de uma
 * segunda requisição). O react-query re-tentaria 3 vezes por padrão, e uma
 * falha de token — que NENHUMA tentativa consertaria — viraria 6 chamadas
 * gastas para chegar à mesma mensagem. A conta sondada está em
 * `development_access`, onde a cota é justa.
 *
 * ─── Por que `staleTime: 0` e nada de refetch automático ────────────────────
 *
 * A tela promete leitura sob demanda: o botão se chama "Atualizar" e é o único
 * gatilho. `refetchOnWindowFocus` ligado faria a tabela se atualizar sozinha ao
 * voltar de outra aba — gastando cota que o operador não pediu para gastar, e
 * mudando números embaixo do olho de quem estava comparando duas linhas.
 */

export interface ContasResposta {
  contas: ContaDeAnuncio[];
  conta_padrao: string | null;
}

export interface CampanhasResposta {
  campanhas: LinhaDeCampanha[];
  periodo: { from: string; to: string };
  account_id: string;
  lido_em: string;
}

/** As contas alcançadas pelo token. Muda raramente — daí o `staleTime` alto. */
export function useMetaAdAccounts(enabled: boolean) {
  return useQuery({
    queryKey: ["ads", "meta", "accounts"],
    queryFn: async () => apiClient.get<{ data: ContasResposta }>("/api/v1/ads/meta/accounts"),
    enabled,
    // 5 minutos: a lista de contas de um token não muda durante uma sessão de
    // trabalho, e recarregá-la a cada troca de período gastaria cota à toa.
    staleTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

interface ParametrosDeCampanhas {
  contaId: string | null;
  de: string;
  ate: string;
}

/**
 * A tabela do período.
 *
 * `enabled` só quando há conta escolhida: sem ela a rota devolveria 422 de
 * validação, e um erro de parâmetro apareceria na tela como se fosse problema da
 * plataforma.
 */
export function useMetaCampaigns({ contaId, de, ate }: ParametrosDeCampanhas) {
  return useQuery({
    queryKey: ["ads", "meta", "campaigns", contaId, de, ate],
    queryFn: async () => {
      const qs = new URLSearchParams({ account_id: contaId as string, from: de, to: ate });
      return apiClient.get<{ data: CampanhasResposta }>(`/api/v1/ads/meta/campaigns?${qs}`, {
        // ⚠️ OBRIGATÓRIO, não afinação. O `DEFAULT_TIMEOUT_MS` do apiClient é
        // 10s, e esta rota espera DUAS chamadas à plataforma cujo teto próprio
        // (`TEMPO_LIMITE_MS` em `insights.ts`) já é 20s cada. Com o padrão, uma
        // conta grande abortaria no cliente enquanto o servidor ainda esperava
        // — e o operador leria "erro de rede" numa leitura que ia dar certo,
        // depois de ela ter gasto a cota do mesmo jeito.
        timeoutMs: 45_000,
      });
    },
    enabled: Boolean(contaId),
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
