import { MAXIMO_DE_FOTOS } from "@/lib/catalogo/fotos";
import { parseCsv } from "@/lib/contacts/csv";
import { precoParaCentavos } from "@/lib/schemas/produtos";

/**
 * A FONTE DE CATÁLOGO SINCRONIZADA — o feed da revenda vira PLANO de rodada.
 *
 * ─── O gesto real (issue #3587, fatia 2) ────────────────────────────────────
 *
 * A revenda já publica o estoque dela num feed JSON (ou CSV) que o site consome.
 * O que ela NÃO quer é reimportar planilha a cada mudança de preço: quer que o
 * CRM descubra sozinho o que nasceu, o que mudou de preço e o que saiu de linha.
 * Este módulo é a régua dessa descoberta, e ele é PURO de propósito — sem banco,
 * sem rede, sem `fetch` — para que a regra rode em teste unitário em todo `pnpm
 * test` e não dependa de PostgREST para ser verdadeira.
 *
 * ─── Três decisões que o resto do arquivo defende ───────────────────────────
 *
 * 1. **O id externo é a CHAVE.** Não o nome (muda de grafia a cada revisão do
 *    anúncio) e não a posição no feed (muda quando o fornecedor reordena). Sem
 *    id externo o item é RECUSADO — um catálogo que casa por nome duplica
 *    produto, e produto duplicado é dois preços para o mesmo item na conversa
 *    com o cliente.
 *
 * 2. **O que saiu do feed é DESATIVADO, nunca apagado.** A linha do produto é
 *    referenciada por histórico de conversa e por proposta enviada; apagá-la
 *    deixaria a proposta apontando para o nada. Quem sai de linha vira
 *    `ativo = false`, e a tela continua mostrando o que existiu.
 *
 * 3. **A rodada não aborta por causa de um item.** Item sem preço legível, id
 *    repetido ou foto que não é URL entram em `errosPorItem` com o motivo, e os
 *    outros itens entram normalmente. Recusar o feed inteiro por uma linha
 *    deixaria a revenda sem sincronizar nada por causa de um anúncio torto.
 *
 * ─── O que o feed NÃO decide ────────────────────────────────────────────────
 *
 * Preço é comparado em CENTAVOS (`precoParaCentavos`, a mesma régua da planilha
 * e do schema da API): "R$ 1.000,00", "1000" e "1.000" são o mesmo número, e um
 * feed que reescreve a formatação não pode reescrever o produto. Fotos são
 * comparadas NA ORDEM, porque a primeira é a capa. E a coluna de foto ausente
 * (ou a célula vazia) NÃO apaga a foto que a tela gravou — o feed só fala do que
 * ele traz.
 */

export const FORMATOS_DO_FEED = ["json", "csv"] as const;
export type FormatoDoFeed = (typeof FORMATOS_DO_FEED)[number];

/** Os campos que o feed pode alimentar. `id_externo` é obrigatório em todo item. */
export const CAMPOS_DO_FEED = [
  "id_externo",
  "nome",
  "preco",
  "descricao",
  "fotos",
  "quantidade",
] as const;
export type CampoDoFeed = (typeof CAMPOS_DO_FEED)[number];

/**
 * Campo do produto → chave do item no feed. O que não estiver mapeado usa os
 * apelidos abaixo, que são os nomes que os feeds de revenda realmente usam (em
 * português, inglês e espanhol). O mapeamento explícito TIRA o campo dos
 * apelidos: quem disse "o nome está em `title`" não quer que `nome` também
 * case — duas colunas no mesmo posto é a segunda verdade sobre o campo.
 */
export type MapeamentoDoFeed = Partial<Record<CampoDoFeed, string>>;

const APELIDOS: Record<CampoDoFeed, readonly string[]> = {
  id_externo: [
    "id_externo",
    "id externo",
    "external_id",
    "external id",
    "externalid",
    "id",
    "codigo",
    "código",
    "sku",
    "ref",
    "referencia",
    "referência",
    "codigo externo",
  ],
  nome: ["nome", "name", "titulo", "título", "title", "produto", "product", "nombre", "producto"],
  preco: ["preco", "preço", "price", "valor", "precio", "preco de venda", "preco_cents", "preco em centavos"],
  descricao: ["descricao", "descrição", "description", "descripcion", "descripción"],
  fotos: [
    "fotos",
    "foto",
    "imagem",
    "imagens",
    "image",
    "images",
    "photo",
    "photos",
    "url da foto",
    "urls das fotos",
    "url_da_foto",
  ],
  quantidade: ["quantidade", "estoque", "stock", "qty", "quantity", "cantidad", "existencias"],
};

