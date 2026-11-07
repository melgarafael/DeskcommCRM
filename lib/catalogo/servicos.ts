/**
 * O SERVIÇO NO CATÁLOGO — tipo, unidade de cobrança, prazo e sinal.
 *
 * ─── De onde isto vem ───────────────────────────────────────────────────────
 *
 * Issue #3372, que complementa a #2497. A #2497 faz o catálogo ser a fonte do
 * preço; esta parte responde o que a #2497 sozinha não responde: o que se vende
 * que **não** é uma hora marcada nem um produto de prateleira — consultoria com
 * variações, plano mensal de social media, site institucional com prazo e sinal.
 *
 * O desenho é o da issue, e ele NÃO é uma tabela de serviços com preço:
 *
 * - o serviço é **item do catálogo** (`catalog_products`), com as colunas de
 *   serviço anuláveis (pergunta 3 da issue: "tabela de detalhe 1 para 1 ou
 *   colunas anuláveis no catálogo");
 * - a **variação também é item do catálogo**, ligada ao principal por `pai_id`.
 *   O principal carrega o que é comum (descrição, fotos, tipo, unidade, sinal);
 *   a variação carrega nome, código e preço próprios — e **nada** de serviço,
 *   para não haver dois lugares dizendo de que tipo é o mesmo serviço;
 * - **nenhum campo de preço novo**: o preço é o do item, como na #2497.
 *
 * ─── Por que este arquivo é puro ────────────────────────────────────────────
 *
 * É lido por três consumidores que não podem importar banco: a rota de serviço
 * (contrato), o `crm_search_products` (o agente) e a tela. Um cálculo de "a
 * partir de" escrito três vezes dá três respostas — e a que o cliente lê é a do
 * agente.
 */

import { formatCents } from "@/lib/money";

/** Os três recortes que a issue separa. Vocabulário FECHADO (CHECK no banco). */
export const TIPOS_DE_SERVICO = ["hora_marcada", "projeto", "recorrente"] as const;
export type TipoDeServico = (typeof TIPOS_DE_SERVICO)[number];

/** Como se cobra. FECHADO, e cada tipo só aceita a sua família. */
export const UNIDADES_DE_COBRANCA = [
  "sessao",
  "hora",
  "valor_fechado",
  "mes",
  "trimestre",
  "ano",
] as const;
export type UnidadeDeCobranca = (typeof UNIDADES_DE_COBRANCA)[number];

/**
 * A compatibilidade tipo × unidade — a MESMA lista do CHECK
 * `catalog_products_servico_unidade_check`. Aqui ela existe para a rota poder
 * responder 422 com o campo nomeado antes de o banco recusar com 23514.
 *
 * Hora marcada se cobra por sessão ou por hora; projeto por valor fechado ou
 * por hora (obra aberta); plano recorrente por mês, trimestre ou ano. "Projeto
 * por mês" não é variação de vocabulário — é contrato diferente, e quem quiser
 * isso cadastra Recorrente.
 */
export const UNIDADES_POR_TIPO: Record<TipoDeServico, readonly UnidadeDeCobranca[]> = {
  hora_marcada: ["sessao", "hora"],
  projeto: ["valor_fechado", "hora"],
  recorrente: ["mes", "trimestre", "ano"],
};

export function ehTipoDeServico(valor: unknown): valor is TipoDeServico {
  return typeof valor === "string" && (TIPOS_DE_SERVICO as readonly string[]).includes(valor);
}

export function unidadeCompativel(tipo: TipoDeServico, unidade: UnidadeDeCobranca): boolean {
  return UNIDADES_POR_TIPO[tipo].includes(unidade);
}

/**
 * O sufixo que acompanha o preço. `valor_fechado` não tem sufixo: "R$ 4.500,00"
 * é o preço inteiro, e "por projeto" soaria como parcela.
 */
export function sufixoDaUnidade(unidade: UnidadeDeCobranca): string {
  switch (unidade) {
    case "sessao":
      return "por sessão";
    case "hora":
      return "por hora";
    case "valor_fechado":
      return "";
    case "mes":
      return "por mês";
    case "trimestre":
      return "por trimestre";
    case "ano":
      return "por ano";
  }
}

/** O nome do tipo como a equipe lê, não a chave do banco. */
export function rotuloDoTipo(tipo: TipoDeServico): string {
  switch (tipo) {
    case "hora_marcada":
      return "hora marcada";
    case "projeto":
      return "projeto";
    case "recorrente":
      return "plano recorrente";
  }
}

/**
 * Preço em texto, com o sufixo da unidade. Preço ZERO é oferta gratuita e se diz
 * "Grátis" — "R$ 0,00 por sessão" faz o cliente achar que é erro de cadastro.
 */
export function rotuloDoPreco(
  precoCents: number,
  moeda: string,
  unidade: UnidadeDeCobranca,
): string {
  if (precoCents === 0) return "Grátis";
  const sufixo = sufixoDaUnidade(unidade);
  return sufixo ? `${formatCents(precoCents, moeda)} ${sufixo}` : formatCents(precoCents, moeda);
}

