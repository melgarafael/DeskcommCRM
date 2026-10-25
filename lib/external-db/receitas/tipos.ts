/**
 * RECEITA PRONTA do banco externo: um JOIN pré-escrito e revisado, por família
 * (woocommerce, wordpress), mais o schema dos parâmetros que o admin preenche
 * na tela (`fixos`) e do que o agente preenche na conversa (`parametrosDaBusca`).
 *
 * A receita NÃO tem SQL livre: ela monta `sql + valores` com placeholders `?`,
 * e o prefixo das tabelas é o ÚNICO pedaço de texto que entra no SQL — já
 * validado por regex e quotado com crase, nunca cru. O validador em
 * `validador.ts` é a segunda trava.
 */
import type { z } from "zod";

export type MotorReceita = "mysql" | "postgres";
export type FamiliaReceita = "woocommerce" | "wordpress" | "tabela-direta";

export interface DefinicaoDeReceita {
  /** Identificador estável da receita (ex.: "woocommerce-produtos"). */
  id: string;
  /** Família a que pertence — decide onde o código dela mora. */
  familia: FamiliaReceita;
  /** Motores em que roda. woocommerce é só MySQL nesta fatia. */
  motores: MotorReceita[];
  /** Rótulo em português que o admin vê na tela. */
  rotulo: string;
  /**
   * A linha de apoio da tela de escolha (uma frase). A `descricao` longa é o
   * que o AGENTE lê; esta é o que a PESSOA lê para escolher.
   */
  resumo?: string;
  /** O que o agente lê para decidir se usa esta instância (até 300 chars). */
  descricao: string;
  /** O que o admin preenche na tela (ex.: prefixo das tabelas do WordPress). */
  parametrosFixos: z.ZodTypeAny;
  /** O que o agente preenche na conversa (ex.: busca, preço máximo). Strict. */
  parametrosDaBusca: z.ZodTypeAny;
  /**
   * Os FILTROS que a instância aceita, derivados dos fixos.
   *
   * A receita `wordpress-conteudo` tem o conjunto de filtros dependente do
   * que a pessoa mapeou: o mesmo id de receita filtra "ano" numa instância de
   * veículos e "bairro" numa de imóveis. Sem esta descrição, o agente chuta o
   * nome do filtro. As receitas de conjunto fixo não implementam — para elas o
   * Zod da busca já diz tudo.
   */
  descreverFiltros?: (fixos: unknown) => string;
  /**
   * As tabelas que o JOIN lê, com os FIXOS já validados.
   *
   * Recebe os fixos (e não o prefixo) porque a receita pode precisar de mais do
   * que o prefixo: a `wordpress-conteudo` só libera as tabelas de taxonomia
   * (`terms`, `term_taxonomy`, `term_relationships`) quando o administrador
   * mapeou ALGUMA categoria — quem não usa categoria não precisa liberá-las.
   */
  tabelas: (fixos: unknown) => string[];
  /** Por tabela, as colunas que o JOIN usa — entra na lista de fontes liberadas. */
  colunas: (fixos: unknown) => Record<string, string[]>;
  /** Monta `{ sql, valores }` a partir de fixos + busca + limite. Valor só por `?`. */
  montar: (fixos: unknown, busca: unknown, limite: number) => { sql: string; valores: unknown[] };
  /** Teto absoluto de itens desta fatia (5: o C2 de tokens não foi medido). */
  tetoDeItens: number;
}

/** O resultado de montar: SQL com placeholders e os valores ligados. */
export type ConsultaMontadaReceita = { sql: string; valores: unknown[] };

/** Uma instância gravada: receita escolhida + parâmetros preenchidos na tela. */
export interface InstanciaDeReceita {
  id: string; // uuid
  receita: string; // id da receita no registro
  rotulo: string; // 1..80
  descricao: string; // 0..300
  fixos: unknown; // validado pelo parametrosFixos da receita escolhida
  ativa: boolean;
}
