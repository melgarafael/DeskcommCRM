"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

/**
 * "Não são a mesma empresa": grava a dispensa do par no servidor, só gestor.
 * Quem chama trata o 403 e o resto (o erro da API já chega com código).
 */
export function useDispensarParecido() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (contactIds: [string, string]) =>
      apiClient.post<{ data: { candidates: string[]; criada: boolean } }>(
        "/api/v1/contacts/duplicates/dismiss",
        { contact_ids: contactIds },
      ),
    onSuccess: () => {
      // Sem a dispensa refletida na lista, o par continuaria na seção
      // "Parecidos — confira" até o próximo refresh manual.
      qc.invalidateQueries({ queryKey: ["contacts", "duplicates"] });
    },
  });
}
