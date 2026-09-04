/**
 * Importação de catálogo por planilha (CSV), para quem não tem loja online
 * integrada.
 *
 * O slot "Catálogo" da tela de conhecimento da IA só tinha uma fonte possível:
 * sincronização automática de e-commerce. Quem vende sem loja online integrada
 * (a maioria dos nichos fora de e-commerce) não tinha como preencher esse
 * slot — o card ficava eternamente "Nenhuma fonte configurada".
 *
 * Em vez de inventar um pipeline de busca novo, este módulo só CONVERTE cada
 * linha da planilha no mesmo formato `## Pergunta: / ## Resposta:` que
 * `parseFaqMarkdown` já sabe indexar — reaproveita chunking, embedding e
 * indexação inteiros. Cada produto vira a pergunta que o cliente faria de
 * verdade no WhatsApp ("Quanto custa X?"), porque a busca do RAG casa por
 * similaridade semântica com a MENSAGEM do cliente, não com uma ficha técnica.
 *
 * Erro é POR LINHA, nunca tudo-ou-nada: uma planilha de 200 produtos com um
 * preço mal digitado na linha 87 não pode perder as outras 199 — quem importa
 * isso não é dev, é o dono do negócio, e "a importação falhou" sem dizer qual
 * linha é um beco sem saída para quem não lê stack trace.
 */

import { parseReaisToCents, formatCentsMZN } from "@/lib/money";
import type { FaqItem } from "./faq";

export interface CatalogRowError {
  /** Número da linha na planilha, contando o cabeçalho como linha 1 (o que a pessoa vê no Excel/Sheets). */
  row: number;
  reason: string;
}

export interface CatalogCsvResult {
  items: FaqItem[];
  errors: CatalogRowError[];
}

/**
 * Cabeçalhos aceitos por campo, em português e variações comuns.
 * Comparação é case-insensitive e ignora acento/espaço nas bordas.
 */
const HEADER_ALIASES: Record<string, string[]> = {
  nome: ["nome", "produto", "name", "item"],
  preco: ["preco", "preço", "valor", "price"],
  moeda: ["moeda", "currency"],
  sku: ["sku", "codigo", "código", "code"],
  categoria: ["categoria", "category"],
  variantes: ["variantes", "variacoes", "variações", "variants"],
  estoque: ["estoque", "disponibilidade", "stock"],
};

function normalizarCabecalho(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * Faz o mapa `campo lógico -> índice da coluna` a partir da linha de cabeçalho.
 * Campo sem coluna correspondente fica ausente do mapa (é opcional, exceto nome/preco).
 */
function mapearColunas(headerRow: string[]): Map<string, number> {
  const normalizados = headerRow.map(normalizarCabecalho);
  const mapa = new Map<string, number>();
  for (const [campo, aliases] of Object.entries(HEADER_ALIASES)) {
    const aliasesNorm = aliases.map(normalizarCabecalho);
    const idx = normalizados.findIndex((h) => aliasesNorm.includes(h));
    if (idx !== -1) mapa.set(campo, idx);
  }
  return mapa;
}

/**
 * Quem cola isto veio de uma planilha de verdade (Excel/Sheets): selecionar
 * células e colar num campo de texto gera colunas separadas por TAB, não por
 * vírgula — só um `.csv` exportado explicitamente usa vírgula. Decidir pelo
 * conteúdo (tem TAB na primeira linha → é TAB) evita pedir à pessoa que saiba
 * o que é "delimitador".
 */
function detectarDelimitador(text: string): "," | "\t" {
  const primeiraLinha = text.split("\n", 1)[0] ?? "";
  return primeiraLinha.includes("\t") ? "\t" : ",";
}

/**
 * Parser CSV/TSV mínimo (RFC 4180): aspas duplas escapam o delimitador e
 * quebra de linha dentro do campo; `""` dentro de campo com aspas é uma aspa
 * literal. Sem dependência nova — o formato de planilha colada (Excel/Sheets/
 * Numbers) não passa de delimitador, aspas e quebras de linha.
 */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/\r\n/g, "\n");
  const delim = detectarDelimitador(src);

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  // Última linha sem quebra final.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

