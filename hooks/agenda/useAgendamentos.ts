"use client";

import { useQuery } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

import type { Agendamento } from "@/components/agenda/tipos";

/**
 * A forma que a rota devolve — lida do CÓDIGO dela, não da descrição.
 *
 * Os campos são `iniciaEm`/`terminaEm`/`donoId`, e não o `snake_case` que a
 * mensagem de handoff sugeria. Escrever contra o que uma mensagem descreve já me
 * custou duas vezes hoje (um import contra nome mencionado, uma frase de erro
 * contra o nome do código). O SHA da branch estava alcançável, então li lá.
 */
interface AgendamentoListado {
  id: string;
  titulo: string;
  iniciaEm: string;
  terminaEm: string;
  fuso: string;
  situacao: string;
  donoId: string | null;
  contatoId: string | null;
  contatoNome: string | null;
}

export interface RecorteDaGrade {
  /** INSTANTE ISO com offset — nunca o filtro `dia`. Ver o comentário abaixo. */
  de: string;
  ate: string;
  owner_user_id?: string;
}

/**
 * Os agendamentos de um período.
 *
 * ## Por que `de`/`ate` e NUNCA `dia`
 *
 * A rota também aceita `dia=YYYY-MM-DD`, e ele corta em **UTC**. Medido pelo
 * autor enquanto escrevia: para America/Sao_Paulo, pedir o dia 12 devolve de
 * 11/03 21:00 a 12/03 20:59 na parede de quem olha — três horas do dia anterior
 * ENTRAM, e as três últimas do dia pedido FICAM DE FORA. Um compromisso das 22h
 * some da lista do próprio dia.
 *
 * Mandando INSTANTE, quem calcula o começo e o fim é a tela, no fuso de
 * APRESENTAÇÃO — o mesmo `AuthUser.timezone` que a página já resolve. A rota não
 * precisa adivinhar em que fuso o dia foi pedido, e o instante vira a moeda
 * entre a regra (num fuso) e a apresentação (noutro).
 *
 * E a grade é semanal/mensal: o filtro por dia exigiria sete requisições para
 * desenhar uma semana, mesmo se o fuso não fosse problema.
 *
 * ## O 422 sem recorte NÃO é erro de sistema
 *
 * Sem período, a rota devolve 422 `agenda_listagem_sem_recorte` em vez de lista
 * vazia — e está certa: vazio faria a grade dizer "nada marcado" quando a
 * verdade é que a pergunta não tinha alvo. Por isso `enabled` só dispara com o
 * recorte montado: um 422 previsível não deve virar toast na cara de quem abriu
 * a tela.
 */
export function useAgendamentos(recorte: RecorteDaGrade | null) {
  return useQuery({
    queryKey: ["agenda", "agendamentos", recorte],
    enabled: recorte !== null,
    queryFn: async (): Promise<Agendamento[]> => {
      const qs = new URLSearchParams({ de: recorte!.de, ate: recorte!.ate });
      if (recorte!.owner_user_id) qs.set("owner_user_id", recorte!.owner_user_id);
      try {
        const r = await apiClient.get<{ data: AgendamentoListado[] }>(
          `/api/v1/agenda/agendamentos?${qs.toString()}`,
        );
        const lista =
          (r as unknown as { data?: AgendamentoListado[] }).data ??
          (r as unknown as AgendamentoListado[]);
        return (lista ?? []).map((a) => ({
          id: a.id,
          titulo: a.titulo,
          responsavelId: a.donoId ?? "",
          comeca: a.iniciaEm,
          termina: a.terminaEm,
          // A origem vem da ROTA, e não é mais carimbada aqui.
          //
          // Era `"ui"` fixo, e isso apagava a única coisa que distingue um bloco
          // de ocupação do Google de um agendamento nosso — a grade usa a origem
          // para desabilitar o clique, tirar o arraste e dizer "ocupado na
          // agenda do Google" no rótulo acessível.
          //
          // `?? "ui"` mantém o fio tolerante a servidor mais velho que o
          // cliente, como já faz o `quemSeraAtendido` logo abaixo.
          origem: (a as { origem?: Agendamento["origem"] }).origem ?? "ui",
          situacao: a.situacao as Agendamento["situacao"],
          // Sem esta linha, montar o hook REGREDIRIA o conserto do "com quem":
          // a prop do servidor traz o nome, e o refetch o apagaria da grade.
          // Campo novo é optional e a rota pode ainda não mandá-lo — `?? undefined`
          // mantém o wire tolerante a servidor mais velho que o cliente.
          quemSeraAtendido: a.contatoNome ?? undefined,
        }));
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
  });
}
