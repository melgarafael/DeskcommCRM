"use client";

import { useQuery } from "@tanstack/react-query";

import type { FechamentoDaGrade } from "@/lib/agenda/fechamentos-na-grade";
import { diaLocalISO } from "@/lib/agenda/fuso";
import { apiClient } from "@/lib/api/client";

const DIA_MS = 86_400_000;

/** A linha como `GET /api/v1/agenda/excecoes` devolve — lida do código da rota. */
interface ExcecaoListada {
  id: string;
  user_id: string;
  is_unavailable: boolean;
  reason: string | null;
  /** Acrescentados para a grade; servidor mais velho não os manda. */
  comeca?: string;
  termina?: string;
}

/**
 * As faixas FECHADAS de "Dias fora da rotina" que caem na janela da grade.
 *
 * A rota filtra por `exception_date`, que é o dia LOCAL da jornada de cada
 * pessoa — não o dia da grade. Por isso a busca leva um dia de margem de cada
 * lado (a mesma margem com que `consulta.ts` coleta as exceções), e quem recorta
 * pelo dia que a grade desenha é a própria grade.
 *
 * Só as FECHADAS: a faixa aberta ("abrir para atendimento") já aparece na grade
 * como horários oferecidos, que é o que ela significa.
 *
 * A chave começa por `["agenda"]` de propósito: "Dias fora da rotina" invalida
 * esse prefixo ao fechar ou reabrir, e a grade repinta sem recarregar.
 *
 * Falha aqui NÃO vira aviso na tela: a faixa é leitura acessória, e a oferta de
 * horários (que é o que importa ao cliente) não depende dela — quem decide é a
 * rota de horários livres, que lê as exceções por conta própria.
 */
export function useFechamentosDaGrade(recorte: { de: string; ate: string }, fuso: string) {
  const de = diaLocalISO(new Date(new Date(recorte.de).getTime() - DIA_MS), fuso);
  const ate = diaLocalISO(new Date(new Date(recorte.ate).getTime() + DIA_MS), fuso);
  return useQuery({
    queryKey: ["agenda", "excecoes", "grade", de, ate],
    queryFn: async (): Promise<FechamentoDaGrade[]> => {
      const qs = new URLSearchParams({ de, ate });
      const r = await apiClient.get<{ data: ExcecaoListada[] }>(
        `/api/v1/agenda/excecoes?${qs.toString()}`,
      );
      const lista =
        (r as unknown as { data?: ExcecaoListada[] }).data ??
        (r as unknown as ExcecaoListada[]);
      return (lista ?? []).flatMap((e) =>
        e.is_unavailable && e.comeca && e.termina
          ? [
              {
                id: e.id,
                responsavelId: e.user_id,
                comeca: e.comeca,
                termina: e.termina,
                motivo: e.reason,
              },
            ]
          : [],
      );
    },
  });
}
