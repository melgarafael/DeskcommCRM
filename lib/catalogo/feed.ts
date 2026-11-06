/**
 * O FEED DA REVENDA VIRA PLANO DE RODADA — sem banco, sem rede, sem relógio.
 *
 * ─── O gesto real que esta fatia atende (#3587, fatia 2) ────────────────────
 *
 * A revenda publica o estoque num JSON (e, quando caber, num CSV) e esse arquivo
 * é a verdade do catálogo dela: o que apareceu é novo, o que mudou de preço
 * mudou, e o que saiu do feed saiu da loja. Sem ninguém clicar.
 *
 * ─── O ID EXTERNO é a chave, e é a única ────────────────────────────────────
 *
 * Casa com `catalog_products.codigo` — a mesma identidade que a planilha usa
 * (`lib/catalogo/planilha.ts`), e pelo mesmo motivo: sem identidade estável a
 * segunda rodada duplicaria o catálogo, o agente veria dois preços para o mesmo
 * produto e a conversa com o cliente erraria. Id externo repetido DENTRO do
 * feed não vira duas linhas: o primeiro vale, o segundo entra em
 * `errosPorItem`. Id ausente também: erro daquele item, e a rodada SEGUE — um
 * item que a revenda publicou mal não pode impedir a atualização dos outros
 * 499.
 *
 * ─── O que saiu do feed é DESATIVADO, nunca apagado ─────────────────────────
 *
 * `crm_proposals` e o histórico de conversas apontam para a linha do produto.
 * `DELETE` levaria o preço da proposta junto, e o relatório do mês passado
 * perderia o produto que ele vendeu. É a mesma decisão do `sync-model-catalog`
 * (lá é `deprecated_at`; aqui é `ativo = false`, que a coluna já tem).
 *
 * Só produto com `origem = 'feed'` pode ser desativado por ausência: o que veio
 * da tela ou da planilha não pode desaparecer porque alguém publicou um feed
 * parcial — e é por isso que a escrita do feed marca `origem` em tudo que toca.
 *
 * ─── Comparação por valor NORMALIZADO ───────────────────────────────────────
 *
 * Preço em centavos (`precoParaCentavos`, o mesmo leitor da planilha e do
 * formulário — "R$ 5.499,00", "5499,00" e "5499" são o mesmo número) e fotos na
 * ORDEM. Rodar o mesmo feed duas vezes tem de dar plano vazio na segunda; se a
 * comparação fosse textual, "12.5" e "12.50" fariam o catálogo inteiro parecer
 * alterado a cada rodada.
 *
 * ⚠️ As fotos no catálogo são CAMINHOS do bucket, não as URLs do feed — a
 * comparação possível é a QUANTIDADE, na ordem da capa. Foto trocada por outra
 * do mesmo tamanho não é detectada por aqui; é o limite conhecido desta fatia e
 * está declarado no PR.
 */
import { MAXIMO_DE_FOTOS } from "@/lib/catalogo/fotos";
import { parseCsv } from "@/lib/contacts/csv";
import { precoParaCentavos } from "@/lib/schemas/produtos";

/** O valor que a coluna `origem` recebe em tudo que o feed toca. */
export const ORIGEM_DO_FEED = "feed";

/** Teto de itens por rodada — o mesmo da planilha, e o que a rota recusa acima. */
export const MAX_ITENS_POR_RODADA = 500;

export type FormatoDoFeed = "json" | "csv";

/**
 * O mapeamento é de QUEM PUBLICA: o feed do ERP não tem os nossos nomes de
 * campo. Cada chave aqui é o nome do campo NO FEED.
 */
export interface MapeamentoDoFeed {
  id_externo: string;
  nome: string;
  preco: string;
  descricao?: string | null;
  marca?: string | null;
  categoria?: string | null;
  quantidade?: string | null;
  /** Lista (`string[]`) ou texto com `separador_de_fotos`. */
  fotos?: string | null;
  /** O número do feed já está em centavos (ERP que publica inteiro). */
  preco_em_centavos?: boolean;
  /** Default `|`, o mesmo separador da planilha. */
  separador_de_fotos?: string;
}

/** O item do feed já normalizado — é o que a rota grava. */
export interface ProdutoDoFeed {
  id_externo: string;
  nome: string;
  preco_cents: number;
  descricao: string | null;
  marca: string | null;
  categoria: string | null;
  /** `null` = o feed não fala de estoque; não sobrescreve o que a tela gravou. */
  quantidade: number | null;
  /** `null` = o feed não fala de foto; `[]` = falou e não tem nenhuma. */
  fotos: string[] | null;
}

