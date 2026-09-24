/**
 * Contratos de entrada do conector de banco externo (Zod).
 *
 * Lugar único: a rota HTTP e a futura tool do agente validam o MESMO vocabulário.
 * Se divergirem, uma passa a aceitar `ssl_mode` que a outra recusa — e o modo de
 * falha aparece só em produção, quando alguém cola um valor que a tela ofereceu.
 */
import { z } from "zod";

import { PAPEIS_COLUNA } from "./catalogo";
import { LIMITE_FILTROS, LIMITE_LINHAS, LIMITE_PADRAO_DA_GRADE, LIMITE_RESPOSTA_BYTES } from "./limites";

/** Espelha o CHECK de `external_db_connections.ssl_mode` e `ModoTls`. */
export const MODOS_TLS = ["disable", "prefer", "require", "verify-ca", "verify-full"] as const;

const modoTls = z.enum(MODOS_TLS);

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
  })
  .strict();

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
  })
  .strict();

const colunaDoCatalogo = z.string().trim().min(1).max(128);

/**
 * Mapeamento do catálogo do agente (migration 0244): qual tabela do banco
 * externo e quais colunas são nome/ano/cor/km/preço/imagem/estoque. `col_nome` é
 * obrigatória (é o que casa com o termo do cliente); as demais são opcionais.
 * `busca_operador` espelha o CHECK de `catalog_mappings`.
 */
export const salvarCatalogoSchema = z
  .object({
    connection_id: z.string().uuid(),
    schema_name: z.string().trim().min(1).max(128).default("public"),
    table_name: z.string().trim().min(1).max(128),
    col_nome: colunaDoCatalogo,
    col_versao: colunaDoCatalogo.optional(),
    col_ano: colunaDoCatalogo.optional(),
    col_cor: colunaDoCatalogo.optional(),
    col_km: colunaDoCatalogo.optional(),
    col_preco: colunaDoCatalogo.optional(),
    col_imagem: colunaDoCatalogo.optional(),
    col_estoque: colunaDoCatalogo.optional(),
    col_cilindrada: colunaDoCatalogo.optional(),
    col_tipo: colunaDoCatalogo.optional(),
    busca_operador: z.enum(["contem", "eq", "comeca_com"]).default("contem"),
    enabled: z.boolean().default(true),
    // Regras do catálogo (migration 0245).
    similaridade_deterministica: z.boolean().default(false),
    similares_qtd: z.number().int().min(1).max(8).default(3),
    // Prioridade por papel (1 = mais importante). Chaves = PAPEIS_COLUNA.
    // Usa `z.record(string, ...)` de propósito: `z.record(z.enum(...), ...)` no
    // Zod 4 exige TODAS as chaves no default, o que impediria `{}`.
    // PRIORIDADE EMPATADA é permitida (ex.: `nome` e `versao` ambos = 1) — é o
    // que faz o nome exibido ser a junção dos dois.
    ordem: z.record(z.string(), z.number().int().min(1).max(9)).default({}),
    // Colunas (por NOME) que aparecem na legenda enviada JUNTO com a foto
    // (0250/0251). Independente do papel: pode incluir coluna sem papel. Vazio =
    // comportamento antigo (ano/cor/km/preço).
    legenda: z.array(z.string().trim().min(1).max(128)).max(60).default([]),
    // Configuração POR COLUNA (migration 0251): o que o agente faz com cada
    // coluna. Vazio = derivar da configuração antiga (papéis + legenda + ordem).
    colunas: z
      .array(
        z
          .object({
            coluna: colunaDoCatalogo,
            ia: z.boolean().default(false),
            criterio: z.boolean().default(false),
            mostrar: z.boolean().default(false),
            comparar: z.boolean().default(false),
            ordem: z.number().int().min(1).max(9).optional(),
            compoe_nome: z.boolean().default(false),
          })
          .strict(),
      )
      .max(200)
      .default([]),
    // Coluna de REFERÊNCIA de motos similares (ex.: moto_similar). Usada SÓ no
    // motor; nunca vai para a IA nem para o cliente.
    col_similares: colunaDoCatalogo.optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const papeisValidos = new Set<string>(PAPEIS_COLUNA);
    for (const [papel] of Object.entries(val.ordem)) {
      if (!papeisValidos.has(papel)) {
        ctx.addIssue({ code: "custom", path: ["ordem"], message: `papel desconhecido: ${papel}` });
      }
    }
  });

export type SalvarCatalogoInput = z.infer<typeof salvarCatalogoSchema>;

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