/** O que já existe no catálogo da organização — o outro lado da comparação. */
export interface ProdutoDoCatalogo {
  id: string;
  id_externo: string | null;
  nome: string;
  descricao: string | null;
  preco_cents: number;
  fotos: readonly string[] | null;
  quantidade: number;
  ativo: boolean;
}

export interface ProdutoParaCriar {
  id_externo: string;
  /** `codigo` é a identidade da tabela (`organization_id, codigo`), derivada do id externo. */
  codigo: string;
  nome: string;
  descricao: string | null;
  preco_cents: number;
  /** URLs a baixar — `null` = o feed não falou de foto. */
  fotos: string[] | null;
  quantidade: number | null;
}

export interface CamposDoProduto {
  nome?: string;
  descricao?: string;
  preco_cents?: number;
  /** URLs a baixar e substituir, na ordem — só quando o feed trouxe foto. */
  fotos?: string[];
  quantidade?: number;
}

export interface ProdutoParaAtualizar {
  id: string;
  id_externo: string;
  campos: CamposDoProduto;
  /** Os nomes dos campos que mudaram — é o que a resposta mostra por item. */
  mudou: string[];
}

export interface ProdutoParaDesativar {
  id: string;
  id_externo: string;
  nome: string;
}

export interface ErroDoItem {
  /** O id externo quando existe; `#3` (posição no feed) quando é o que falta. */
  referencia: string;
  motivo: string;
}

export interface PlanoDaRodada {
  criar: ProdutoParaCriar[];
  atualizar: ProdutoParaAtualizar[];
  desativar: ProdutoParaDesativar[];
  inalterados: number;
  errosPorItem: ErroDoItem[];
}

export interface ResumoDoPlano {
  criar: number;
  atualizar: number;
  desativar: number;
  inalterados: number;
  erros: number;
}

export function resumoDoPlano(plano: PlanoDaRodada): ResumoDoPlano {
  return {
    criar: plano.criar.length,
    atualizar: plano.atualizar.length,
    desativar: plano.desativar.length,
    inalterados: plano.inalterados,
    erros: plano.errosPorItem.length,
  };
}

type Tradutor = (texto: string) => string;
const semTraducao: Tradutor = (texto) => texto;

