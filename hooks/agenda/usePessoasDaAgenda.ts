"use client";

import { useQuery } from "@tanstack/react-query";

import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { ROTA_DA_LISTA_DE_PESSOAS, motivoDaFalhaNaLista } from "@/lib/agenda/lista-de-pessoas";
import { trilhasDaEquipe } from "@/lib/agenda/tipos";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { idiomaAtual } from "@/lib/i18n/IdiomaProvider";

import { rotuloDoResponsavel } from "@/lib/agenda/identidade-do-responsavel";

import type { Pessoa } from "@/components/agenda/tipos";

interface MembroDto {
  user_id: string;
  role: string;
  full_name: string | null;
  display_label?: string;
  revoked_at?: string | null;
}

/**
 * As pessoas da equipe, com a trilha de cor de cada uma.
 *
 * A cor NÃO vem da API: vem de `trilhaPadraoDoMembro(user_id)`, que deriva do id de
 * forma estável. É por isso que a pessoa não troca de cor entre um carregamento
 * e outro, nem quando alguém novo entra na equipe — e é o motivo de este hook
 * não precisar de nenhuma coluna de cor no banco.
 *
 * Quem foi revogado sai da lista: o filtro por pessoa é para quem atende hoje, e
 * uma agenda com ex-funcionário na barra confunde sem informar.
 */
export function usePessoasDaAgenda() {
  return useQuery({
    queryKey: ["agenda", "pessoas"],
    queryFn: async (): Promise<Pessoa[]> => {
      try {
        const r = await apiClient.get<{ data: MembroDto[] }>(ROTA_DA_LISTA_DE_PESSOAS);
        const lista =
          (r as unknown as { data?: MembroDto[] }).data ?? (r as unknown as MembroDto[]);
        const ativos = (lista ?? []).filter((m) => !m.revoked_at);
        // As trilhas saem da EQUIPE inteira de uma vez, não pessoa a pessoa: é a
        // única forma de garantir que duas pessoas não caiam na mesma cor. O
        // hash sozinho dá estabilidade e não dá distinção — medido, duas caíram
        // na trilha 7 nesta organização.
        const trilhas = trilhasDaEquipe(ativos.map((m) => m.user_id));
        return ativos.map((m) => ({
          id: m.user_id,
          // Só o rótulo mínimo resolvido no servidor; ID e trilha continuam os mesmos.
          nome: rotuloDoResponsavel(m.user_id, m.display_label, m.full_name,
            (texto) => traduzir(texto, idiomaAtual())),
          trilha: trilhas.get(m.user_id) ?? 1,
        }));
      } catch (err) {
        // O 403 desta lista chegava como "Você não tem permissão para esta
        // ação", sem dizer QUAL permissão nem que a grade continuava lá — era o
        // defeito do item 1 da issue 896. Agora a agenda diz de que leitura se
        // trata e o que segue funcionando; os outros erros ficam com o aviso
        // padrão, que para eles já é informativo.
        if (err instanceof ApiError && (err.status === 403 || err.status === 401)) {
          toast.warning(traduzir(motivoDaFalhaNaLista(err.status), idiomaAtual()));
        } else {
          showApiError(err);
        }
        throw err;
      }
    },
  });
}