/** A linha que já está no catálogo, no recorte que a comparação precisa. */
export interface ProdutoExistente {
  id: string;
  codigo: string;
  nome: string;
  descricao: string | null;
  preco_cents: number;
  marca?: string | null;
  categoria?: string | null;
  quantidade?: number | null;
  fotos?: string[] | null;
  ativo: boolean;
  origem?: string | null;
}

export type AcaoDoItem = "criar" | "atualizar" | "desativar" | "inalterado";

export interface ItemDoPlano {
  acao: AcaoDoItem;
  /** 1-based no arquivo (no CSV, o cabeçalho é a linha 1). */
  linha: number;
  produto: ProdutoDoFeed;
  /** `null` quando o produto ainda não existe. */
  produto_id: string | null;
  /** Os campos que a rodada vai escrever — vazio em `inalterado`/`desativar`. */
  mudancas: string[];
  /**
   * Os caminhos das fotos que o produto tem HOJE no bucket. A rota os apaga
   * depois de gravar as novas — sem isso, cada rodada que troca foto deixa o
   * arquivo antigo órfão, pago por ninguém.
   */
  fotos_antigas: string[];
}

export interface ErroDoItem {
  linha: number;
  id_externo: string | null;
  motivo: string;
}

export interface PlanoDaRodada {
  criar: ItemDoPlano[];
  atualizar: ItemDoPlano[];
  desativar: ItemDoPlano[];
  inalterados: ItemDoPlano[];
  errosPorItem: ErroDoItem[];
  contagem: {
    criar: number;
    atualizar: number;
    desativar: number;
    inalterados: number;
  };
}

export interface EntradaDoPlano {
  formato: FormatoDoFeed;
  /** JSON: os objetos do feed, como vieram. */
  itens?: unknown[];
  /** CSV: o texto já decodificado (a decodificação de bytes é da rota). */
  conteudo?: string;
  mapeamento: MapeamentoDoFeed;
  existentes: ProdutoExistente[];
  /**
   * Default `true`. `false` desliga a desativação por ausência — o botão de
   * pânico de quem publicou um feed truncado e não quer que o catálogo caia.
   */
  desativarAusentes?: boolean;
}

export type ResultadoDoPlano = { ok: true; plano: PlanoDaRodada } | { ok: false; erro: string };

/** Minúsculas e sem espaços nas pontas: a chave de comparação do id externo. */
export function chaveDoIdExterno(valor: string): string {
  return valor.trim().toLowerCase();
}

function texto(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === "number" && Number.isFinite(valor)) return String(valor);
  if (typeof valor !== "string") return null;
  const limpo = valor.replace(/\u00A0/g, " ").trim();
  return limpo === "" ? null : limpo;
}

