"use client";

import { useQuery } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

/**
 * O que `/api/v1/agenda/horarios-livres` devolve — e três dos cinco campos
 * existem para a tela poder ser HONESTA em vez de só correta.
 *
 * `publicou_horarios` distingue "você ainda não publicou seus horários" de "não
 * há vaga neste período". Sem ele os dois chegam como a mesma lista vazia, e a
 * tela diria "nenhum horário disponível" para quem nunca configurou nada — uma
 * resposta verdadeira e inútil, que deixa a pessoa procurando vaga onde não há
 * agenda (decisão 1.1 da entrega).
 *
 * `fuso_suposto` avisa que ninguém escolheu o fuso: veio do padrão. Importa
 * porque o agente oferece horário usando ele.
 *
 * `fontes_defasadas` diz que uma agenda conectada parou de atualizar. O horário
 * fica bloqueado de qualquer jeito — falhar fechado na AÇÃO —, e a tela pode
 * dizer desde quando, que é falhar aberto na INFORMAÇÃO.
 */
export interface HorariosLivresResposta {
  slots: Array<{ inicio: string; fim: string }>;
  fuso_da_regra: string;
  publicou_horarios: boolean;
  fuso_suposto: boolean;
  google_cobertura_parcial?: boolean;
  fontes_defasadas?: Array<{ nome?: string; desde?: string }>;
}

export interface HorariosLivresFiltro {
  event_type_id: string;
  owner_user_id?: string;
  /** ISO-8601. */
  de: string;
  ate: string;
}

/**
 * `enabled` desligado enquanto não houver tipo de agendamento: sem ele a rota
 * responde 422, e um 422 previsível não deve virar toast de erro na cara de
 * quem só abriu a tela.
 */
export function useHorariosLivres(filtro: HorariosLivresFiltro | null) {
  return useQuery({
    queryKey: ["agenda", "horarios-livres", filtro],
    enabled: filtro !== null,
    queryFn: async () => {
      const qs = new URLSearchParams({
        event_type_id: filtro!.event_type_id,
        de: filtro!.de,
        ate: filtro!.ate,
      });
      if (filtro!.owner_user_id) qs.set("owner_user_id", filtro!.owner_user_id);
      try {
        const r = await apiClient.get<{ data: HorariosLivresResposta }>(
          `/api/v1/agenda/horarios-livres?${qs.toString()}`,
        );
        // `ok()` embrulha em `data` — desembrulhar aqui evita que cada tela
        // repita o caminho e erre em uma delas.
        return (r as unknown as { data: HorariosLivresResposta }).data ?? (r as unknown as HorariosLivresResposta);
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
  });
}
