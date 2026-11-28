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
import type { ValoresDoPeriodo } from "@/lib/metrics/valores-do-periodo";

export interface MetaDoMes {
  id: string;
  /** #4796: a meta do vendedor é a mais estreita das três. */
  escopo: "empresa" | "funil" | "vendedor";
  /** #4796: `vendas_ganhas` (contagem) ou `valor_vendido` (centavos). */
  indicador: "vendas_ganhas" | "valor_vendido";
  pipeline_id: string | null;
  pipeline_nome: string | null;
  /** #4796: dono da meta individual; `null` na meta da empresa/funil. */
  vendedor_id: string | null;
  /** #4796: moeda do alvo em valor; `null` na meta por quantidade. */
  moeda: string | null;
  alvo: number;
  realizado: number;
  percentual: number;
  falta: number;
  atingida: boolean;
  /** #4796: projeção até o fim da janela no ritmo medido; `null` sem o que projetar. */
  projecao: number | null;
  /** #4796: em valor, a soma veio de leitura paginada e pode ser um piso. */
  realizado_truncado: boolean;
}

export interface MetasDoMes {
  window: { from: string; to: string };
  periodo: string;
  /** Só quando todas as metas do mês têm o mesmo indicador; senão `null`. */
  indicador: string | null;
  /** #4796: os indicadores presentes no mês. */
  indicadores: string[];
  metas: MetaDoMes[];
  /**
   * As DUAS parcelas do período (fatia 2, item 1, da #3602): vendido único ×
   * recorrência nova mensal. Vem sempre — inclusive sem meta cadastrada — e
   * nunca traz um total somado: somar as duas é o defeito que a issue descreve.
   */
  valores_do_periodo: ValoresDoPeriodo;
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
    // Quem acabou de salvar a meta em Configurações volta ao Desempenho e tem
    // de ver o número novo — não o de antes enquanto relê (#4796). A meta muda
    // fora desta tela, então sair dela descarta o cache e a volta lê de novo,
    // com o estado de carregando que o painel já tem.
    gcTime: 0,
  });
}
