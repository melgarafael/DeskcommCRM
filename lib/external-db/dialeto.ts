/**
 * O DIALETO de uma conexão: o ÚNICO caminho por onde o assistente, o MCP externo,
 * a grade e o Testar do prompt leem o banco externo.
 *
 * Ele nasce LIGADO à conexão (pool + regra de fontes liberadas). Por isso a regra
 * de visibilidade é aplicada AQUI, uma vez — nenhuma tool nem rota decide o que
 * é visível, e uma rota nova que use o dialeto herda a regra sem lembrar dela.
 *
 * A regra mora em `criarDialetoDeLeitura` e cada motor entrega as suas
 * `OperacoesDoMotor` (PostgreSQL aqui, MySQL em `dialetos/mysql/dialeto.ts`).
 */
import type pg from "pg";

import { aplicarAoCatalogo, colunasLiberadas, tabelaLiberada, type RegraDeFontes } from "./fontes";
import { descreverTabela, listarTabelas } from "./introspeccao";
import { LeituraInvalidaError, lerTabela, type ResultadoDeLeitura } from "./leitura";
import { validarConsultaDeReceita } from "./receitas/validador";
import type { PedidoDeLeitura, TabelaExterna } from "./types";

/** A leitura pediu uma tabela que o administrador não liberou. */
export class FonteNaoLiberadaError extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = "FonteNaoLiberadaError";
  }
}

export interface Dialeto {
  /** O catálogo como o assistente e a grade o veem (já com as fontes aplicadas). */
  listarTabelas(): Promise<TabelaExterna[]>;
  /** As colunas liberadas para projeção, filtro e ordenação; `null` = não existe OU não liberada. */
  colunasDaTabela(schema: string, tabela: string): Promise<Set<string> | null>;
  lerTabela(
    pedido: PedidoDeLeitura,
    permitidas: ReadonlySet<string>,
    opcoes?: { limiteMax?: number },
  ): Promise<ResultadoDeLeitura>;
  /** SÓ para a tela de marcação (administrador): o catálogo inteiro, ignorando as fontes. */
  catalogoCompleto(): Promise<TabelaExterna[]>;
  /** O "schema" (banco, no MySQL) das tabelas de receita. O caller não escolhe. */
  schemaDasReceitas(): string;
  /**
   * Executa uma receita pronta (JOIN revisado): tabelas e colunas já foram
   * checadas contra as fontes liberadas pelo chamador (criarDialetoDeLeitura).
   * Devolve as linhas já serializadas, cortadas em `limiteMax`, com `truncado`.
   */
  executarReceita(
    consulta: { sql: string; valores: unknown[]; tabelas: string[]; colunasPorTabela: Record<string, string[]> },
    opcoes: { limiteMax: number },
  ): Promise<ResultadoDeLeitura & { truncado: boolean }>;
}

/** O que cada motor sabe fazer; a regra das fontes liberadas é aplicada POR CIMA, uma vez só. */
export interface OperacoesDoMotor {
  listarTabelas(): Promise<TabelaExterna[]>;
  descreverTabela(schema: string, tabela: string): Promise<TabelaExterna | null>;
  lerTabela(
    pedido: PedidoDeLeitura,
    permitidas: ReadonlySet<string>,
    opcoes?: { limiteMax?: number },
  ): Promise<ResultadoDeLeitura>;
  /** O "schema" (banco, no MySQL) das tabelas de receita. O caller não escolhe. */
  schemaDasReceitas(): string;
  executarReceita(
    consulta: { sql: string; valores: unknown[]; tabelas: string[]; colunasPorTabela: Record<string, string[]> },
    opcoes: { limiteMax: number },
  ): Promise<ResultadoDeLeitura & { truncado: boolean }>;
}

export function criarDialetoDeLeitura(op: OperacoesDoMotor, regra: RegraDeFontes): Dialeto {
  return {
    catalogoCompleto: () => op.listarTabelas(),
    schemaDasReceitas: () => op.schemaDasReceitas(),

    listarTabelas: async () => aplicarAoCatalogo(regra, await op.listarTabelas()),

    colunasDaTabela: async (schema, tabela) => {
      // Fora da lista nem chega a consultar o banco de origem.
      if (!tabelaLiberada(regra, schema, tabela)) return null;
      return colunasLiberadas(regra, await op.descreverTabela(schema, tabela));
    },

    lerTabela: async (pedido, permitidas, opcoes) => {
      if (!tabelaLiberada(regra, pedido.schema, pedido.tabela)) {
        throw new FonteNaoLiberadaError("fonte_nao_liberada");
      }
      if (regra.modo === "list") {
        // Sem coluna nenhuma visível não há o que ler — e a projeção vazia viraria `*`.
        if (permitidas.size === 0) throw new FonteNaoLiberadaError("sem_colunas_liberadas");
        // Em `list` a projeção é SEMPRE explícita: nunca `select *` numa fonte com colunas restritas.
        const colunas = pedido.colunas.length === 0 ? [...permitidas] : pedido.colunas;
        return op.lerTabela({ ...pedido, colunas }, permitidas, opcoes);
      }
      return op.lerTabela(pedido, permitidas, opcoes);
    },

    executarReceita: async (consulta, opcoes) => {
      // O schema das tabelas de receita vem do MOTOR, nunca do caller. No MySQL é
      // o banco da conexão; fontes são marcadas com esse schema no catálogo.
      const schema = op.schemaDasReceitas();

      // Ponto único de aplicação da regra de fontes liberadas: toda tabela da
      // receita deve estar liberada antes de chegar ao motor.
      for (const tabela of consulta.tabelas) {
        if (!tabelaLiberada(regra, schema, tabela)) {
          throw new FonteNaoLiberadaError("fonte_nao_liberada");
        }
      }

      // Em modo `list`, toda coluna que a receita usa precisa estar entre as
      // colunas liberadas da fonte (tabela do catálogo). Senão, nenhuma linha.
      if (regra.modo === "list") {
        for (const tabela of consulta.tabelas) {
          const colunasPermitidas = colunasLiberadas(
            regra,
            await op.descreverTabela(schema, tabela),
          );
          if (colunasPermitidas === null || colunasPermitidas.size === 0) {
            throw new FonteNaoLiberadaError("sem_colunas_liberadas");
          }
          const colunasDaReceita = consulta.colunasPorTabela[tabela] ?? [];
          for (const coluna of colunasDaReceita) {
            if (!colunasPermitidas.has(coluna)) {
              throw new FonteNaoLiberadaError("sem_colunas_liberadas");
            }
          }
        }
      }

      // Segunda trava: validador SELECT-only com as tabelas permitidas da receita.
      validarConsultaDeReceita(consulta.sql, consulta.tabelas);

      return op.executarReceita(consulta, opcoes);
    },
  };
}

export function criarDialetoPostgres(pool: pg.Pool, regra: RegraDeFontes): Dialeto {
  return criarDialetoDeLeitura(
    {
      listarTabelas: () => listarTabelas(pool),
      descreverTabela: (schema, tabela) => descreverTabela(pool, schema, tabela),
      lerTabela: (pedido, permitidas, opcoes) => lerTabela(pool, pedido, permitidas, opcoes),
      schemaDasReceitas: () => {
        throw new LeituraInvalidaError("receita_nao_suportada_no_motor");
      },
      executarReceita: async () => {
        throw new LeituraInvalidaError("receita_nao_suportada_no_motor");
      },
    },
    regra,
  );
}
