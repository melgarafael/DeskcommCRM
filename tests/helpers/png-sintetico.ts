/**
 * PNG de verdade, escrito e lido SEM canvas — o que os testes do ajuste de logo
 * precisam para medir bytes de verdade.
 *
 * ── Por que um codec aqui dentro ──────────────────────────────────────────────
 *
 * O ajuste roda no navegador, sobre `<canvas>`; o jsdom da suíte não tem canvas
 * (o pacote `canvas` não é dependência deste repositório) e instalar um raster
 * nativo só para teste estaria fora do alcance permitido do PR. A alternativa
 * seria um motor FALSO que "devolve" um tamanho de arquivo calculado — aí o
 * teste provaria a calculadora do teste, não o recorte.
 *
 * Então este arquivo é o motor de verdade, só que sobre PNG: codifica e decodifica
 * o formato (assinatura, IHDR, IDAT, IEND, CRC-32, filtro por linha, zlib do
 * próprio Node). O que o teste afirma sobre o ARQUIVO AJUSTADO — tamanho ≤ teto,
 * dimensões da caixa útil, alfa preservado — sai de bytes lidos do PNG, não de
 * uma estimativa.
 *
 * O que ele NÃO faz: JPEG (o farejador do servidor aceita, mas o caso da issue é
 * PNG com fundo transparente) e interlace (Adam7). Os dois exigiriam bem mais
 * código para nenhum dos cenários da issue.
 */
import { deflateSync, inflateSync } from "node:zlib";

import type { Caixa, MotorDeAjuste } from "@/lib/branding/ajuste-de-logo";

