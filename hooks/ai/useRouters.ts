"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export interface RouterListItem {
  id: string;
  name: string;
  channel_session_id: string;
  is_active: boolean;
  fallback_agent_id: string | null;
  member_count: number;
  updated_at: string;
}

export interface RouterMember {
  id: string;
  agent_id: string;
  intent_name: string;
  intent_description: string;
  examples: string[];
  position: number;
  /** Fluxo de atendimento que começa quando a intenção casa. `null` = só agente. */
  flow_pointer_id: string | null;
}

export interface RouterMemberInput {
  agent_id: string;
  intent_name: string;
  intent_description: string;
  examples: string[];
  flow_pointer_id: string | null;
}

export interface RouterDetail {
  id: string;
  name: string;
  channel_session_id: string;
  is_active: boolean;
  config: Record<string, unknown>;
  fallback_agent_id: string | null;
}

export interface RouterDetailState {
  router: RouterDetail;
  members: RouterMember[];
}

export interface RouterTestResult {
  intent_name: string | null;
  /**
   * `null` quando NÃO houve veredito — não é zero. O tipo importa mais que a
   * rota: ele é o que todo consumidor novo importa, e um `number` aqui faria a
   * mentira passar com o aval do typecheck.
   */
  confidence: number | null;
  min_confidence: number;
  agent_id: string | null;
  agent_name: string | null;
  /**
   * O Jev na mesma frase, quando a tarefa do roteador dele roda. `null` com ela
   * desligada; ausente na resposta da imagem anterior.
   */
  jev?: {
    estado: "observando" | "decidindo";
    respondeu: boolean;
    intent_name: string | null;
    /** A probabilidade da escolha dele; `null` quando ele não respondeu. */
    confidence: number | null;
    agent_id: string | null;
    agent_name: string | null;
    /** Em produção valeria a escolha dele (decidindo, e com a IA de sempre respondendo). */
    decide: boolean;
  } | null;
}

export interface CreateRouterInput {
  name: string;
  channel_session_id: string;
  fallback_agent_id?: string | null;
}

export interface UpdateRouterInput {
  name?: string;
  is_active?: boolean;
  fallback_agent_id?: string | null;
  /** Mesclada com a config existente pelo PATCH — mandar um campo não apaga os outros. */
  config?: Record<string, unknown>;
}

const LIST_KEY = ["routers"];
const detailKey = (id: string) => ["router", id];

export function useRouters(initial?: { routers: RouterListItem[] }) {
  return useQuery({
    queryKey: LIST_KEY,
    ...(initial !== undefined ? { initialData: initial } : {}),
    queryFn: () =>
      apiClient.get<{ data: { routers: RouterListItem[] } }>("/api/v1/ai/routers").then((r) => r.data),
  });
}

export function useRouter(id: string, initial?: RouterDetailState) {
  return useQuery({
    queryKey: detailKey(id),
    ...(initial !== undefined ? { initialData: initial } : {}),
    queryFn: () =>
      apiClient
        .get<{ data: RouterDetailState }>(`/api/v1/ai/routers/${encodeURIComponent(id)}`)
        .then((r) => r.data),
  });
}

export function useCreateRouter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRouterInput) =>
      apiClient.post<{ data: { id: string } }>("/api/v1/ai/routers", input).then((r) => r.data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: LIST_KEY }),
  });
}

export function useUpdateRouter(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateRouterInput) =>
      apiClient
        .patch<{ data: { id: string } }>(`/api/v1/ai/routers/${encodeURIComponent(id)}`, patch)
        .then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LIST_KEY });
      void qc.invalidateQueries({ queryKey: detailKey(id) });
    },
  });
}

export function useDeleteRouter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<{ data: { id: string } }>(`/api/v1/ai/routers/${encodeURIComponent(id)}`).then((r) => r.data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: LIST_KEY }),
  });
}

export function useSaveMembers(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (members: RouterMemberInput[]) =>
      apiClient
        .put<{ data: { count: number } }>(`/api/v1/ai/routers/${encodeURIComponent(id)}/members`, { members })
        .then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LIST_KEY });
      void qc.invalidateQueries({ queryKey: detailKey(id) });
    },
  });
}

export function useTestRouter(id: string) {
  return useMutation({
    mutationFn: (message: string) =>
      apiClient
        .post<{ data: RouterTestResult }>(`/api/v1/ai/routers/${encodeURIComponent(id)}/test`, { message })
        .then((r) => r.data),
  });
}
