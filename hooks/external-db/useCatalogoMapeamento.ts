"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

export type OperadorDeBusca = "contem" | "eq" | "comeca_com";

export type PapelColuna =
  | "nome"
  | "versao"
  | "ano"
  | "cor"
  | "km"
  | "preco"
  | "imagem"
  | "estoque"
  | "cilindrada"
  | "tipo";

export type OrdemPorPapel = Partial<Record<PapelColuna, number>>;

/** Configuração de UMA coluna (migration 0251). */
export interface ColunaConfigDTO {
  coluna: string;
  /** Valor enviado à IA como contexto. */
  ia: boolean;
  /** A IA pode usar como filtro na consulta ampla. */
  criterio: boolean;
  /** Aparece na legenda que vai com a foto. */
  mostrar: boolean;
  /** O motor usa para ordenar as semelhantes. */
  comparar: boolean;
  /** Prioridade (1 = mais importante). */
  ordem?: number;
  /** Entra no nome exibido (ex.: nome + versão). */
  compoe_nome: boolean;
  /** PREFIXO do nome, em maiúsculas (ex.: `marca` → "YAMAHA FZ 15 ..."). */
  prefixo_nome?: boolean;
}

/** Linha de `catalog_mappings` como a API devolve (snake_case). */
export interface CatalogoMapeamentoDTO {
  connection_id: string;
  schema_name: string;
  table_name: string;
  col_nome: string;
  col_versao: string | null;
  col_ano: string | null;
  col_cor: string | null;
  col_km: string | null;
  col_preco: string | null;
  col_imagem: string | null;
  col_estoque: string | null;
  col_cilindrada: string | null;
  col_tipo: string | null;
  busca_operador: OperadorDeBusca;
  enabled: boolean;
  similaridade_deterministica: boolean;
  /** LEGADO: a quantidade agora mora na config do AGENTE. */
  similares_qtd?: number;
  ordem: OrdemPorPapel;
  /** Colunas (por nome) que aparecem na legenda enviada com a foto. */
  legenda: string[];
  /** Configuração POR COLUNA (migration 0251). */
  colunas?: ColunaConfigDTO[];
  /** Coluna de REFERÊNCIA de motos similares (ex.: moto_similar). */
  col_similares?: string | null;
  updated_at?: string;
}

/** Corpo do PUT — só as chaves preenchidas (o schema da API é estrito). */
export interface SalvarCatalogoBody {
  connection_id: string;
  schema_name: string;
  table_name: string;
  col_nome: string;
  col_versao?: string;
  col_ano?: string;
  col_cor?: string;
  col_km?: string;
  col_preco?: string;
  col_imagem?: string;
  col_estoque?: string;
  col_cilindrada?: string;
  col_tipo?: string;
  busca_operador: OperadorDeBusca;
  enabled: boolean;
  similaridade_deterministica: boolean;
  /** LEGADO: a quantidade agora mora na config do AGENTE. */
  similares_qtd?: number;
  ordem: OrdemPorPapel;
  /** Colunas (por nome) que aparecem na legenda enviada com a foto. */
  legenda: string[];
  /** Configuração POR COLUNA (migration 0251). */
  colunas?: ColunaConfigDTO[];
  /** Coluna de REFERÊNCIA de motos similares (ex.: moto_similar). */
  col_similares?: string;
}

export const catalogoMapeamentoQueryKey = ["external-db", "catalog"] as const;

/** GET /api/v1/external-db/catalog — mapeamento ativo da organização (ou null). */
export function useCatalogoMapeamento(enabled = true) {
  return useQuery({
    queryKey: catalogoMapeamentoQueryKey,
    enabled,
    queryFn: () =>
      apiClient
        .get<{ data: { mapping: CatalogoMapeamentoDTO | null } }>("/api/v1/external-db/catalog")
        .then((r) => r.data.mapping),
  });
}

/** PUT /api/v1/external-db/catalog — grava/atualiza o mapeamento. */
export function useSalvarCatalogoMapeamento() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SalvarCatalogoBody) => apiClient.put("/api/v1/external-db/catalog", body),
    onSettled: () => qc.invalidateQueries({ queryKey: catalogoMapeamentoQueryKey }),
  });
}