/** NFD sem acento, caixa baixa, separador único: "ID Externo" = "id_externo". */
function normalizarChave(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function campoDaChave(chave: string, mapeamento: MapeamentoDoFeed): CampoDoFeed | null {
  const alvo = normalizarChave(chave);
  for (const campo of CAMPOS_DO_FEED) {
    const explicito = mapeamento[campo];
    if (explicito !== undefined) {
      if (normalizarChave(explicito) === alvo) return campo;
      continue;
    }
    if (APELIDOS[campo].some((apelido) => normalizarChave(apelido) === alvo)) return campo;
  }
  return null;
}

/** Texto de célula/item: espaços colapsados e sem sobra nas pontas. */
function textoNormalizado(valor: unknown): string {
  if (valor === null || valor === undefined) return "";
  if (typeof valor === "object") return "";
  return String(valor).replace(/\s+/g, " ").trim();
}

/** A chave de casamento: o id externo não diferencia maiúsculas, como o `codigo` da planilha. */
export function chaveDoIdExterno(id: string): string {
  return id.trim().toLowerCase();
}

/**
 * O código do produto, derivado do id externo — `catalog_products.codigo` é
 * `text` sem teto, mas o resto do sistema (schema da API, planilha) trata 60
 * como o limite prático. Passando disso, o corte leva uma assinatura do texto
 * INTEIRO: dois ids que só diferem depois do caractere 60 não podem virar o
 * mesmo produto (o índice único `(organization_id, codigo)` recusaria o
 * segundo e o item sumiria do catálogo sem explicação).
 */
const LIMITE_DO_CODIGO = 60;

function assinaturaDoTexto(texto: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i += 1) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function codigoDoIdExterno(id: string): string {
  const base = id.replace(/\s+/g, " ").trim();
  if (base.length <= LIMITE_DO_CODIGO) return base;
  const corte = base.slice(0, LIMITE_DO_CODIGO - 9).trimEnd();
  return `${corte}-${assinaturaDoTexto(base)}`;
}

/** Os esquemas que o servidor consegue baixar. `data:`/`file:` morreriam longe do item. */
const ESQUEMAS_DE_FOTO = new Set(["http:", "https:"]);

/**
 * As fotos do item, na ordem — ou a recusa do item.
 *
 * A recusa é do ITEM inteiro (como na planilha): guardar 3 das 5 fotos deixaria
 * a capa errada sem ninguém perceber, e o produto com a foto de outro anúncio é
 * pior que o item esperando a correção do feed.
 */
function fotosDoItem(
  valor: unknown,
  t: Tradutor,
): { ok: true; fotos: string[] | null } | { ok: false; motivo: string } {
  const brutas = Array.isArray(valor)
    ? valor.map((v) => textoNormalizado(v))
    : textoNormalizado(valor).split("|").map((v) => v.trim());
  const urls = brutas.filter((u) => u !== "");
  if (urls.length === 0) return { ok: true, fotos: null };

  if (urls.length > MAXIMO_DE_FOTOS) {
    return {
      ok: false,
      motivo: t("o item traz {quantidade} fotos — o produto aceita até {limite}")
        .replace("{quantidade}", String(urls.length))
        .replaceAll("{limite}", String(MAXIMO_DE_FOTOS)),
    };
  }

  for (const url of urls) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    if (!parsed || !ESQUEMAS_DE_FOTO.has(parsed.protocol) || parsed.hostname === "") {
      return {
        ok: false,
        motivo: t('foto não reconhecida ("{url}") — use o endereço completo, começando com http:// ou https://').replace(
          "{url}",
          () => url,
        ),
      };
    }
  }
  return { ok: true, fotos: urls };
}

/** Quantidade inteira não negativa; célula vazia = "o feed não falou de estoque". */
function quantidadeDoItem(valor: unknown): { ok: true; quantidade: number | null } | { ok: false } {
  const texto = textoNormalizado(valor);
  if (texto === "") return { ok: true, quantidade: null };
  if (!/^(?:\d+|\d{1,3}([., \u00a0])\d{3}(?:\1\d{3})*)$/.test(texto)) return { ok: false };
  const numero = Number(texto.replace(/[., \u00a0]/g, ""));
  if (!Number.isInteger(numero) || numero < 0 || numero > 2_147_483_647) return { ok: false };
  return { ok: true, quantidade: numero };
}

export type LeituraDoFeed =
  | { ok: true; registros: Record<string, unknown>[]; formato: FormatoDoFeed }
  | { ok: false; motivo: string };

/** As chaves do envelope que os feeds usam quando o topo não é a lista. */
const ENVELOPES = ["itens", "items", "produtos", "products", "data"];

/**
 * O TEXTO do feed vira registros — e nada mais.
 *
 * JSON é o formato obrigatório; CSV entra pelo mesmo caminho porque o parser é
 * o RFC 4180 que o importador de contatos já usa (`parseCsv` detecta `,` e `;`,
 * e o Excel em português exporta com `;`). Copiar o parser para cá criaria a
 * segunda verdade sobre o que é um CSV.
 *
 * Um feed ilegível é RECUSA INTEIRA, e não "catálogo vazio": a diferença é a
 * única coisa que separa "a revenda não tem produtos" de "o site da revenda
 * respondeu uma página de erro em HTML" — e a segunda, tratada como a primeira,
 * desativaria o catálogo inteiro.
 */
