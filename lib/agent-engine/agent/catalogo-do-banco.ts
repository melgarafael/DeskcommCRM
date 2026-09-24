/**
 * Consulta SERVER-SIDE ao catálogo do banco externo (G4).
 *
 * ─── Por que existe ─────────────────────────────────────────────────────────
 * A escolha das semelhantes dependia de o MODELO ter consultado o catálogo no
 * turno (`crm_query_external_data`). No turno da objeção ("Achei caro") ele não
 * consulta → o motor não tinha candidatos. Esta função dá ao MOTOR a mesma
 * leitura, sem depender da IA — só o mapeamento configurado e a conexão.
 *
 * ─── Segurança ──────────────────────────────────────────────────────────────
 * Reusa o caminho canônico (`abrirAcesso` → guarda de host/DNS; `colunasDaTabela`
 * → validação contra o catálogo real; `lerTabela` → SELECT montado no servidor,
 * identificadores quotados e valores parametrizados). Nada de SQL por texto.
 *
 * Nunca lança: falha de conexão/leitura devolve `[]` — o motor cai no catálogo
 * guardado da conversa / no comportamento atual, e o turno do cliente não morre.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { abrirAcesso } from '@/lib/external-db/acesso';
import {
  colunaDeSimilares,
  colunasDeComparacao,
  colunasParaConsulta,
  criteriosDaIA,
  type CatalogoMapeamento,
} from '@/lib/external-db/catalogo';
import { colunasDaTabela } from '@/lib/external-db/introspeccao';
import { lerTabela } from '@/lib/external-db/leitura';
import type { PedidoDeLeitura } from '@/lib/external-db/types';

import {
  extrairMotosDoResultado,
  normalizarNomeDeMoto,
  type ColunasDoCatalogo,
  type MotoDoCatalogo,
} from './fotos-do-catalogo';

/** Teto de linhas lido do catálogo (o teto real continua sendo o da conexão). */
export const LIMITE_CATALOGO_DO_BANCO = 100;

/** Junta listas de motos sem repetir pelo nome normalizado (ordem das listas). */
export function mesclarMotos(
  ...listas: ReadonlyArray<readonly MotoDoCatalogo[]>
): MotoDoCatalogo[] {
  const vistas = new Set<string>();
  const saida: MotoDoCatalogo[] = [];
  for (const lista of listas) {
    for (const moto of lista) {
      const chave = normalizarNomeDeMoto(moto.nome);
      if (chave === '' || vistas.has(chave)) continue;
      vistas.add(chave);
      saida.push(moto);
    }
  }
  return saida;
}

/**
 * Lê o catálogo do banco externo e devolve as motos (nome + fotos + valores crus
 * de TODAS as colunas projetadas). Lista vazia em qualquer falha.
 */
export async function carregarCatalogoDoBanco(
  admin: SupabaseClient,
  tenantId: string,
  mapeamento: CatalogoMapeamento,
  colunas: ColunasDoCatalogo,
  opts: { limite?: number } = {},
): Promise<MotoDoCatalogo[]> {
  try {
    const acesso = await abrirAcesso(admin, tenantId, mapeamento.connectionId);
    if (!acesso.ok) return [];

    const permitidas = await colunasDaTabela(
      acesso.pool,
      mapeamento.schemaName,
      mapeamento.tableName,
    );
    if (permitidas === null) return [];

    // Projeção: colunas de papel + comparação + critério + legenda + referência.
    // É o que garante que o motor tenha o valor de TODA coluna que usa por dentro
    // (ex.: `moto_similar`) e de toda coluna que vai na legenda.
    const colSimilares = colunaDeSimilares(mapeamento);
    const desejadas = [
      ...colunasParaConsulta(mapeamento),
      ...colunasDeComparacao(mapeamento),
      ...criteriosDaIA(mapeamento),
      ...(mapeamento.legenda ?? []),
      ...(colSimilares !== null ? [colSimilares] : []),
    ];
    const projecao = [...new Set(desejadas)].filter((c) => c !== '' && permitidas.has(c));

    const pedido: PedidoDeLeitura = {
      schema: mapeamento.schemaName,
      tabela: mapeamento.tableName,
      colunas: projecao,
      filtros: [],
      limite: Math.min(opts.limite ?? LIMITE_CATALOGO_DO_BANCO, acesso.conexao.maxRows),
      offset: 0,
    };
    const resultado = await lerTabela(acesso.pool, pedido, permitidas, {
      limiteMax: acesso.conexao.maxRows,
    });
    return extrairMotosDoResultado(
      { colunas: resultado.colunas, linhas: resultado.linhas },
      colunas,
    );
  } catch {
    return [];
  }
}
