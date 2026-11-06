import { randomUUID } from "node:crypto";

import type { CamposDoProduto, PlanoDaRodada } from "@/lib/catalogo/feed";
import { apagarDoBucket } from "@/lib/catalogo/fotos-no-bucket";
import { guardarFotosPorUrl } from "@/lib/catalogo/fotos-por-url";

/**
 * APLICAR O PLANO — a única parte da sincronização que ESCREVE no catálogo.
 *
 * ─── Por que o banco entra por uma interface, e não por um client ───────────
 *
 * Quem aplica é a rota (cliente do usuário, RLS ligada) e o cron (service role,
 * que bypassa RLS). São dois clients com tipos e poderes diferentes; o que os
 * dois precisam fazer é sempre o mesmo trio: inserir, atualizar e desativar.
 * Passar o client cru faria o cron herdar a checagem de papel da sessão (que
 * ele não tem) e a rota herdar o poder de apagar qualquer linha. Com a
 * interface, cada um implementa o trio com o próprio client e a REGRA — o que
 * criar, o que atualizar, o que desativar — mora num lugar só.
 *
 * ─── NADA AQUI APAGA ────────────────────────────────────────────────────────
 *
 * Não existe método de DELETE nesta interface. "Saiu do feed" vira
 * `ativo = false`, porque a linha do produto é referenciada por histórico de
 * conversa e por proposta enviada: apagá-la deixaria a proposta apontando para
 * o nada e o relatório do mês passado sem o produto que foi vendido.
 *
 * ─── A foto é baixada ANTES da linha existir ────────────────────────────────
 *
 * O caminho no bucket é `<org>/<produto>/<uuid>.<ext>`, então o id do produto
 * precisa existir antes do download — o id é gerado aqui, como na rota de
 * produto avulso e na planilha. E a falha de UMA foto recusa o ITEM (não a
 * rodada): um produto com a capa errada é pior que o item esperando a correção
 * do feed. Se o insert falhar depois do upload, os arquivos são removidos —
 * senão ficariam órfãos no bucket, pagos por ninguém.
 */

/** O que a tabela `catalog_products` recebe de uma criação pelo feed. */
export interface LinhaDoProduto {
  id: string;
  organization_id: string;
  codigo: string;
  nome: string;
  descricao: string | null;
  preco_cents: number;
  moeda: string;
  origem: string;
  id_externo: string;
  ativo: boolean;
  fotos?: string[];
  quantidade?: number;
}

/** O que o UPDATE aceita. `ativo: true` = o produto voltou ao feed. */
export interface CamposDoUpdate {
  nome?: string;
  descricao?: string;
  preco_cents?: number;
  /** CAMINHOS no bucket — já baixados, nunca URLs. */
  fotos?: string[];
  quantidade?: number;
  ativo?: true;
}

/**
 * O mínimo que aplicar exige do banco. Cada método devolve `null` quando deu
 * certo e a MENSAGEM do erro quando não deu — o desfecho é por item, e a
 * rodada continua.
 */
export interface BancoDoFeed {
  criar(linha: LinhaDoProduto): Promise<string | null>;
  atualizar(id: string, campos: CamposDoUpdate): Promise<string | null>;
  desativar(ids: readonly string[]): Promise<string | null>;
}

export interface FalhaDaAplicacao {
  referencia: string;
  motivo: string;
}

export interface ResultadoDaAplicacao {
  criados: string[];
  atualizados: string[];
  desativados: string[];
  falhas: FalhaDaAplicacao[];
}

export interface ContextoDaAplicacao {
  orgId: string;
  /** A moeda da ORGANIZAÇÃO, nunca a do feed: o feed de uma revenda não manda na moeda da loja. */
  moeda: string;
  t: (texto: string) => string;
  /** Só para o log de limpeza do bucket; a rota passa o `requestId`. */
  requestId: string;
}

