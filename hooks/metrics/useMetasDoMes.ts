"use client";

/**
 * A meta do mês e o progresso contra ela (issue #3025, fatia 1).
 *
 * Uma leitura só: `/api/v1/metrics/metas` devolve o ALVO e o REALIZADO da
 * MESMA janela (dois pedidos separados seriam duas janelas, e a conta fecharia
 * errado na virada do mês). A chave da query carrega a janela porque trocar de
 * mês troca a resposta.
 *
 * `motivo: "sem_meta"` NÃO é erro e não é um zero: é ausência de cadastro, e
 * quem explica isso é a tela (o `explicacao` da rota já vem no idioma de quem
 * pediu). Nunca traduzir aqui o que o servidor já decidiu.
 */
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

export interface MetaDoMes {
  id: string;
  escopo: "empresa" | "funil";
  pipeline_id: string | null;
  pipeline_nome: string | null;
  alvo: number;
  realizado: number;
  percentual: number;
  falta: number;
  atingida: boolean;
}

export interface MetasDoMes {
  window: { from: string; to: string };
  periodo: string;
  indicador: string;
  metas: MetaDoMes[];
  motivo: "sem_meta" | null;
  explicacao: string | null;
}

export function useMetasDoMes(janela: { from: string; to: string }) {
  const qs = `?from=${encodeURIComponent(janela.from)}&to=${encodeURIComponent(janela.to)}`;
  return useQuery({
    queryKey: ["metrics", "metas", janela.from, janela.to],
    queryFn: async () =>
      apiClient.get<{ data: MetasDoMes }>(`/api/v1/metrics/metas${qs}`),
    staleTime: 30_000,
  });
}
