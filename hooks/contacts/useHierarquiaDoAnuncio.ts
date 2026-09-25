"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

/**
 * O nome da campanha, do conjunto e do anúncio — pedido À PARTE do contato.
 *
 * Separado porque a espera é outra: a ficha abre com o que já está no banco, e
 * este pedido pode custar uma chamada à plataforma de anúncios. Junto no contato,
 * a ficha inteira aguardaria a Meta responder.
 *
 * Sem `showApiError`, ao contrário de `useContact`: a falha aqui é a ausência de
 * três rótulos, não a da tela. Um toast vermelho para dizer que o nome da
 * campanha não veio assusta mais do que informa — e a ficha continua inteira,
 * mostrando o id do anúncio, que é o que ela mostrava antes desta feature.
 */
interface HierarquiaDoAnuncio {
  ad_name: string | null;
  adset_name: string | null;
  campaign_name: string | null;
}

export function useHierarquiaDoAnuncio(contactId: string, habilitado: boolean) {
  return useQuery({
    queryKey: ["contact", contactId, "hierarquia-do-anuncio"],
    enabled: Boolean(contactId) && habilitado,
    // O outro lado já guarda por sete dias. Repetir o pedido a cada foco de
    // janela gastaria round-trip para receber a mesma linha do cache.
    staleTime: 5 * 60 * 1000,
    retry: false,
    queryFn: async () => {
      const r = await apiClient.get<{ data: HierarquiaDoAnuncio }>(
        `/api/v1/contacts/${contactId}/hierarquia-do-anuncio`,
      );
      return r.data;
    },
  });
}