export function lerFeed(conteudo: string, formato: FormatoDoFeed): LeituraDoFeed {
  const texto = conteudo.replace(/^\uFEFF/, "").trim();
  if (texto === "") return { ok: false, motivo: "O feed está vazio." };

  if (formato === "json") {
    let corpo: unknown;
    try {
      corpo = JSON.parse(texto);
    } catch {
      return { ok: false, motivo: "O feed não é um JSON válido." };
    }
    if (Array.isArray(corpo)) return { ok: true, registros: corpo as Record<string, unknown>[], formato };
    if (corpo !== null && typeof corpo === "object") {
      const envelope = corpo as Record<string, unknown>;
      for (const chave of ENVELOPES) {
        const lista = envelope[chave];
        if (Array.isArray(lista)) {
          return { ok: true, registros: lista as Record<string, unknown>[], formato };
        }
      }
    }
    return {
      ok: false,
      motivo: "O JSON do feed precisa ser uma lista de itens (ou trazer `itens`/`produtos` como lista).",
    };
  }

  const linhas = parseCsv(texto).filter((linha) => linha.some((celula) => celula.trim() !== ""));
  if (linhas.length === 0) return { ok: false, motivo: "O feed está vazio." };
  if (linhas.length === 1) return { ok: false, motivo: "O CSV do feed só tem o cabeçalho." };

  const cabecalho = linhas[0]!;
  const registros: Record<string, unknown>[] = [];
  for (let i = 1; i < linhas.length; i += 1) {
    const linha = linhas[i]!;
    const registro: Record<string, unknown> = {};
    cabecalho.forEach((titulo, coluna) => {
      const chave = titulo.trim();
      if (chave !== "") registro[chave] = linha[coluna] ?? "";
    });
    registros.push(registro);
  }
  return { ok: true, registros, formato };
}

interface OpcoesDoPlano {
  existentes: readonly ProdutoDoCatalogo[];
  mapeamento?: MapeamentoDoFeed;
  t?: Tradutor;
}

/**
 * REGISTROS + o que já existe ⇒ o plano da rodada.
 *
 * Separado de `planejarFeed` porque quem já tem os registros na mão (a rota que
 * recebeu a lista inline, o teste) não precisa serializar nada.
 */
