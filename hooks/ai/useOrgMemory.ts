"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export interface OrgMemoryDocument {
  version_id: string;
  version_number: number;
  content: string;
  created_at: string;
}
export interface OrgMemoryVersionMeta {
  id: string;
  version_number: number;
  created_at: string;
}
/**
 * Quem escreveu o aprendizado. Espelha `org_memory_entries_source_check` (0385):
 * `agent` é o que a ferramenta MCP `crm_save_org_memory` grava. Par cobrado por
 * tests/unit/memoria-da-org-origem-cabe-no-check.test.ts.
 */
export type OrigemDaMemoria = "manual" | "flywheel" | "agent";

export interface OrgMemoryEntryRow {
  id: string;
  title: string;
  body: string;
  source: OrigemDaMemoria;
  status: "active" | "archived";
  created_at: string;
  /**
   * Último dia em que o aprendizado vale (`YYYY-MM-DD`, no fuso da
   * organização). `null` = sem prazo. Vencido, ele deixa de entrar no prompt
   * dos agentes — é o que faz a programação da semana passada sair sozinha.
   */
  valid_until: string | null;
}
export interface OrgMemoryState {
  document: OrgMemoryDocument | null;
  versions: OrgMemoryVersionMeta[];
  entries: OrgMemoryEntryRow[];
}
export interface OrgMemoryVersionDetail {
  id: string;
  version_number: number;
  content: string;
  created_at: string;
}

const KEY = ["org-memory"] as const;

/**
 * A MEMÓRIA DA EMPRESA — e a empresa vai na CHAVE (#4171).
 *
 * Com a chave global (`["org-memory"]`), o `initialData` que o servidor acabou
 * de ler é DESCARTADO sempre que já existe cache para aquele nome: o cache de
 * uma visita anterior (ou de outra empresa, na troca de organização sem reload)
 * vence o estado fresco, e a tela mostra memória vazia com a versão publicada
 * existindo. Com a empresa na chave, o cache de uma não responde pela outra, e
 * o que o servidor leu é o que aparece.
 */
export function useOrgMemory(initialData: OrgMemoryState, orgId: string) {
  return useQuery({
    queryKey: [...KEY, orgId],
    initialData,
    queryFn: () => apiClient.get<{ data: OrgMemoryState }>("/api/v1/ai/memory").then((r) => r.data),
  });
}

export function usePublishOrgMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (content: string) =>
      apiClient.post<{ data: { version_id: string; version_number: number } }>("/api/v1/ai/memory", { content }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useCreateOrgMemoryEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { title: string; body: string; valid_until?: string | null }) =>
      apiClient.post<{ data: { id: string } }>("/api/v1/ai/memory/entries", input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useSetOrgMemoryEntryStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; status: "archived" | "active" }) =>
      apiClient.patch<{ data: { id: string; status: string } }>(`/api/v1/ai/memory/entries/${input.id}`, { status: input.status }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

/**
 * #2369 — o prazo do aprendizado. `null` tira o prazo (o aprendizado volta a
 * valer para sempre), que é o que a tela faz ao limpar o campo.
 */
export function useSetOrgMemoryEntryValidity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; valid_until: string | null }) =>
      apiClient.patch<{ data: { id: string; valid_until: string | null } }>(
        `/api/v1/ai/memory/entries/${input.id}`,
        { valid_until: input.valid_until },
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

/** Conteúdo de uma versão do histórico, buscado sob demanda ao abrir o Dialog. */
export function useOrgMemoryVersion(id: string | null) {
  return useQuery({
    queryKey: ["org-memory-version", id],
    enabled: id !== null,
    queryFn: () =>
      apiClient
        .get<{ data: OrgMemoryVersionDetail }>(`/api/v1/ai/memory/versions/${id}`)
        .then((r) => r.data),
  });
}
