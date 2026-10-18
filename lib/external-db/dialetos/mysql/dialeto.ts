import type { RegraDeFontes } from "../../fontes";
import { criarDialetoDeLeitura, type Dialeto } from "../../dialeto";
import type { ConexaoExterna } from "../../types";
import { obterPoolMysql } from "./conexao";
import { descreverTabelaMysql, listarTabelasMysql } from "./introspeccao";
import { executarReceitaMysql, lerTabelaMysql } from "./leitura";

export function criarDialetoMysql(conexao: ConexaoExterna, regra: RegraDeFontes): Dialeto {
  const pool = obterPoolMysql(conexao);
  const banco = conexao.database;
  return criarDialetoDeLeitura(
    {
      listarTabelas: () => listarTabelasMysql(pool, banco),
      descreverTabela: (schema, tabela) => descreverTabelaMysql(pool, banco, schema, tabela),
      lerTabela: (pedido, permitidas, opcoes) => lerTabelaMysql(pool, banco, pedido, permitidas, opcoes),
      schemaDasReceitas: () => banco,
      executarReceita: (consulta, opcoes) =>
        executarReceitaMysql(pool, banco, consulta, conexao.maxResponseBytes, opcoes),
    },
    regra,
  );
}
