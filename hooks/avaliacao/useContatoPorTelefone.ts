"use client";

import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

export function useContatoPorTelefone(phone: string | null) {
  return useQuery({
    queryKey: ["avaliacao", "contato-por-telefone", phone],
    enabled: !!phone && phone.replace(/\D/g, "").length >= 8,
    queryFn: async () => {
      const r = await apiClient.get<{
        data: { contato: { id: string; name: string; phone_number: string } | null };
      }>(`/api/v1/avaliacao/contatos/por-telefone?phone=${encodeURIComponent(phone!)}`);
      return r.data.contato;
    },
    staleTime: 30_000,
  });
}