/** O menor preço entre o principal e as variações. `null` = lista vazia. */
export function menorPreco(itens: ReadonlyArray<{ preco_cents: number }>): number | null {
  let menor: number | null = null;
  for (const item of itens) {
    if (menor === null || item.preco_cents < menor) menor = item.preco_cents;
  }
  return menor;
}

/**
 * "A partir de" existe quando há MAIS DE UM preço diferente: com um só preço a
 * palavra promete uma escada que não existe. Empate de preço também não é
 * escada — duas variações de mesmo valor são escolha de escopo, não de preço.
 */
export function rotuloAPartir(
  precos: ReadonlyArray<number>,
  moeda: string,
  unidade: UnidadeDeCobranca,
): string {
  const menor = menorPreco(precos.map((preco_cents) => ({ preco_cents })));
  if (menor === null) return "";
  const distintos = new Set(precos);
  const rotulo = rotuloDoPreco(menor, moeda, unidade);
  return distintos.size > 1 ? `a partir de ${rotulo}` : rotulo;
}

/** O sinal como o cadastro o guarda: percentual do preço OU valor fixo. */
export type SinalDoServico =
  { tipo: "percentual"; percentual: number } | { tipo: "fixo"; cents: number };

/**
 * O sinal em centavos, calculado — a API nunca devolve "30%", devolve quanto é.
 *
 * Percentual arredonda para o centavo: 30% de R$ 350,00 = R$ 105,00 (o caso da
 * issue). Fixo é o valor cadastrado, sem cálculo.
 */
export function sinalEmCents(
  precoCents: number,
  sinal: SinalDoServico | null | undefined,
): number | null {
  if (!sinal) return null;
  if (sinal.tipo === "fixo") return sinal.cents;
  if (!Number.isFinite(sinal.percentual)) return null;
  return Math.round((precoCents * sinal.percentual) / 100);
}

/** "sinal de R$ 105,00 (30%)" — o texto que a IA pode dizer sem inventar. */
export function rotuloDoSinal(
  sinalCents: number | null,
  moeda: string,
  percentual: number | null,
): string | null {
  if (sinalCents === null) return null;
  const valor = formatCents(sinalCents, moeda);
  return percentual === null ? `sinal de ${valor}` : `sinal de ${valor} (${percentual}%)`;
}

/** A linha do catálogo como o banco a devolve (só o que serviço usa). */
export interface LinhaDoCatalogo {
  id: string;
  codigo: string;
  nome: string;
  descricao: string | null;
  preco_cents: number;
  moeda: string;
  ativo: boolean;
  tipo_servico: string | null;
  unidade_cobranca: string | null;
  prazo_dias_uteis: number | null;
  sinal_tipo: string | null;
  sinal_percentual: number | null;
  sinal_cents: number | null;
  pai_id: string | null;
  fotos?: string[] | null;
  instrucoes_ia?: string | null;
  ia_oferece?: boolean;
  ia_agenda?: boolean;
  revision?: number;
}

/** As colunas que a rota e a busca leem — uma lista, não duas. */
export const COLUNAS_DO_SERVICO =
  "id, codigo, nome, descricao, preco_cents, moeda, ativo, tipo_servico, unidade_cobranca, " +
  "prazo_dias_uteis, sinal_tipo, sinal_percentual, sinal_cents, pai_id, fotos, instrucoes_ia, " +
  "ia_oferece, ia_agenda, revision";

export interface VariacaoDoServico {
  id: string;
  codigo: string;
  nome: string;
  preco_cents: number;
  preco: string;
  /** O sinal daquela variação, já calculado (percentual do preço dela). */
  sinal_cents: number | null;
  sinal: string | null;
  ativo: boolean;
  fotos: string[] | null;
}

export interface ServicoMontado {
  id: string;
  codigo: string;
  nome: string;
  descricao: string | null;
  tipo: TipoDeServico;
  unidade: UnidadeDeCobranca;
  prazo_dias_uteis: number | null;
  /** O menor preço entre principal e variações — o que "a partir de" diz. */
  preco_a_partir_cents: number;
  preco_a_partir: string;
  sinal: {
    tipo: "percentual" | "fixo";
    valor: number;
    cents: number | null;
    rotulo: string | null;
  } | null;
  variacoes: VariacaoDoServico[];
  ativo: boolean;
  fotos: string[] | null;
  instrucoes_ia: string | null;
  ia_oferece: boolean;
  ia_agenda: boolean;
  revision: number | null;
}

function sinalDaLinha(linha: LinhaDoCatalogo): SinalDoServico | null {
  if (linha.sinal_tipo === "percentual" && linha.sinal_percentual !== null) {
    return { tipo: "percentual", percentual: Number(linha.sinal_percentual) };
  }
  if (linha.sinal_tipo === "fixo" && linha.sinal_cents !== null) {
    return { tipo: "fixo", cents: Number(linha.sinal_cents) };
  }
  return null;
}

