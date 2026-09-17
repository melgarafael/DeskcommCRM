"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { CreateContactResult } from "@/app/api/v1/contacts/_handler";
import type { ContactCreate } from "@/lib/schemas/contacts";

/**
 * ⚠️ O ENVELOPE TEM DOIS ANDARES, E O DE DENTRO NÃO É O CONTATO.
 *
 * `POST /api/v1/contacts` devolve `ok(createContactHandler(...))`, e `ok()` já
 * embrulha: o corpo é `{ data: { contact, action } }`. Este genérico dizia
 * `{ data: Contact }` — uma afirmação que ninguém checava, porque o tipo é um
 * `cast` sobre JSON e não uma ligação com a rota. Quem lesse `resposta.data`
 * receberia o envelope do handler e acharia que tinha o contato: `id` e `name`
 * saem `undefined`, sem erro nenhum.
 *
 * O `import type` do handler é a ligação que faltava: se a rota mudar de forma,
 * quem lê aqui para de compilar em vez de ler `undefined` em produção.
 */
export function useCreateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ContactCreate) =>
      apiClient.post<{ data: CreateContactResult; meta?: { action?: string } }>(
        "/api/v1/contacts",
        input,
      ),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
    },
  });
}
