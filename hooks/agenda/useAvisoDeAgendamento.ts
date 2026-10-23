"use client";
/**
 * O AVISO DE AGENDAMENTO NO WHATSAPP — o lado do cliente.
 *
 * O desenho é o de `hooks/ai/useAvisoDeCaso.ts`, e pelas mesmas razões
 * escritas lá: sem `refetchInterval` (é tela de configuração, uma re-consulta
 * atropelaria o campo meio digitado), um GET só para a tela inteira, e o PUT
 * escreve no cache o estado que devolve.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { EstadoDaTelaDoAvisoDeAgendamento } from "@/lib/agenda/tela-do-aviso-de-agendamento";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import type { MotivoDoTeste } from "@/lib/escalacao/aviso-de-teste";

export const CHAVE_DO_AVISO_DE_AGENDAMENTO = ["agenda-aviso-de-agendamento"] as const;

export interface ResultadoDoTesteDeAgendamento {
  enviado: boolean;
  destinoMascarado?: string;
  codigo?: MotivoDoTeste;
  liberaEm?: string;
}

/** Repete só o que é passageiro (5xx, rede); `4xx` é veredito. */
export function useAvisoDeAgendamento() {
  return useQuery({
    queryKey: CHAVE_DO_AVISO_DE_AGENDAMENTO,
    retry: (tentativas, erro) => {
      const status = erro instanceof ApiError ? erro.status : null;
      if (status !== null && status >= 400 && status < 500) return false;
      return tentativas < 2;
    },
    retryDelay: (tentativa) => 800 * (tentativa + 1),
    queryFn: () =>
      apiClient
        .get<{ data: EstadoDaTelaDoAvisoDeAgendamento }>("/api/v1/agenda/aviso")
        .then((r) => r.data),
  });
}

export interface EntradaDoSalvarAvisoDeAgendamento {
  usa_numero_do_aviso_de_caso: boolean;
  channel_session_id?: string | null;
  telefone?: string | null;
  ligado: boolean;
  /** `true` = "eu sei que esse número é um cliente meu, e quero mesmo assim". */
  confirma_contato?: boolean;
}

export function useSalvarAvisoDeAgendamento() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (entrada: EntradaDoSalvarAvisoDeAgendamento) =>
      apiClient
        .put<{ data: EstadoDaTelaDoAvisoDeAgendamento }>("/api/v1/agenda/aviso", entrada)
        .then((r) => r.data),
    onSuccess: (estado) => {
      qc.setQueryData(CHAVE_DO_AVISO_DE_AGENDAMENTO, estado);
    },
  });
}

export function useTestarAvisoDeAgendamento() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiClient
        .post<{ data: ResultadoDoTesteDeAgendamento }>(
          "/api/v1/agenda/aviso/teste",
          {},
          // O envio passa pelo transporte de terceiro; 30s de default não cobre
          // a fila de condições antes dele.
          { timeoutMs: 45_000 },
        )
        .then((r) => r.data),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: CHAVE_DO_AVISO_DE_AGENDAMENTO });
    },
  });
}
