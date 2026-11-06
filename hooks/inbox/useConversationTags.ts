"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Conversation } from "@/lib/types/messaging";

interface UpdateTagsArgs {
  conversation_id: string;
  tags: string[];
}

/** G3-05: aplica/remove tags de uma conversa via PATCH; refaz o inbox. */
export function useUpdateConversationTags() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: UpdateTagsArgs) =>
      apiClient.patch<{ data: Conversation }>(
        `/api/v1/conversations/${args.conversation_id}`,
        { tags: args.tags },
      ),
    onError: (err) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      showApiError(err);
    },
    onSuccess: (_data, args) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", args.conversation_id] });
      // Gravar tag é o que ALIMENTA o vocabulário (`staleTime` de 5 min): sem
      // reler, o marcador recém-criado não aparece no filtro do Inbox nem nas
      // sugestões até a página recarregar. O lado do contato já relia (#852).
      qc.invalidateQueries({ queryKey: ["conversation-tag-vocabulary"] });
    },
  });
}

/**
 * G3-05: vocabulário canônico de tags de conversa da org (sugestões).
 * Via server route — o cookie de sessão é HttpOnly, então o browser-supabase
 * não autentica; a leitura org-scoped passa pelo servidor.
 */
export function useConversationTagVocabulary(orgId: string | null, busca = "") {
  return useQuery({
    queryKey: ["conversation-tag-vocabulary", orgId, busca],
    enabled: !!orgId,
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }): Promise<string[]> => {
      const res = busca
        ? await apiClient.get<{ data: string[] }>("/api/v1/conversation-tags?busca="+encodeURIComponent(busca), { signal })
        : await apiClient.get<{ data: string[] }>("/api/v1/conversation-tags");
      return res.data;
    },
  });
}
