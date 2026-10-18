"use client";
import { usePermission } from "@/hooks/auth/AuthProvider";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { PixKeyType } from "@/lib/schemas/pix";

export interface PixKey {
  id: string;
  name: string;
  key_type: PixKeyType;
  key_value: string;
  owner_user_id: string | null;
  organization_id: string;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export const PIX_KEYS_QUERY = ["pix-keys"] as const;

/** Chaves Pix da org ativa (pessoais + compartilhadas), para config e composer. */
export function usePixKeys() {
  const podeConsultar = usePermission("pix-keys.view");
  return useQuery({
    enabled: podeConsultar,
    queryKey: PIX_KEYS_QUERY,
    queryFn: async () => apiClient.get<{ data: PixKey[] }>("/api/v1/pix-keys"),
    staleTime: 60_000,
    select: (res) => res.data,
  });
}