export function planejarRodada(registros: readonly unknown[], opcoes: OpcoesDoPlano): PlanoDaRodada {
  const t = opcoes.t ?? semTraducao;
  const mapeamento = opcoes.mapeamento ?? {};

  const porChave = new Map<string, ProdutoDoCatalogo>();
  for (const produto of opcoes.existentes) {
    if (produto.id_externo === null) continue;
    porChave.set(chaveDoIdExterno(produto.id_externo), produto);
  }

  const plano: PlanoDaRodada = { criar: [], atualizar: [], desativar: [], inalterados: 0, errosPorItem: [] };
  /**
   * Todo id que o feed TROUXE, mesmo o do item recusado por preço ilegível: o
   * produto continua no feed, então desativá-lo seria mentir sobre o estoque.
   */
  const vistosNoFeed = new Set<string>();

  registros.forEach((registro, indice) => {
    const posicao = `#${indice + 1}`;
    if (registro === null || typeof registro !== "object" || Array.isArray(registro)) {
      plano.errosPorItem.push({ referencia: posicao, motivo: t("o item do feed não é um objeto") });
      return;
    }

    const campos = new Map<CampoDoFeed, unknown>();
    for (const [chave, valor] of Object.entries(registro as Record<string, unknown>)) {
      const campo = campoDaChave(chave, mapeamento);
      // A PRIMEIRA coluna que casa vale: duas colunas no mesmo posto é feed
      // torto, e escolher a última faria a resposta depender da ordem das chaves.
      if (campo && !campos.has(campo)) campos.set(campo, valor);
    }

    const idExterno = textoNormalizado(campos.get("id_externo"));
    if (idExterno === "") {
      plano.errosPorItem.push({
        referencia: posicao,
        motivo: t("item sem id externo — o feed precisa de uma coluna de identificação"),
      });
      return;
    }

    const chave = chaveDoIdExterno(idExterno);
    if (vistosNoFeed.has(chave)) {
      plano.errosPorItem.push({
        referencia: idExterno,
        motivo: t('id externo repetido no feed ("{id}") — só o primeiro vale').replace("{id}", () => idExterno),
      });
      return;
    }
    vistosNoFeed.add(chave);

    const nome = textoNormalizado(campos.get("nome"));
    if (nome === "") {
      plano.errosPorItem.push({ referencia: idExterno, motivo: t("item sem nome do produto") });
      return;
    }

    const precoBruto = textoNormalizado(campos.get("preco"));
    const preco_cents = precoParaCentavos(precoBruto);
    if (preco_cents === null) {
      plano.errosPorItem.push({
        referencia: idExterno,
        motivo: t('preço não reconhecido ("{valor}") — escreva assim: 5.499,00').replace("{valor}", () => precoBruto),
      });
      return;
    }

    const fotos = fotosDoItem(campos.get("fotos"), t);
    if (!fotos.ok) {
      plano.errosPorItem.push({ referencia: idExterno, motivo: fotos.motivo });
      return;
    }

    const quantidade = quantidadeDoItem(campos.get("quantidade"));
    if (!quantidade.ok) {
      plano.errosPorItem.push({
        referencia: idExterno,
        motivo: t('quantidade inválida ("{valor}") — use um número inteiro').replace(
          "{valor}",
          () => textoNormalizado(campos.get("quantidade")),
        ),
      });
      return;
    }

    const descricao = textoNormalizado(campos.get("descricao"));
    const atual = porChave.get(chave);

    if (!atual) {
      plano.criar.push({
        id_externo: idExterno,
        codigo: codigoDoIdExterno(idExterno),
        nome,
        descricao: descricao === "" ? null : descricao,
        preco_cents,
        fotos: fotos.fotos,
        quantidade: quantidade.quantidade,
      });
      return;
    }

    // ─── Comparação por VALOR, não por texto ─────────────────────────────────
    // Preço já está em centavos; foto é comparada com a ordem (a primeira é a
    // capa); descrição vazia no feed não apaga a que a tela escreveu.
    const camposNovos: CamposDoProduto = {};
    const mudou: string[] = [];

    if (atual.nome !== nome) {
      camposNovos.nome = nome;
      mudou.push("nome");
    }
    if (descricao !== "" && (atual.descricao ?? "") !== descricao) {
      camposNovos.descricao = descricao;
      mudou.push("descricao");
    }
    if (atual.preco_cents !== preco_cents) {
      camposNovos.preco_cents = preco_cents;
      mudou.push("preco_cents");
    }
    if (fotos.fotos !== null) {
      const atuais = atual.fotos ?? [];
      const iguais = atuais.length === fotos.fotos.length && atuais.every((foto, i) => foto === fotos.fotos![i]);
      if (!iguais) {
        camposNovos.fotos = fotos.fotos;
        mudou.push("fotos");
      }
    }
    if (quantidade.quantidade !== null && atual.quantidade !== quantidade.quantidade) {
      camposNovos.quantidade = quantidade.quantidade;
      mudou.push("quantidade");
    }

    /**
     * Produto que VOLTOU ao feed: reativar é parte de "atualizar". Sem isto, o
     * item reapareceria no feed e continuaria invisível para o agente — e quem
     * pôs o produto de volta não teria como saber que faltava um clique.
     */
    const reativar = atual.ativo === false;
    if (reativar) mudou.push("ativo");

    if (mudou.length === 0) {
      plano.inalterados += 1;
      return;
    }

    plano.atualizar.push({
      id: atual.id,
      id_externo: idExterno,
      campos: camposNovos,
      mudou,
    });

  });

  // ─── O que saiu do feed ───────────────────────────────────────────────────
  // Só o que é DESTA fonte e está ATIVO: produto manual (`id_externo` nulo) não
  // é do feed, e o que já está desativado não tem o que desativar de novo.
  for (const produto of porChave.values()) {
    if (!produto.ativo) continue;
    if (vistosNoFeed.has(chaveDoIdExterno(produto.id_externo!))) continue;
    plano.desativar.push({ id: produto.id, id_externo: produto.id_externo!, nome: produto.nome });
  }

  return plano;
}

export type ResultadoDoPlanejamento = { ok: true; plano: PlanoDaRodada } | { ok: false; motivo: string };

/** O atalho da rota e do cron: texto do feed direto para o plano. */
export function planejarFeed(
  entrada: { conteudo: string; formato: FormatoDoFeed } & OpcoesDoPlano,
): ResultadoDoPlanejamento {
  const leitura = lerFeed(entrada.conteudo, entrada.formato);
  if (!leitura.ok) return { ok: false, motivo: leitura.motivo };
  return {
    ok: true,
    plano: planejarRodada(leitura.registros, {
      existentes: entrada.existentes,
      mapeamento: entrada.mapeamento,
      t: entrada.t,
    }),
  };
}
