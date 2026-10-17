"use client";
import { usePermission } from "@/hooks/auth/AuthProvider";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { TipoDeRecurso } from "@/lib/inbox/recursos";
import type { MidiaDeTemplate } from "@/lib/templates/midias";

export interface MessageTemplate {
  id: string;
  title: string;
  body: string;
  shortcut: string | null;
  owner_user_id: string | null;
  /**
   * "texto" ou "audio" (migration 0662).
   *
   * Opcional como `midias`: linha anterior à 0662 e fixture anterior ao PR vêm
   * sem a chave, e as duas são "texto" — o default da coluna no banco. Quem lê
   * trata a ausência com `?? "texto"`, e nenhum dos dois casos quebra.
   */
  tipo?: TipoDeRecurso;
  /** Caminho do arquivo no Storage — só para recursos de áudio. */
  media_path?: string | null;
  media_mime?: string | null;
  media_size_bytes?: number | null;
  /**
   * As imagens que o próprio operador carregou no template (#2526).
   * Opcional de propósito: linha anterior à migration 0643 e fixture de teste
   * vêm sem a chave, e as duas são "só texto" — nenhum dos dois casos pode
   * quebrar quem lê.
   */
  midias?: MidiaDeTemplate[] | null;
}

/** Onda 5: templates de script (pessoais + compartilhados) para o slash-menu do composer. */
export function useMessageTemplates() {
  const podeConsultar = usePermission("message-templates.view");
  return useQuery({
    enabled: podeConsultar,
    queryKey: ["message-templates"],
    queryFn: async () => apiClient.get<{ data: MessageTemplate[] }>("/api/v1/message-templates"),
    staleTime: 60_000,
    select: (res) => res.data,
  });
}