/** `89 50 4E 47 0D 0A 1A 0A` — RFC 2083 §3.1. */
const ASSINATURA = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Tabela do CRC-32 (mesmo polinômio do PNG: 0xEDB88320). */
const TABELA_CRC = (() => {
  const tabela = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabela[n] = c >>> 0;
  }
  return tabela;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  // O `?? 0` é de TIPO, não de cálculo: `noUncheckedIndexedAccess` vê toda
  // leitura de tabela como possivelmente vazia, e o índice aqui já está em 0..255.
  for (const b of bytes) c = (TABELA_CRC[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concatenar(pedacos: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = pedacos.reduce((soma, p) => soma + p.length, 0);
  const saida = new Uint8Array(total);
  let offset = 0;
  for (const p of pedacos) {
    saida.set(p, offset);
    offset += p.length;
  }
  return saida;
}

/** `<tamanho><tipo><dados><crc do tipo+dados>` — o envelope de todo chunk. */
function chunk(tipo: string, dados: Uint8Array): Uint8Array {
  const corpo = new Uint8Array(4 + dados.length);
  for (let i = 0; i < 4; i++) corpo[i] = tipo.charCodeAt(i);
  corpo.set(dados, 4);
  const saida = new Uint8Array(4 + corpo.length + 4);
  const vista = new DataView(saida.buffer);
  vista.setUint32(0, dados.length);
  saida.set(corpo, 4);
  vista.setUint32(4 + corpo.length, crc32(corpo));
  return saida;
}

/**
 * Um PNG RGBA de 8 bits, com filtro 0 (None) em toda linha.
 *
 * `Uint8Array<ArrayBuffer>` no retorno porque o destino destes bytes é um
 * `new File([...])` (`BlobPart`), que recusa o `Uint8Array<ArrayBufferLike>`
 * genérico — ver `MotorDeAjuste` em `lib/branding/ajuste-de-logo.ts`.
 */
export function montarPng(
  largura: number,
  altura: number,
  rgba: Uint8Array,
): Uint8Array<ArrayBuffer> {
  if (rgba.length !== largura * altura * 4) {
    throw new Error(
      `rgba tem ${rgba.length} bytes; ${largura}×${altura}×4 pede ${largura * altura * 4}`,
    );
  }
  const cru = new Uint8Array(altura * (1 + largura * 4));
  for (let y = 0; y < altura; y++) {
    const origem = y * largura * 4;
    const destino = y * (1 + largura * 4);
    cru[destino] = 0;
    cru.set(rgba.subarray(origem, origem + largura * 4), destino + 1);
  }
  const ihdr = new Uint8Array(13);
  const vista = new DataView(ihdr.buffer);
  vista.setUint32(0, largura);
  vista.setUint32(4, altura);
  ihdr[8] = 8; // profundidade
  ihdr[9] = 6; // cor: RGBA
  const idat = new Uint8Array(deflateSync(cru, { level: 6 }));
  return concatenar([
    ASSINATURA,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

export interface PngLido {
  readonly largura: number;
  readonly altura: number;
  /** `largura × altura × 4`, RGBA sem filtro — o que saiu da linha decodificada. */
  readonly rgba: Uint8Array;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Lê o que `montarPng` escreve — e qualquer PNG RGBA de 8 bits sem entrelaçamento. */
export function lerPng(bytes: Uint8Array): PngLido {
  if (bytes.length < ASSINATURA.length || !ASSINATURA.every((b, i) => bytes[i] === b)) {
    throw new Error("não é PNG: assinatura ausente");
  }
  const vista = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let largura = 0;
  let altura = 0;
  const idats: Uint8Array[] = [];
  let pos = ASSINATURA.length;
  while (pos + 12 <= bytes.length) {
    const comprimento = vista.getUint32(pos);
    const tipo = String.fromCharCode(
      bytes[pos + 4] ?? 0,
      bytes[pos + 5] ?? 0,
      bytes[pos + 6] ?? 0,
      bytes[pos + 7] ?? 0,
    );
    const dados = bytes.subarray(pos + 8, pos + 8 + comprimento);
    if (tipo === "IHDR") {
      largura = vista.getUint32(pos + 8);
      altura = vista.getUint32(pos + 12);
      const profundidade = bytes[pos + 16];
      const cor = bytes[pos + 17];
      const entrelacamento = bytes[pos + 20];
      if (profundidade !== 8 || cor !== 6 || entrelacamento !== 0) {
        throw new Error(
          `PNG não suportado aqui: profundidade=${profundidade} cor=${cor} entrelaçamento=${entrelacamento}`,
        );
      }
    } else if (tipo === "IDAT") {
      idats.push(dados);
    } else if (tipo === "IEND") {
      break;
    }
    pos += 12 + comprimento;
  }
  if (largura === 0 || altura === 0 || idats.length === 0)
    throw new Error("PNG incompleto: falta IHDR ou IDAT");

  const passo = largura * 4;
  const cru = new Uint8Array(inflateSync(concatenar(idats)));
  if (cru.length !== altura * (1 + passo))
    throw new Error("IDAT não bate com as dimensões do IHDR");

  const saida = new Uint8Array(altura * passo);
  let anterior = new Uint8Array(passo);
  let linha = new Uint8Array(passo);
  for (let y = 0; y < altura; y++) {
    const inicio = y * (1 + passo);
    const filtro = cru[inicio];
    linha.set(cru.subarray(inicio + 1, inicio + 1 + passo));
    switch (filtro) {
      case 0:
        break;
      case 1:
        for (let i = 4; i < passo; i++) linha[i] = ((linha[i] ?? 0) + (linha[i - 4] ?? 0)) & 0xff;
        break;
      case 2:
        for (let i = 0; i < passo; i++) linha[i] = ((linha[i] ?? 0) + (anterior[i] ?? 0)) & 0xff;
        break;
      case 3:
        for (let i = 0; i < passo; i++) {
          const esquerda = i >= 4 ? (linha[i - 4] ?? 0) : 0;
          linha[i] = ((linha[i] ?? 0) + ((esquerda + (anterior[i] ?? 0)) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < passo; i++) {
          const esquerda = i >= 4 ? (linha[i - 4] ?? 0) : 0;
          const canto = i >= 4 ? (anterior[i - 4] ?? 0) : 0;
          linha[i] = ((linha[i] ?? 0) + paeth(esquerda, anterior[i] ?? 0, canto)) & 0xff;
        }
        break;
      default:
        throw new Error(`filtro de linha desconhecido: ${filtro}`);
    }
    saida.set(linha, y * passo);
    [anterior, linha] = [linha, anterior];
  }
  return { largura, altura, rgba: saida };
}

/** PRNG determinístico — os bytes do teste não podem variar de um run para o outro. */
function mulberry32(semente: number): () => number {
  let a = semente >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Ruído COMPRESSÍVEL: só 16 valores por canal.
 *
 * É o que dá ao arquivo um tamanho grande mas estável (~2 bytes/pixel depois do
 * deflate), para o teste poder afirmar "passou do teto" e "cabe depois do
 * recorte" sem acertar no limite por poucos KB.
 */
export function ruidoQuantizado(
  largura: number,
  altura: number,
  semente: number,
): Uint8Array<ArrayBuffer> {
  const sorteio = mulberry32(semente);
  const rgba = new Uint8Array(largura * altura * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = Math.floor(sorteio() * 16) * 17;
  return rgba;
}

/**
 * Ruído INCOMPRESSÍVEL: byte aleatório de verdade.
 *
 * Servem pro caminho de recusa: nem reduzindo a largura até o piso, o deflate
 * não tira nada de um arquivo assim.
 */
export function ruidoPuro(
  largura: number,
  altura: number,
  semente: number,
): Uint8Array<ArrayBuffer> {
  const sorteio = mulberry32(semente);
  const rgba = new Uint8Array(largura * altura * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = Math.floor(sorteio() * 256);
  return rgba;
}

/** O menor retângulo com algum pixel de alfa > 0. `null` = nada a recortar. */
export function caixaUtil(png: PngLido): Caixa | null {
  let minX = png.largura;
  let minY = png.altura;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < png.altura; y++) {
    for (let x = 0; x < png.largura; x++) {
      if (png.rgba[(y * png.largura + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  if (minX === 0 && minY === 0 && maxX === png.largura - 1 && maxY === png.altura - 1) return null;
  return { x: minX, y: minY, largura: maxX - minX + 1, altura: maxY - minY + 1 };
}

/** Recorta (vizinho mais próximo) e reduz — o mesmo contrato do motor do navegador. */
function recortarEReduzir(png: PngLido, alvo: { caixa: Caixa | null; escala: number }): Uint8Array {
  const origem = alvo.caixa ?? { x: 0, y: 0, largura: png.largura, altura: png.altura };
  const largura = Math.max(1, Math.round(origem.largura * alvo.escala));
  const altura = Math.max(1, Math.round(origem.altura * alvo.escala));
  const saida = new Uint8Array(largura * altura * 4);
  for (let y = 0; y < altura; y++) {
    const sy = origem.y + Math.min(origem.altura - 1, Math.floor((y * origem.altura) / altura));
    for (let x = 0; x < largura; x++) {
      const sx =
        origem.x + Math.min(origem.largura - 1, Math.floor((x * origem.largura) / largura));
      const de = (sy * png.largura + sx) * 4;
      saida.set(png.rgba.subarray(de, de + 4), (y * largura + x) * 4);
    }
  }
  return saida;
}

/**
 * O motor do ajuste sobre PNG — o `<canvas>` de mentira que mede de VERDADE.
 *
 * Existe um só, compartilhado por quem precisa exercer o ajuste: a suíte de
 * `ajuste-de-logo` (a escada de tentativas) e a do campo de logo (o upload
 * passando por ele). Duas cópias do mesmo motor dariam duas noções diferentes do
 * que "recortar e reduzir" significa, e o dia em que uma mudasse a outra ficaria
 * verde medindo outra coisa.
 */
export const motorDePngSintetico: MotorDeAjuste = {
  async inspecionar(arquivo: File) {
    const png = lerPng(new Uint8Array(await arquivo.arrayBuffer()));
    return { largura: png.largura, altura: png.altura, caixa: caixaUtil(png) };
  },
  async reencodar(arquivo: File, alvo) {
    const png = lerPng(new Uint8Array(await arquivo.arrayBuffer()));
    const recorte = recortarEReduzir(png, alvo);
    return montarPng(
      Math.max(1, Math.round((alvo.caixa?.largura ?? png.largura) * alvo.escala)),
      Math.max(1, Math.round((alvo.caixa?.altura ?? png.altura) * alvo.escala)),
      recorte,
    );
  },
};
