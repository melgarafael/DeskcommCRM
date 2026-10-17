/**
 * RECEITA PRONTA do banco externo: um JOIN pré-escrito e revisado, por família
 * (woocommerce, acf-imoveis, jetengine-imoveis, tabela-direta), mais o schema
 * dos parâmetros que o admin preenche na tela (`fixos`) e do que o agente
 * preenche na conversa (`parametrosDaBusca`).
 *
 * A receita NÃO tem SQL livre: ela monta `sql + valores` com placeholders `?`,
 * e o prefixo das tabelas é o ÚNICO pedaço de texto que entra no SQL — já
 * validado por regex e quotado com crase, nunca cru. O validador em
 * `validador.ts` é a segunda trava.
 */
import type { z } from "zod";

export type MotorReceita = "mysql" | "postgres";
export type FamiliaReceita = "woocommerce";

export interface DefinicaoDeReceita {
  /** Identificador estável da receita (ex.: "woocommerce-produtos"). */
  id: string;
  /** Família a que pertence — decide onde o código dela mora. */
  familia: FamiliaReceita;
  /** Motores em que roda. woocommerce é só MySQL nesta fatia. */
  motores: MotorReceita[];
  /** Rótulo em português que o admin vê na tela. */
  rotulo: string;
  /** O que o agente lê para decidir se usa esta instância (até 300 chars). */
  descricao: string;
  /** O que o admin preenche na tela (ex.: prefixo das tabelas do WordPress). */
  parametrosFixos: z.ZodTypeAny;
  /** O que o agente preenche na conversa (ex.: busca, preço máximo). Strict. */
  parametrosDaBusca: z.ZodTypeAny;
  /** As tabelas que o JOIN lê, com o prefixo aplicado. */
  tabelas: (prefixo: string) => string[];
  /** Por tabela, as colunas que o JOIN usa — entra na lista de fontes liberadas. */
  colunas: (prefixo: string) => Record<string, string[]>;
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
