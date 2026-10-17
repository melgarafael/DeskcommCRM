/**
 * Receita `jetengine-imoveis`: é uma tabela-direta com predefinição para o
 * JetEngine. O JetEngine guarda os "Custom Content Types" (CCT) numa tabela
 * própria por tipo, `<prefixo>jet_cct_<slug>`, com uma coluna por campo e
 * colunas de sistema `_ID`, `cct_status` ('publish'/'draft'),
 * `cct_author_id`, `cct_created`, `cct_modified`.
 *
 * Reaproveita o motor da tabela-direta (não duplica a montagem de SQL):
 *  - fixos: prefixo + slug do CCT → tabela `<prefixo>jet_cct_<slug>`
 *           mapeamento { preco, quartos, bairro, cidade?, area?, titulo }
 *  - status fixo `cct_status = 'publish'` (por `?`); id `_ID`
 *  - busca igual à do acf-imoveis (bairro, quartos_min, preco_max, cidade,
 *    limite), para o agente usar as duas da mesma forma.
 *
 * IMPORTANTE: este DDL de colunas é INFERIDO da documentação do JetEngine 3.x,
 * NÃO medido contra uma instalação real. A medição contra cópia real fica
 * pendente (C1 JetEngine) e é pré-requisito para liberar a receita a cliente.
 */
import { z } from "zod";

import { montarTabelaDireta, RECEITA_TABELA_DIRETA } from "./tabela-direta";
import type { DefinicaoDeReceita } from "./tipos";

const PREFIXO_PADRAO = "wp_";
const PREFIXO_REGEX = /^[A-Za-z0-9_]{1,20}$/;
const SLUG_REGEX = /^[a-z0-9_-]{1,40}$/;
const META_KEY_REGEX = /^[A-Za-z0-9_]{1,64}$/;
const POST_TYPE_PADRAO = "imovel";

const JETENGINE_TETO = 5;

export const jetenginePrefixoSchema = z
  .string()
  .min(1)
  .max(20)
  .regex(PREFIXO_REGEX, "Use apenas letras, números e underline no prefixo.")
  .default(PREFIXO_PADRAO);

const slugSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(SLUG_REGEX, "Use apenas letras minúsculas, números, underline e hífen no slug do CCT.");

const campoJetSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(META_KEY_REGEX, "Use apenas letras, números, underline no nome da coluna.");

const camposJetSchema = z
  .object({
    preco: campoJetSchema,
    quartos: campoJetSchema,
    bairro: campoJetSchema,
    titulo: campoJetSchema,
    cidade: campoJetSchema.optional(),
    area: campoJetSchema.optional(),
    /** Campo de mídia (R4): guarda URL ou ID de anexo (INFERIDO, não medido). */
    imagem: campoJetSchema.optional(),
  })
  .strict();

/** O que o admin preenche na tela: prefixo, slug do CCT e mapeamento de colunas. */
export const PARAMETROS_FIXOS_JETENGINE_IMOVEIS = z
  .object({
    prefixo: jetenginePrefixoSchema,
    slug: slugSchema,
    campos: camposJetSchema,
  })
  .strict();

/** O que o agente preenche na conversa (mesmo formato do acf-imoveis). */
export const PARAMETROS_DA_BUSCA_JETENGINE_IMOVEIS = z
  .object({
    bairro: z.string().max(60).optional(),
    quartos_min: z.number().int().min(0).max(20).optional(),
    preco_max: z.number().nonnegative().optional(),
    cidade: z.string().max(60).optional(),
    limite: z.number().int().min(1).max(JETENGINE_TETO).optional().default(JETENGINE_TETO),
  })
  .strict();

function tabelaJetEngine(prefixo: string, slug: string): string {
  return `${prefixo}jet_cct_${slug}`;
}

/**
 * Converte os fixos do jetengine para os fixos da tabela-direta, delegando a
 * montagem de SQL para RECEITA_TABELA_DIRETA.montar.
 */
