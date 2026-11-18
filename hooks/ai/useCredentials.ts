"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { PROVEDORES, ProvedorComChave } from "@/lib/ai/pontos/provedores";
import type { PROVEDORES_DE_SERVICO } from "@/lib/ai/pontos/provedores-de-servico";

/**
 * Derivado de `lib/ai/pontos/provedores.ts` — a lista única desde a migration
 * 0127. Como literal fixo aqui, a tela de Credenciais não tinha como cadastrar
 * OpenRouter, embora o painel de Provedores a oferecesse.
 */
export type Provider = (typeof PROVEDORES)[number]["id"];

/** Irmão de `Provider`, para quem não conversa com o cliente (voz, hoje). */
export type ServiceProvider = (typeof PROVEDORES_DE_SERVICO)[number]["id"];

export interface CredentialRow {
  id: string;
  organization_id: string;
  /**
   * A união, não `Provider`: a linha pode ser a chave do Jev, que não conversa,
   * ou a de um serviço de voz. `Provider` segue sendo só quem conversa — é o que
   * o agente escolhe.
   */
  provider: ProvedorComChave | ServiceProvider;
  label: string;
  // `ai_provider_credentials.api_key_last4` é `text NOT NULL` no baseline: os
  // quatro dígitos são gravados junto com a chave e nunca somem. Declarar
  // `| null` aqui era o TypeScript mentindo sobre a coluna — e o mentiroso é o
  // lado que não dá para o `tsc` conferir (o dado entra por `as unknown as`).
  // Cobrado por `tests/invariants/tipo-de-coluna-x-typescript.test.ts`.
  api_key_last4: string;
  validated_at: string | null;
  validation_error: string | null;
  models_available: string[] | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface ListResponse {
  data: CredentialRow[];
}

export const credentialsListQueryKey = ["ai", "credentials", "list"] as const;

export function useCredentialsList(opts?: { initialData?: CredentialRow[] }) {
  return useQuery({
    queryKey: credentialsListQueryKey,
    queryFn: async () => {
      try {
        const res = await apiClient.get<ListResponse>("/api/v1/ai/credentials");
        return res.data;
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    initialData: opts?.initialData,
    // Enquanto alguma credencial está "validando", a tela precisa ver o resultado
    // (ou a janela vencer) sem F5: o status é derivado de `created_at` + relógio,
    // e nada re-renderiza sozinho quando o relógio cruza a janela.
    refetchInterval: (query) =>
      query.state.data?.some((c) => credentialStatus(c) === "validating") ? 5_000 : false,
  });
}

/** Depois disto sem resultado, o processo que validaria já morreu. */
export const JANELA_DE_VALIDACAO_MS = 2 * 60_000;

export type CredentialStatus = "validated" | "validating" | "unvalidated" | "invalid" | "inactive";

export function credentialStatus(row: CredentialRow, agora: number = Date.now()): CredentialStatus {
  if (!row.is_active) return "inactive";
  if (row.validation_error) return "invalid";
  if (row.validated_at) return "validated";
  if (agora - Date.parse(row.created_at) > JANELA_DE_VALIDACAO_MS) return "unvalidated";
  return "validating";
}