function montarResposta(campos: {
  nome: string;
  precoCents: number;
  moeda: string;
  sku?: string;
  categoria?: string;
  variantes?: string;
  estoque?: string;
}): string {
  const precoFmt =
    campos.moeda === "MZN" ? formatCentsMZN(campos.precoCents) : `${(campos.precoCents / 100).toFixed(2)} ${campos.moeda}`;
  const partes: string[] = [`${campos.nome} custa ${precoFmt}.`];
  if (campos.variantes) partes.push(`Opções: ${campos.variantes}.`);
  if (campos.categoria) partes.push(`Categoria: ${campos.categoria}.`);
  if (campos.sku) partes.push(`SKU: ${campos.sku}.`);
  if (campos.estoque) partes.push(`Disponibilidade: ${campos.estoque}.`);
  return partes.join(" ");
}

/**
 * Converte uma planilha CSV de catálogo em itens de pergunta/resposta prontos
 * para `POST /api/v1/ai/knowledge/sources` (mesma forma de `parseFaqMarkdown`).
 *
 * `moedaPadrao` é a moeda do negócio (ex.: "MZN") usada quando a linha não tem
 * coluna própria de moeda — nunca assume BRL.
 */
export function parseCatalogCsv(csv: string, moedaPadrao = "MZN"): CatalogCsvResult {
  const rows = parseCsvRows(csv);
  const items: FaqItem[] = [];
  const errors: CatalogRowError[] = [];

  if (rows.length === 0) {
    return { items, errors: [{ row: 1, reason: "Planilha vazia." }] };
  }

  const headerRow = rows[0];
  if (!headerRow) {
    return { items, errors: [{ row: 1, reason: "Planilha vazia." }] };
  }
  const colunas = mapearColunas(headerRow);

  const idxNome = colunas.get("nome");
  const idxPreco = colunas.get("preco");
  if (idxNome === undefined || idxPreco === undefined) {
    return {
      items,
      errors: [
        {
          row: 1,
          reason:
            'Cabeçalho precisa ter ao menos as colunas "nome" e "preco" (aceita variações como "produto", "preço", "valor").',
        },
      ],
    };
  }
  const idxMoeda = colunas.get("moeda");
  const idxSku = colunas.get("sku");
  const idxCategoria = colunas.get("categoria");
  const idxVariantes = colunas.get("variantes");
  const idxEstoque = colunas.get("estoque");

  for (let i = 1; i < rows.length; i++) {
    const linhaNumero = i + 1; // +1 porque o cabeçalho é a linha 1 na planilha.
    const cols = rows[i];
    if (!cols) continue;

    const nome = (cols[idxNome] ?? "").trim();
    if (!nome) {
      errors.push({ row: linhaNumero, reason: "Sem nome do produto." });
      continue;
    }

    const precoRaw = (cols[idxPreco] ?? "").trim();
    const precoCents = parseReaisToCents(precoRaw);
    if (precoCents === null) {
      errors.push({ row: linhaNumero, reason: `Preço "${precoRaw}" não é um valor válido.` });
      continue;
    }

    const moeda = (idxMoeda !== undefined ? cols[idxMoeda] : "")?.trim().toUpperCase() || moedaPadrao;
    const sku = idxSku !== undefined ? cols[idxSku]?.trim() : undefined;
    const categoria = idxCategoria !== undefined ? cols[idxCategoria]?.trim() : undefined;
    const variantes = idxVariantes !== undefined ? cols[idxVariantes]?.trim() : undefined;
    const estoque = idxEstoque !== undefined ? cols[idxEstoque]?.trim() : undefined;

    items.push({
      question: `Quanto custa ${nome}?`,
      answer: montarResposta({
        nome,
        precoCents,
        moeda,
        sku: sku || undefined,
        categoria: categoria || undefined,
        variantes: variantes || undefined,
        estoque: estoque || undefined,
      }),
      tags: categoria ? [categoria] : [],
      locale: "pt-MZ",
    });
  }

  return { items, errors };
}
