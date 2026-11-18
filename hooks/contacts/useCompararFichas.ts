"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { LinkExibivel } from "@/lib/leads/links-de-contato";

/**
 * Uma ficha lado a lado com a outra, para decidir antes de juntar.
 *
 * Os campos de prospecção (`prospeccao`) vêm de `prospecting_candidates`, que
 * só o servidor lê. Por isso a comparação é um GET da API e não uma consulta
 * direta: a tela nunca fala com essa tabela.
 */
export interface FichaParaComparar {
  id: string;
  nome: string | null;
  name: string | null;
  display_name: string | null;
  address_book_name: string | null;
  phone_number: string | null;
  email: string | null;
  source: string;
  maps_url: string | null;
  created_at: string;
  last_activity_at: string | null;
  conversas: number;
  negocios: number;
  links: LinkExibivel[];
  prospeccao: {
    categorias: string[];
    enderecos: string[];
    sites: string[];
    redes: string[];
    emails: string[];
    telefones: string[];
    maps: string[];
  };
}

interface CompararResponse {
  data: { contatos: FichaParaComparar[] };
}

/**
 * Só roda com um par de ids (`enabled` quando há par). O erro NÃO vira toast
 * aqui: quem chama mostra o erro dentro da própria comparação, com "Tentar de
 * novo", para não duplicar o aviso.
 */
export function useCompararFichas(ids: [string, string] | null) {
  return useQuery({
    queryKey: ["contacts", "compare", ids?.[0] ?? null, ids?.[1] ?? null],
    enabled: ids !== null,
    refetchOnWindowFocus: false,
    queryFn: () =>
      apiClient.get<CompararResponse>(
        `/api/v1/contacts/compare?ids=${encodeURIComponent(ids!.join(","))}`,
      ),
  });
}
