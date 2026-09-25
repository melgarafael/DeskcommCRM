"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import type { EstadoDaChave } from "@/components/ai/ChaveDeConhecimento";

export interface SourceRow {
  id: string;
  /** HISTÓRICO desde a 0181: de qual assistente o material nasceu. Não é dono. */
  agent_id: string | null;
  organization_id: string;
  source_type: string;
  name: string;
  status: "ready" | "archived" | "failed" | "building" | string | null;
  /**
   * `indexando` e `sem_credencial` entraram na 0181: são os dois estados que o
   * produto já produzia e a tela mostrava como "Não indexado", neutro.
   */
  last_index_status:
    | "success"
    | "failed"
    | "partial"
    | "indexando"
    | "sem_credencial"
    | null;
  last_index_error: string | null;
  last_indexed_at: string | null;
  chunks_count: number;
  is_active: boolean;
  source_metadata: Record<string, unknown>;
  active_kb_version_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ListResponse {
  data: SourceRow[];
}

export const sourcesQueryKey = () => ["ai", "knowledge", "sources"] as const;
export const chaveQueryKey = () => ["ai", "knowledge", "chave"] as const;

/**
 * Os materiais da ORGANIZAÇÃO.
 *
 * Era por agente e filtrava a lista em memória (`.filter(s => s.agent_id ===
 * agentId)`) — o que, somado à tela resolver o agente por `is_default`, fazia
 * todo material de assistente não-padrão ser invisível.
 */
export function useKnowledgeSources(opts?: { initialData?: SourceRow[] }) {
  return useQuery({
    queryKey: sourcesQueryKey(),
    queryFn: async () => {
      try {
        const res = await apiClient.get<ListResponse>("/api/v1/ai/knowledge/sources");
        return res.data ?? [];
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    ...(opts?.initialData ? { initialData: opts.initialData } : {}),
  });
}

/**
 * Dá para indexar? Com qual chave? É o que a tela precisa dizer ANTES do cadastro.
 *
 * ## Por que isto tem `refetchInterval`
 *
 * A validação da chave com o provedor acontece EM SEGUNDO PLANO — `guardarCredencial`
 * responde assim que cifra e grava, e só depois confirma com a OpenAI. Entre os
 * dois momentos a chave existe e ainda não é utilizável, então a tela continua
 * dizendo "falta uma chave" para quem acabou de colá-la. Medido na prova de
 * tela: a credencial estava no banco e validada, e a tela seguia mostrando o
 * aviso — só um F5 mudava.
 *
 * O intervalo é ligado APENAS nesse estado transitório: existe credencial OpenAI
 * e ela ainda não serve. Fora dele o polling seria custo sem informação.
 */
export function useEstadoDaChave(initial?: EstadoDaChave) {
  return useQuery({
    queryKey: chaveQueryKey(),
    queryFn: async () => {
      const res = await apiClient.get<{ data: EstadoDaChave }>("/api/v1/ai/knowledge/chave");
      return res.data;
    },
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d) return false;
      const esperandoValidacao = !d.pode_indexar && d.credenciais_openai.length > 0;
      return esperandoValidacao ? 2_000 : false;
    },
    ...(initial ? { initialData: initial } : {}),
  });
}

export function useReindexSource() {
  const t = useT();
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["ai", "knowledge", "sources", "reindex"],
    mutationFn: async (id: string) => {
      const res = await apiClient.post<{ data: { id: string; queued: true } }>(
        `/api/v1/ai/knowledge/sources/${id}/reindex`,
        {},
      );
      return res.data;
    },
    onSuccess: () => {
      toast.success(t("Vou preparar este material de novo — leva alguns instantes."));
    },
    onError: (err) => showApiError(err),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: sourcesQueryKey() });
    },
  });
}

export function useReindexAll() {
  const t = useT();
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["ai", "knowledge", "sources", "reindex-all"],
    mutationFn: async () => {
      const res = await apiClient.post<{
        data: { total: number; prioridade1: number; prioridade2: number; emitidos: number };
      }>("/api/v1/ai/knowledge/reindex-all", {});
      return res.data;
    },
    onSuccess: (r) => {
      toast.success(
        r.total === 0
          ? t("Não há material para reindexar.")
          : t("Vou preparar o que falta e o que mudou; o material sem alteração é pulado."),
      );
    },
    onError: (err) => showApiError(err),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: sourcesQueryKey() });
    },
  });
}

export function useArquivarSource() {
  const t = useT();
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["ai", "knowledge", "sources", "arquivar"],
    mutationFn: async (id: string) => {
      await apiClient.delete(`/api/v1/ai/knowledge/sources/${id}`);
      return id;
    },
    onSuccess: () => {
      toast.success(t("Material arquivado. O agente para de consultá-lo."));
    },
    onError: (err) => showApiError(err),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: sourcesQueryKey() });
    },
  });
}