/**
 * Agrupa as linhas do catálogo em serviços: principal + variações.
 *
 * Linha com `pai_id` apontando para um principal que NÃO veio na mesma lista é
 * descartada da montagem (ela não é serviço sozinha — sem o principal não há
 * tipo nem unidade para dizer). Isso acontece de verdade quando a chamada pede
 * só os ativos e o principal está arquivado; mostrar a variação como se fosse
 * um serviço completo seria inventar tipo.
 */
export function montarServicos(linhas: ReadonlyArray<LinhaDoCatalogo>): ServicoMontado[] {
  const principais = linhas.filter(
    (linha) => linha.pai_id === null && ehTipoDeServico(linha.tipo_servico),
  );
  const porPai = new Map<string, LinhaDoCatalogo[]>();
  for (const linha of linhas) {
    if (linha.pai_id === null) continue;
    const atuais = porPai.get(linha.pai_id) ?? [];
    atuais.push(linha);
    porPai.set(linha.pai_id, atuais);
  }

  return principais.map((principal) => {
    const tipo = principal.tipo_servico as TipoDeServico;
    const unidade = principal.unidade_cobranca as UnidadeDeCobranca;
    const sinal = sinalDaLinha(principal);
    const variacoes = (porPai.get(principal.id) ?? [])
      .slice()
      .sort((a, b) => a.preco_cents - b.preco_cents || a.nome.localeCompare(b.nome, "pt-BR"));

    const precos = [principal.preco_cents, ...variacoes.map((v) => v.preco_cents)];
    const aPartir =
      menorPreco(precos.map((preco_cents) => ({ preco_cents }))) ?? principal.preco_cents;

    const sinalCents = sinalEmCents(aPartir, sinal);

    return {
      id: principal.id,
      codigo: principal.codigo,
      nome: principal.nome,
      descricao: principal.descricao,
      tipo,
      unidade,
      prazo_dias_uteis: principal.prazo_dias_uteis,
      preco_a_partir_cents: aPartir,
      preco_a_partir: rotuloAPartir(precos, principal.moeda, unidade),
      sinal: sinal
        ? {
            tipo: sinal.tipo,
            valor: sinal.tipo === "percentual" ? sinal.percentual : sinal.cents,
            cents: sinalCents,
            rotulo: rotuloDoSinal(
              sinalCents,
              principal.moeda,
              sinal.tipo === "percentual" ? sinal.percentual : null,
            ),
          }
        : null,
      variacoes: variacoes.map((v) => {
        const cents = sinalEmCents(v.preco_cents, sinal);
        return {
          id: v.id,
          codigo: v.codigo,
          nome: v.nome,
          preco_cents: v.preco_cents,
          preco: rotuloDoPreco(v.preco_cents, v.moeda, unidade),
          sinal_cents: cents,
          sinal: rotuloDoSinal(
            cents,
            v.moeda,
            sinal?.tipo === "percentual" ? sinal.percentual : null,
          ),
          ativo: v.ativo,
          fotos: v.fotos ?? null,
        };
      }),
      ativo: principal.ativo,
      fotos: principal.fotos ?? null,
      instrucoes_ia: principal.instrucoes_ia ?? null,
      ia_oferece: principal.ia_oferece ?? true,
      ia_agenda: principal.ia_agenda ?? false,
      revision: principal.revision ?? null,
    };
  });
}

/**
 * O serviço como o AGENTE o recebe no `crm_search_products`.
 *
 * Sem ferramenta nova (fatia E da issue): o serviço sai pela busca do catálogo
 * que já existe. O que muda é que a resposta passa a levar tipo, variações, "a
 * partir de", sinal calculado e prazo — sem isso a IA tem o preço e não tem o
 * que responder quando a pessoa pergunta "o que vem incluso" ou "quanto é o
 * sinal".
 *
 * `instrucoes_ia` vão MARCADAS: orientam a conversa e NUNCA se repetem ao
 * cliente. A marca é a instrução, não enfeite — quem lê a resposta é um modelo,
 * e "não repita ao cliente" no campo é o que o impede de citar o texto interno
 * como se fosse oferta.
 */
export function descreverServicoParaIA(servico: ServicoMontado): Record<string, unknown> {
  return {
    tipo: rotuloDoTipo(servico.tipo),
    unidade: sufixoDaUnidade(servico.unidade) || "preço fechado",
    preco_a_partir: servico.preco_a_partir,
    preco_a_partir_cents: servico.preco_a_partir_cents,
    ...(servico.prazo_dias_uteis ? { prazo_dias_uteis: servico.prazo_dias_uteis } : {}),
    ...(servico.sinal?.rotulo
      ? { sinal: servico.sinal.rotulo, sinal_cents: servico.sinal.cents }
      : {}),
    ...(servico.variacoes.length > 0
      ? {
          variacoes: servico.variacoes.map((v) => ({
            nome: v.nome,
            preco: v.preco,
            preco_cents: v.preco_cents,
            ...(v.sinal ? { sinal: v.sinal } : {}),
          })),
        }
      : {}),
    ...(servico.ia_agenda
      ? {}
      : { agendamento: "a equipe marca; você não reserva horário para este serviço" }),
    ...(servico.instrucoes_ia
      ? { instrucoes_internas_nao_repita_ao_cliente: servico.instrucoes_ia }
      : {}),
  };
}