export async function aplicarPlano(
  banco: BancoDoFeed,
  plano: PlanoDaRodada,
  ctx: ContextoDaAplicacao,
): Promise<ResultadoDaAplicacao> {
  const resultado: ResultadoDaAplicacao = { criados: [], atualizados: [], desativados: [], falhas: [] };

  /** Baixa as fotos e devolve os CAMINHOS, ou o motivo da recusa. */
  const guardarFotos = async (
    produtoId: string,
    urls: readonly string[],
  ): Promise<{ ok: true; caminhos: string[] } | { ok: false; motivo: string }> => {
    const guardadas = await guardarFotosPorUrl({ orgId: ctx.orgId, produtoId, urls, t: ctx.t });
    if (!guardadas.ok) return { ok: false, motivo: guardadas.motivo };
    return { ok: true, caminhos: guardadas.caminhos };
  };

  for (const item of plano.criar) {
    const id = randomUUID();
    let caminhos: string[] | undefined;
    if (item.fotos && item.fotos.length > 0) {
      const fotos = await guardarFotos(id, item.fotos);
      if (!fotos.ok) {
        resultado.falhas.push({ referencia: item.id_externo, motivo: fotos.motivo });
        continue;
      }
      caminhos = fotos.caminhos;
    }

    const erro = await banco.criar({
      id,
      organization_id: ctx.orgId,
      codigo: item.codigo,
      nome: item.nome,
      descricao: item.descricao,
      preco_cents: item.preco_cents,
      moeda: ctx.moeda,
      origem: "feed",
      id_externo: item.id_externo,
      ativo: true,
      ...(caminhos && caminhos.length > 0 ? { fotos: caminhos } : {}),
      ...(item.quantidade !== null ? { quantidade: item.quantidade } : {}),
    });

    if (erro !== null) {
      // Os arquivos já subiram e a linha não existe: sem esta limpeza, um código
      // repetido deixaria fotos órfãs no bucket pagas por ninguém.
      if (caminhos && caminhos.length > 0) {
        await apagarDoBucket(ctx.orgId, id, caminhos, ctx.requestId);
      }
      resultado.falhas.push({ referencia: item.id_externo, motivo: erro });
      continue;
    }
    resultado.criados.push(item.id_externo);
  }

  for (const item of plano.atualizar) {
    const campos: CamposDoUpdate = {};
    if (item.campos.nome !== undefined) campos.nome = item.campos.nome;
    if (item.campos.descricao !== undefined) campos.descricao = item.campos.descricao;
    if (item.campos.preco_cents !== undefined) campos.preco_cents = item.campos.preco_cents;
    if (item.campos.quantidade !== undefined) campos.quantidade = item.campos.quantidade;

    if (item.campos.fotos !== undefined) {
      const fotos = await guardarFotos(item.id, item.campos.fotos);
      if (!fotos.ok) {
        resultado.falhas.push({ referencia: item.id_externo, motivo: fotos.motivo });
        continue;
      }
      if (fotos.caminhos.length > 0) campos.fotos = fotos.caminhos;
    }

    // `ativo` não está em `campos` do plano: quem sabe que o produto voltou é o
    // desfecho (`mudou`), e é aqui que ele vira escrita.
    const query: CamposDoUpdate = item.mudou.includes("ativo") ? { ...campos, ativo: true } : campos;

    const erro = await banco.atualizar(item.id, query);
    if (erro !== null) {
      resultado.falhas.push({ referencia: item.id_externo, motivo: erro });
      continue;
    }
    resultado.atualizados.push(item.id_externo);
  }

  if (plano.desativar.length > 0) {
    const ids = plano.desativar.map((item) => item.id);
    const erro = await banco.desativar(ids);
    if (erro !== null) {
      for (const item of plano.desativar) {
        resultado.falhas.push({ referencia: item.id_externo, motivo: erro });
      }
    } else {
      resultado.desativados.push(...plano.desativar.map((item) => item.id_externo));
    }
  }

  return resultado;
}

/** Os campos do produto que o plano toca — usado pelo teste para não repetir a lista. */
export const CAMPOS_QUE_O_FEED_ESCREVE: (keyof CamposDoProduto)[] = [
  "nome",
  "descricao",
  "preco_cents",
  "fotos",
  "quantidade",
];