function fixosJetParaTabelaDireta(fixos: {
  prefixo: string;
  slug: string;
  campos: { preco: string; quartos: string; bairro: string; titulo: string; cidade?: string; area?: string; imagem?: string };
}) {
  const tabela = tabelaJetEngine(fixos.prefixo, fixos.slug);
  const c = fixos.campos;
  const filtros_texto: string[] = [c.bairro];
  if (c.cidade) filtros_texto.push(c.cidade);
  const exibir: string[] = [];
  if (c.area) exibir.push(c.area);

  return {
    tabela,
    colunas: {
      id: "_ID",
      titulo: c.titulo,
      preco: c.preco,
      imagem: c.imagem,
      filtros_texto,
      filtro_numero: c.quartos,
      exibir,
      status: { coluna: "cct_status", valor: "publish" },
    },
  };
}

export const RECEITA_JETENGINE_IMOVEIS: DefinicaoDeReceita = {
  id: "jetengine-imoveis",
  familia: "jetengine-imoveis",
  motores: ["mysql"],
  rotulo: "Imóveis do WordPress com JetEngine",
  descricao:
    "Lê os imóveis de um tipo de conteúdo (CCT) do JetEngine: título, preço, " +
    "quartos, bairro e (opcional) cidade e área. O admin informa o prefixo e o " +
    "slug do CCT (a tabela é <prefixo>jet_cct_<slug>). Só imóveis publicados " +
    "(cct_status = 'publish'). " +
    "Com o campo de imagem mapeado, devolve imagem_url (URL direta, ou o guid do anexo quando o campo guarda o ID). " +
    "INFERIDO: o DDL das colunas vem da documentação do JetEngine 3.x; a medição " +
    "contra uma instalação real (C1 JetEngine) está pendente.",
  parametrosFixos: PARAMETROS_FIXOS_JETENGINE_IMOVEIS,
  parametrosDaBusca: PARAMETROS_DA_BUSCA_JETENGINE_IMOVEIS,
  tabelas: (fixos) => {
    const f = fixos as { prefixo: string; slug: string };
    const g = fixos as { prefixo: string; slug: string; campos?: { imagem?: string } };
    const tabelas = [tabelaJetEngine(f.prefixo, f.slug)];
    // O campo de imagem pode guardar o ID de um anexo: a receita lê o posts.
    if (g.campos?.imagem) tabelas.push(`${f.prefixo}posts`);
    return tabelas;
  },
  colunas: (fixos) => {
    const f = fixos as { prefixo: string; slug: string; campos: { preco: string; quartos: string; bairro: string; titulo: string; cidade?: string; area?: string; imagem?: string } };
    const tabela = tabelaJetEngine(f.prefixo, f.slug);
    const c = f.campos;
    const usadas: string[] = ["_ID", c.titulo, c.preco, c.bairro, c.quartos];
    if (c.cidade) usadas.push(c.cidade);
    if (c.area) usadas.push(c.area);
    if (c.imagem) usadas.push(c.imagem);
    usadas.push("cct_status");
    return c.imagem
      ? { [tabela]: usadas, [`${f.prefixo}posts`]: ["ID", "guid", "post_type"] }
      : { [tabela]: usadas };
  },
  montar: (fixos, busca, limite) => {
    const f = fixos as { prefixo: string; slug: string; campos: { preco: string; quartos: string; bairro: string; titulo: string; cidade?: string; area?: string; imagem?: string } };
    const b = busca as { bairro?: string; quartos_min?: number; preco_max?: number; cidade?: string; limite?: number };
    const fixosTD = fixosJetParaTabelaDireta(f);

    // Per-column text filters: bairro e cidade cada um na sua coluna, ANDed
    // (igual ao ACF), nunca `bairro ?? cidade`.
    const extras: Record<string, string> = {};
    if (b.bairro && f.campos.bairro) extras[f.campos.bairro] = b.bairro;
    if (b.cidade) {
      // Sem coluna de cidade mapeada, ignorar o filtro em silêncio faria o
      // agente achar que filtrou. Recusa com motivo legível.
      if (!f.campos.cidade) throw new Error("filtro_sem_coluna:cidade");
      extras[f.campos.cidade] = b.cidade;
    }

    const buscaTD = {
      preco_max: b.preco_max,
      numero_min: b.quartos_min,
      limite: b.limite,
    };

    return montarTabelaDireta(
      fixosTD,
      buscaTD,
      limite,
      extras,
      f.campos.imagem ? { anexos: `${f.prefixo}posts` } : undefined,
    );
  },
  tetoDeItens: JETENGINE_TETO,
};
