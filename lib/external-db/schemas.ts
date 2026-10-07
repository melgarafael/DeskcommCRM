/**
 * Contratos de entrada do conector de banco externo (Zod).
 *
 * Lugar único: a rota HTTP e a futura tool do agente validam o MESMO vocabulário.
 * Se divergirem, uma passa a aceitar `ssl_mode` que a outra recusa — e o modo de
 * falha aparece só em produção, quando alguém cola um valor que a tela ofereceu.
 */
import { z } from "zod";

import { LIMITE_FILTROS, LIMITE_LINHAS, LIMITE_PADRAO_DA_GRADE, LIMITE_RESPOSTA_BYTES } from "./limites";

/** Espelha o CHECK de `external_db_connections.ssl_mode` e `ModoTls`. */
export const MODOS_TLS = ["disable", "prefer", "require", "verify-ca", "verify-full"] as const;

const modoTls = z.enum(MODOS_TLS);

/**
 * Qual dado do contato identifica o cliente numa tabela do banco externo.
 * Espelha o CHECK de `external_db_connections.customer_key_kind`.
 */
export const TIPOS_DE_IDENTIFICADOR = ["phone", "email"] as const;
export type TipoDeIdentificador = (typeof TIPOS_DE_IDENTIFICADOR)[number];

const camposDeConexao = {
  label: z.string().trim().min(1).max(80),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  database_name: z.string().trim().min(1).max(128),
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(2048),
  ssl_mode: modoTls,
  enabled: z.boolean(),
  /** Limites de leitura configuráveis — faixa igual à do CHECK no banco. */
  max_rows: z.number().int().min(LIMITE_LINHAS.minimo).max(LIMITE_LINHAS.maximo),
  max_filters: z.number().int().min(LIMITE_FILTROS.minimo).max(LIMITE_FILTROS.maximo),
  max_response_bytes: z
    .number()
    .int()
    .min(LIMITE_RESPOSTA_BYTES.minimo)
    .max(LIMITE_RESPOSTA_BYTES.maximo),
  /**
   * A coluna que identifica o cliente e o dado do contato que ela guarda. Os
   * dois juntos ou nenhum (o CHECK do banco diz o mesmo): sem eles, a consulta
   * do agente durante a conversa segue sem o filtro do cliente.
   */
  customer_key_column: z.string().trim().min(1).max(128).nullable(),
  customer_key_kind: z.enum(TIPOS_DE_IDENTIFICADOR).nullable(),
};

/** Coluna e tipo andam juntos: um sem o outro não identifica ninguém. */
function chaveDoClienteCompleta(v: {
  customer_key_column?: string | null;
  customer_key_kind?: string | null;
}): boolean {
  const coluna = v.customer_key_column;
  const tipo = v.customer_key_kind;
  return (coluna === undefined) === (tipo === undefined) && (coluna == null) === (tipo == null);
}

const CHAVE_INCOMPLETA = {
  path: ["customer_key_column"],
  message: "customer_key_column e customer_key_kind vêm juntos, ou nenhum dos dois",
};

/** Criação: exige os campos essenciais; porta, TLS e `enabled` têm default. */
export const criarConexaoSchema = z
  .object({
    label: camposDeConexao.label,
    host: camposDeConexao.host,
    port: camposDeConexao.port.default(5432),
    database_name: camposDeConexao.database_name,
    username: camposDeConexao.username,
    password: camposDeConexao.password,
    ssl_mode: camposDeConexao.ssl_mode.default("require"),
    enabled: camposDeConexao.enabled.default(true),
    max_rows: camposDeConexao.max_rows.default(LIMITE_LINHAS.padrao),
    max_filters: camposDeConexao.max_filters.default(LIMITE_FILTROS.padrao),
    max_response_bytes: camposDeConexao.max_response_bytes.default(LIMITE_RESPOSTA_BYTES.padrao),
    customer_key_column: camposDeConexao.customer_key_column.default(null),
    customer_key_kind: camposDeConexao.customer_key_kind.default(null),
  })
  .strict()
  .refine(chaveDoClienteCompleta, CHAVE_INCOMPLETA);

/**
 * Atualização parcial. `password` é opcional: ausente = não mexer na senha
 * guardada; presente = recifrar. Nunca aceitamos as colunas cifradas cruas.
 */
export const atualizarConexaoSchema = z
  .object({
    label: camposDeConexao.label.optional(),
    host: camposDeConexao.host.optional(),
    port: camposDeConexao.port.optional(),
    database_name: camposDeConexao.database_name.optional(),
    username: camposDeConexao.username.optional(),
    password: camposDeConexao.password.optional(),
    ssl_mode: camposDeConexao.ssl_mode.optional(),
    enabled: camposDeConexao.enabled.optional(),
    max_rows: camposDeConexao.max_rows.optional(),
    max_filters: camposDeConexao.max_filters.optional(),
    max_response_bytes: camposDeConexao.max_response_bytes.optional(),
    customer_key_column: camposDeConexao.customer_key_column.optional(),
    customer_key_kind: camposDeConexao.customer_key_kind.optional(),
  })
  .strict()
  .refine(chaveDoClienteCompleta, CHAVE_INCOMPLETA);

/**
 * Leitura paginada. Sem FILTRO de propósito: filtro carrega VALOR, valor carrega
 * PII, e querystring vai para log de proxy. A consulta filtrada da IA passa pelo
 * núcleo `lib/external-db` direto (Fase 5), não por aqui.
 */
export const leituraQuerySchema = z
  .object({
    // O teto ABSOLUTO; o teto efetivo é o `max_rows` da conexão, aplicado na rota.
    limit: z.coerce.number().int().min(1).max(LIMITE_LINHAS.maximo).default(LIMITE_PADRAO_DA_GRADE),
    offset: z.coerce.number().int().min(0).default(0),
    order_by: z.string().trim().min(1).max(128).optional(),
    order_desc: z.enum(["true", "false", "1", "0"]).optional(),
    /** Projeção separada por vírgula. Vazio = todas as colunas. */
    colunas: z.string().max(4000).optional(),
  })
  .strict();
