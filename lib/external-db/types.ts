/**
 * Tipos compartilhados do conector de PostgreSQL externo.
 *
 * O schema do banco externo NÃO é espelhado em TypeScript gerado: ele muda com
 * frequência e cópia de schema envelhece. Estes tipos descrevem só o que o
 * conector precisa — a conexão decifrada e o retrato do catálogo lido ao vivo.
 */

/** Modos de TLS aceitos, alinhados ao CHECK de `external_db_connections.ssl_mode`. */
export type ModoTls = "disable" | "prefer" | "require" | "verify-ca" | "verify-full";

/**
 * Conexão já decifrada, pronta para abrir o pool.
 *
 * A senha vive só no escopo de quem chamou `carregarConexao()` — nunca é logada,
 * cacheada em claro ou devolvida por rota. `versao` (o `updated_at` da linha)
 * existe para invalidar o pool quando o cadastro muda: editar a conexão sem
 * derrubar o pool antigo manteria credencial velha viva em memória.
 */
export interface ConexaoExterna {
  id: string;
  organizationId: string;
  label: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslMode: ModoTls;
  /** Teto de linhas por consulta escolhido pela organização (`max_rows`). */
  maxRows: number;
  /** Teto de filtros por consulta (`max_filters`). */
  maxFilters: number;
  /** Teto de bytes da resposta devolvida ao modelo (`max_response_bytes`). */
  maxResponseBytes: number;
  versao: string;
}

/** Uma coluna do catálogo externo, na ordem em que aparece na tabela. */
export interface ColunaExterna {
  nome: string;
  tipo: string;
  nulavel: boolean;
  posicao: number;
}

/** Uma tabela ou view do banco externo, com as colunas do momento da leitura. */
export interface TabelaExterna {
  schema: string;
  nome: string;
  tipo: "tabela" | "view" | "outro";
  colunas: ColunaExterna[];
  /** Colunas da chave primária, na ordem do índice. Vazio em view/sem PK. */
  chavePrimaria: string[];
  /** Estimativa do planner (`pg_class.reltuples`), não uma contagem exata. */
  estimativaLinhas: number;
}

/** Operadores aceitos no filtro da consulta — vocabulário FECHADO, de propósito. */
export type OperadorDeFiltro =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contem"
  | "comeca_com"
  | "in"
  | "nulo"
  | "nao_nulo";

export interface FiltroDeLeitura {
  coluna: string;
  operador: OperadorDeFiltro;
  valor?: unknown;
}

export interface PedidoDeLeitura {
  schema: string;
  tabela: string;
  /** Vazio = todas as colunas (`*`). */
  colunas: string[];
  filtros: FiltroDeLeitura[];
  ordem?: { coluna: string; desc?: boolean };
  limite: number;
  offset: number;
}
