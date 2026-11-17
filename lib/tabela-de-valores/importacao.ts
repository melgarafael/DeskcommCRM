import { createHash } from "node:crypto";

import type {
  LeituraDaTabelaDeValores,
  LinhaRecusada,
  PreviaDaTabela,
} from "@/lib/tabela-de-valores/tipos";
import { TEXTO_DO_MOTIVO, motivosDe } from "@/lib/tabela-de-valores/tipos";

/**
 * A PRÉVIA DA IMPORTAÇÃO — o que entra, o que não entra e por quê.
 *
 * ─── Por que a prévia é obrigatória ──────────────────────────────────────
 *
 * A importação cria procedimento e preço numa tabela que o agente vai usar para
 * negociar. Gravar metade e avisar depois é o pior resultado possível: o
 * operador olha a tela, vê "tabela importada" e a negociação passa a oferecer
 * preço errado para quem ninguém sabe que faltou. Então a ordem é sempre:
 * LER → CLASSIFICAR → mostrar → só gravar com confirmação explícita.
 *
 * ─── Por que a chave é o SHA-256 do ARQUIVO ──────────────────────────────
 *
 * Importar a mesma planilha duas vezes é, quase sempre, o mesmo clique dado
 * duas vezes: duplo envio, aba recarregada, botão apertado de novo porque a
 * tela demorou. O hash do arquivo é a chave ESTÁVEL dessa intenção: igual
 * enquanto os bytes forem iguais, diferente quando a empresa manda a planilha
 * corrigida. O `unique (tabela_id, chave_do_arquivo)` no banco é a cerca; e o
 * `unique (tabela_id, codigo)` é a segunda, para o caso de a planilha ser a
 * mesma com outro nome de arquivo.
 *
 * Este módulo é PURO de propósito: recebe o que a planilha leu e o conjunto de
 * códigos que a tabela já tem, e não sabe consultar nada. Assim a prévia e a
 * confirmação classificam pela MESMA função — não há duas regras divergindo.
 */

/** SHA-256 em hexadecimal, a chave estável do arquivo. */
export function chaveDoArquivo(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface OpcoesDaPrevia {
  chave_do_arquivo: string;
  /** Códigos que já existem na tabela. Vazio quando a tabela ainda vai nascer. */
  codigos_na_tabela?: ReadonlySet<string>;
}

/**
 * Classifica o que a planilha leu contra o que a tabela já tem.
 *
 * A ORDEM importa. `ja_existe_na_tabela` só é perguntado DEPOIS das recusas da
 * própria linha: uma linha com limite menor que a partida é um erro que o
 * operador tem de consertar na planilha, mesmo que aquele código já esteja na
 * tabela — dizer "já existe" esconderia o defeito e ele reenviaria o arquivo
 * errado.
 */
export function montarPrevia(
  leitura: LeituraDaTabelaDeValores,
  opcoes: OpcoesDaPrevia,
): PreviaDaTabela {
  const existentes = opcoes.codigos_na_tabela ?? new Set<string>();
  const entram: PreviaDaTabela["entram"] = [];
  const fora: LinhaRecusada[] = [...leitura.fora];

  for (const linha of leitura.itens) {
    if (existentes.has(linha.item.codigo)) {
      fora.push({
        linha: linha.linha,
        codigo: "ja_existe_na_tabela",
        motivo: TEXTO_DO_MOTIVO.ja_existe_na_tabela,
        codigo_do_procedimento: linha.item.codigo,
      });
      continue;
    }
    entram.push(linha);
  }

  // A prévia é lida de cima para baixo, na ordem do arquivo: as duas listas se
  // intercalam, e a tela mostra a linha 2 antes da 7.
  fora.sort((a, b) => a.linha - b.linha);

  return {
    entram,
    fora,
    resumo: motivosDe(fora),
    total_linhas: entram.length + fora.length,
    chave_do_arquivo: opcoes.chave_do_arquivo,
  };
}