/** O que o `fetch` do servidor consegue abrir — `file:`, `data:` e `ftp:` não. */
function ehEnderecoHttp(valor: string): boolean {
  try {
    const url = new URL(valor);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}

function lerFotos(valor: unknown, mapeamento: MapeamentoDoFeed): { ok: true; fotos: string[] | null } | { ok: false; motivo: string } {
  // O mapeamento não declara foto: o feed não fala do assunto.
  if (!mapeamento.fotos) return { ok: true, fotos: null };
  if (valor === null || valor === undefined) return { ok: true, fotos: [] };

  let lista: string[];
  if (Array.isArray(valor)) {
    lista = valor.filter((v): v is string => typeof v === "string");
  } else if (typeof valor === "string") {
    const separador = mapeamento.separador_de_fotos || "|";
    lista = valor.split(separador);
  } else {
    return { ok: false, motivo: "a foto do item não é uma lista nem um texto" };
  }

  const fotos = lista.map((f) => f.trim()).filter((f) => f !== "");
  if (fotos.length > MAXIMO_DE_FOTOS) {
    return {
      ok: false,
      motivo: `o item traz ${fotos.length} fotos e o máximo é ${MAXIMO_DE_FOTOS} (a capa é a primeira)`,
    };
  }
  const invalida = fotos.find((f) => !ehEnderecoHttp(f));
  if (invalida !== undefined) {
    return { ok: false, motivo: `a foto "${invalida}" não é um endereço http(s)` };
  }
  return { ok: true, fotos };
}

function lerPreco(valor: unknown, mapeamento: MapeamentoDoFeed): { ok: true; cents: number } | { ok: false; motivo: string } {
  if (typeof valor === "number") {
    if (!Number.isFinite(valor) || valor < 0) return { ok: false, motivo: "o preço do item não é um número válido" };
    // Número em JSON é a UNIDADE da moeda ("5499.9" = R$ 5.499,90), salvo quando
    // o ERP publica centavos inteiros — aí `preco_em_centavos` diz isso.
    return { ok: true, cents: mapeamento.preco_em_centavos ? Math.round(valor) : Math.round(valor * 100) };
  }
  const bruto = texto(valor);
  if (bruto === null) return { ok: false, motivo: "o item não traz preço" };
  const cents = precoParaCentavos(bruto);
  if (cents === null) return { ok: false, motivo: `não sei ler o preço "${bruto}" — corrija no feed` };
  return { ok: true, cents };
}

function lerQuantidade(valor: unknown): { ok: true; quantidade: number | null } | { ok: false; motivo: string } {
  const bruto = texto(valor);
  if (bruto === null) return { ok: true, quantidade: null };
  const numero = Number(bruto.replace(",", "."));
  if (!Number.isInteger(numero) || numero < 0) {
    return { ok: false, motivo: `não sei ler o estoque "${bruto}" — use um inteiro maior ou igual a zero` };
  }
  return { ok: true, quantidade: numero };
}

/** Campo obrigatório ausente/inválido é erro do ITEM, com o motivo que a pessoa lê. */
export function normalizarProdutoDoItem(
  valores: Record<string, unknown>,
  mapeamento: MapeamentoDoFeed,
): { ok: true; produto: ProdutoDoFeed } | { ok: false; motivo: string } {
  const idBruto = texto(valores[mapeamento.id_externo]);
  if (idBruto === null) return { ok: false, motivo: "o item não traz id externo — sem ele não há como reconhecer o produto" };

  const nome = texto(valores[mapeamento.nome]);
  if (nome === null) return { ok: false, motivo: `o item "${idBruto}" não traz nome` };

  const preco = lerPreco(valores[mapeamento.preco], mapeamento);
  if (!preco.ok) return { ok: false, motivo: `${idBruto}: ${preco.motivo}` };

  const fotos = lerFotos(mapeamento.fotos ? valores[mapeamento.fotos] : undefined, mapeamento);
  if (!fotos.ok) return { ok: false, motivo: `${idBruto}: ${fotos.motivo}` };

  let quantidade: number | null = null;
  if (mapeamento.quantidade) {
    const lida = lerQuantidade(valores[mapeamento.quantidade]);
    if (!lida.ok) return { ok: false, motivo: `${idBruto}: ${lida.motivo}` };
    quantidade = lida.quantidade;
  }

  return {
    ok: true,
    produto: {
      id_externo: idBruto,
      nome,
      preco_cents: preco.cents,
      descricao: mapeamento.descricao ? texto(valores[mapeamento.descricao]) : null,
      marca: mapeamento.marca ? texto(valores[mapeamento.marca]) : null,
      categoria: mapeamento.categoria ? texto(valores[mapeamento.categoria]) : null,
      quantidade,
      fotos: fotos.fotos,
    },
  };
}

/**
 * Os campos que a rodada vai escrever. Comparação por valor normalizado, e só
 * nos campos que o FEED declara: o que ele não fala (a descrição escrita na
 * tela, o estoque que só a planilha atualiza) fica como está.
 */
function diferencas(produto: ProdutoDoFeed, existente: ProdutoExistente, mapeamento: MapeamentoDoFeed): string[] {
  const mudancas: string[] = [];
  if (produto.nome !== existente.nome.trim()) mudancas.push("nome");
  if (mapeamento.descricao && produto.descricao !== (texto(existente.descricao) ?? null)) mudancas.push("descricao");
  if (produto.preco_cents !== existente.preco_cents) mudancas.push("preco_cents");
  if (mapeamento.marca && produto.marca !== (texto(existente.marca) ?? null)) mudancas.push("marca");
  if (mapeamento.categoria && produto.categoria !== (texto(existente.categoria) ?? null)) mudancas.push("categoria");
  if (mapeamento.quantidade && produto.quantidade !== null && produto.quantidade !== (existente.quantidade ?? null)) {
    mudancas.push("quantidade");
  }
  // Caminho no bucket × URL do feed não são comparáveis: a quantidade, na ordem
  // da capa, é o que sobra — e é suficiente para o caso comum (foto a mais/menos).
  if (produto.fotos !== null) {
    const atuais = existente.fotos?.length ?? 0;
    if (produto.fotos.length !== atuais) mudancas.push("fotos");
  }
  return mudancas;
}

interface ItemLido {
  linha: number;
  valores: Record<string, unknown>;
}

/** JSON: cada objeto é um item. CSV: a primeira linha é o cabeçalho. */
function lerItens(entrada: EntradaDoPlano): { ok: true; itens: ItemLido[] } | { ok: false; erro: string } {
  if (entrada.formato === "json") {
    const brutos = entrada.itens ?? [];
    const itens: ItemLido[] = [];
    brutos.forEach((bruto, indice) => {
      if (bruto === null || typeof bruto !== "object" || Array.isArray(bruto)) {
        // Fica na lista como valor cru: vira erro daquela linha, não do arquivo.
        itens.push({ linha: indice + 1, valores: { __nao_objeto: bruto } });
        return;
      }
      itens.push({ linha: indice + 1, valores: bruto as Record<string, unknown> });
    });
    return { ok: true, itens };
  }

  const linhas = parseCsv(entrada.conteudo ?? "");
  const cabecalho = linhas[0];
  if (!cabecalho || cabecalho.length === 0) return { ok: false, erro: "o CSV do feed está vazio" };

  const coluna = (campo: string | null | undefined): number => {
    if (!campo) return -1;
    return cabecalho.findIndex((c) => c.trim().toLowerCase() === campo.trim().toLowerCase());
  };

  // Falta de coluna mapeada é defeito do ARQUIVO (o mapeamento não casa com o
  // cabeçalho), e um relatório com 300 erros idênticos não é relatório.
  const obrigatorias: Array<[string, string]> = [
    ["id externo", entrada.mapeamento.id_externo],
    ["nome", entrada.mapeamento.nome],
    ["preço", entrada.mapeamento.preco],
  ];
  const faltando = obrigatorias.filter(([, campo]) => coluna(campo) < 0).map(([rotulo, campo]) => `${rotulo} ("${campo}")`);
  if (faltando.length > 0) {
    return { ok: false, erro: `o CSV não tem a(s) coluna(s) ${faltando.join(", ")} — confira o mapeamento` };
  }

  // As chaves do objeto têm de ser os nomes do FEED (é por eles que
  // `normalizarProdutoDoItem` procura), não os nossos.
  const indices: Array<[string, number]> = [];
  const pares: Array<[string | null | undefined, number]> = [
    [entrada.mapeamento.id_externo, coluna(entrada.mapeamento.id_externo)],
    [entrada.mapeamento.nome, coluna(entrada.mapeamento.nome)],
    [entrada.mapeamento.preco, coluna(entrada.mapeamento.preco)],
    [entrada.mapeamento.descricao, coluna(entrada.mapeamento.descricao)],
    [entrada.mapeamento.marca, coluna(entrada.mapeamento.marca)],
    [entrada.mapeamento.categoria, coluna(entrada.mapeamento.categoria)],
    [entrada.mapeamento.quantidade, coluna(entrada.mapeamento.quantidade)],
    [entrada.mapeamento.fotos, coluna(entrada.mapeamento.fotos)],
  ];
  for (const [campo, indice] of pares) {
    if (campo && indice >= 0) indices.push([campo, indice]);
  }

  const itens: ItemLido[] = [];
  for (let i = 1; i < linhas.length; i += 1) {
    const linha = linhas[i]!;
    if (linha.every((celula) => (celula ?? "").trim() === "")) continue;
    const valores: Record<string, unknown> = {};
    for (const [campo, indice] of indices) valores[campo] = linha[indice] ?? "";
    itens.push({ linha: i + 1, valores });
  }
  return { ok: true, itens };
}

/**
 * O plano da rodada. Não escreve nada e não decide nada de banco: a rota lê o
 * catálogo atual, chama isto, e só então aplica (ou devolve o plano no dry-run).
 */
export function planejarRodadaDoFeed(entrada: EntradaDoPlano): ResultadoDoPlano {
  const lido = lerItens(entrada);
  if (!lido.ok) return { ok: false, erro: lido.erro };

  // O catálogo indexado pela chave do id externo, com o código ORIGINAL
  // guardado: o índice do banco compara texto exato, então "ip15" × "IP15" tem
  // de ser decidido aqui, em memória, e recusado — nunca gravado como segundo
  // produto.
  const porChave = new Map<string, ProdutoExistente[]>();
  for (const existente of entrada.existentes) {
    const chave = chaveDoIdExterno(existente.codigo);
    porChave.set(chave, [...(porChave.get(chave) ?? []), existente]);
  }

  const criar: ItemDoPlano[] = [];
  const atualizar: ItemDoPlano[] = [];
  const inalterados: ItemDoPlano[] = [];
  const errosPorItem: ErroDoItem[] = [];
  const vistos = new Map<string, number>();
  const chavesNoFeed = new Set<string>();

  for (const item of lido.itens) {
    if ("__nao_objeto" in item.valores) {
      errosPorItem.push({ linha: item.linha, id_externo: null, motivo: "o item do feed não é um objeto" });
      continue;
    }

    const normalizado = normalizarProdutoDoItem(item.valores, entrada.mapeamento);
    if (!normalizado.ok) {
      const idBruto = texto(item.valores[entrada.mapeamento.id_externo]);
      errosPorItem.push({ linha: item.linha, id_externo: idBruto, motivo: normalizado.motivo });
      continue;
    }
    const produto = normalizado.produto;
    const chave = chaveDoIdExterno(produto.id_externo);

    const jaVisto = vistos.get(chave);
    if (jaVisto !== undefined) {
      errosPorItem.push({
        linha: item.linha,
        id_externo: produto.id_externo,
        motivo: `id externo repetido no feed — já apareceu na linha ${jaVisto}; só o primeiro vale`,
      });
      continue;
    }
    vistos.set(chave, item.linha);
    chavesNoFeed.add(chave);

    const candidatos = porChave.get(chave) ?? [];
    const mesmoCodigo = candidatos.find((c) => c.codigo === produto.id_externo);
    if (mesmoCodigo) {
      const mudancas = diferencas(produto, mesmoCodigo, entrada.mapeamento);
      if (mudancas.length === 0) {
        inalterados.push({
          acao: "inalterado",
          linha: item.linha,
          produto,
          produto_id: mesmoCodigo.id,
          mudancas: [],
          fotos_antigas: mesmoCodigo.fotos ?? [],
        });
      } else {
        atualizar.push({
          acao: "atualizar",
          linha: item.linha,
          produto,
          produto_id: mesmoCodigo.id,
          mudancas,
          fotos_antigas: mesmoCodigo.fotos ?? [],
        });
      }
      continue;
    }
    if (candidatos.length > 0) {
      errosPorItem.push({
        linha: item.linha,
        id_externo: produto.id_externo,
        motivo:
          `"${produto.id_externo}" já está no catálogo escrito ` +
          candidatos.map((c) => `"${c.codigo}"`).join(", ") +
          " — outra caixa não muda o id externo; escreva igual ao do catálogo para atualizar",
      });
      continue;
    }
    criar.push({
      acao: "criar",
      linha: item.linha,
      produto,
      produto_id: null,
      mudancas: ["nome", "preco_cents"],
      fotos_antigas: [],
    });
  }

  const desativar: ItemDoPlano[] = [];
  if (entrada.desativarAusentes !== false) {
    for (const existente of entrada.existentes) {
      // Só o que o FEED possui sai por ausência. Produto da tela ou da planilha
      // não pode desaparecer porque a revenda publicou um feed parcial.
      if (existente.origem !== ORIGEM_DO_FEED) continue;
      if (!existente.ativo) continue;
      if (chavesNoFeed.has(chaveDoIdExterno(existente.codigo))) continue;
      desativar.push({
        acao: "desativar",
        linha: 0,
        produto: {
          id_externo: existente.codigo,
          nome: existente.nome,
          preco_cents: existente.preco_cents,
          descricao: existente.descricao,
          marca: existente.marca ?? null,
          categoria: existente.categoria ?? null,
          quantidade: existente.quantidade ?? null,
          fotos: existente.fotos ?? null,
        },
        produto_id: existente.id,
        mudancas: [],
        fotos_antigas: existente.fotos ?? [],
      });
    }
  }

  return {
    ok: true,
    plano: {
      criar,
      atualizar,
      desativar,
      inalterados,
      errosPorItem,
      contagem: {
        criar: criar.length,
        atualizar: atualizar.length,
        desativar: desativar.length,
        inalterados: inalterados.length,
      },
    },
  };
}
