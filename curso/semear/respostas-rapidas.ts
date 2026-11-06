/**
 * Semente do módulo "Respostas rápidas": além das 3 compartilhadas da base,
 * uma pessoal da Helena, uma compartilhada com imagem e uma de áudio — os quatro
 * selos que a lista mostra. A imagem e o áudio sobem de verdade para o bucket, no caminho que a rota de upload geraria: a prévia do
 * formulário de edição busca os bytes pela rota GET /midias/:indice.
 *
 * Idempotente: apaga só as linhas de ids fixos daqui; o arquivo sobe com upsert.
 */
import { deflateSync } from "node:zlib";

import { type Contexto, semErro } from "../semear-demonstracao";

const id = (n: number) => `a1a1e000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ARQUIVO_IMAGEM = "a1a1e100-0000-4000-8000-000000000001.png";
const ARQUIVO_AUDIO = "a1a1e100-0000-4000-8000-000000000002.wav";

function crc32(buf: Buffer) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function bloco(tipo: string, dados: Buffer) {
  const corpo = Buffer.concat([Buffer.from(tipo, "ascii"), dados]);
  const tam = Buffer.alloc(4), crc = Buffer.alloc(4);
  tam.writeUInt32BE(dados.length);
  crc.writeUInt32BE(crc32(corpo));
  return Buffer.concat([tam, corpo, crc]);
}
/** Letras 5x7 só das que o cartão usa. */
const FONTE: Record<string, string[]> = {
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
};
/** Cartão de visita da clínica, 240x160, PNG RGB: faixa verde com "CLINICA", "BEM VIVER" e linhas de contato. */
function cartaoPng() {
  const L = 240, A = 160;
  const VERDE = [47, 125, 109], BRANCO = [255, 255, 255], CINZA = [170, 176, 174];
  const px = Array.from({ length: A }, (_, y) => Array.from({ length: L }, () => (y < 40 ? VERDE : BRANCO)));
  const escrever = (texto: string, y0: number, escala: number, cor: number[]) => {
    const largura = texto.length * 6 * escala - escala;
    let x0 = Math.round((L - largura) / 2);
    for (const letra of texto) {
      FONTE[letra]?.forEach((linha, gy) =>
        [...linha].forEach((b, gx) => {
          if (b !== "1") return;
          for (let dy = 0; dy < escala; dy++) for (let dx = 0; dx < escala; dx++) px[y0 + gy * escala + dy]![x0 + gx * escala + dx] = cor;
        }),
      );
      x0 += 6 * escala;
    }
  };
  escrever("CLINICA", 13, 2, BRANCO);
  escrever("BEM VIVER", 58, 3, VERDE);
  for (const [y, w] of [[104, 140], [118, 110], [132, 124]] as const)
    for (let x = (L - w) / 2; x < (L + w) / 2; x++) for (let dy = 0; dy < 5; dy++) px[y + dy]![x] = CINZA;
  const linhas = px.map((linha) => {
    const b = Buffer.alloc(1 + L * 3);
    linha.forEach((cor, x) => b.set(cor, 1 + x * 3));
    return b;
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(L, 0);
  ihdr.writeUInt32BE(A, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    bloco("IHDR", ihdr),
    bloco("IDAT", deflateSync(Buffer.concat(linhas))),
    bloco("IEND", Buffer.alloc(0)),
  ]);
}
/** 1 segundo de silêncio, WAV 8 kHz 8 bits mono. */
function silencioWav() {
  const n = 8000, h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + n, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24); h.writeUInt32LE(8000, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34);
  h.write("data", 36); h.writeUInt32LE(n, 40);
  return Buffer.concat([h, Buffer.alloc(n, 0x80)]);
}

export async function semear(c: Contexto) {
  const { db, org, pessoa } = c;
  const ids = [1, 2, 3, 4].map(id);
  semErro(await db.from("message_templates").delete().eq("organization_id", org).in("id", ids), "limpar respostas do módulo");

  const imagem = cartaoPng(), audio = silencioWav();
  const caminho = (arquivo: string, n: number) => `${org}/templates/${id(n)}/${arquivo}`;
  for (const [arquivo, n, bytes, tipo] of [[ARQUIVO_IMAGEM, 3, imagem, "image/png"], [ARQUIVO_AUDIO, 4, audio, "audio/wav"]] as const) {
    semErro(await db.storage.from("whatsapp-media").upload(caminho(arquivo, n), bytes, { contentType: tipo, upsert: true }), `subir ${arquivo}`);
  }

  // ordem > 0: a base nasce com ordem 0, então estas vêm depois das 3 dela
  semErro(await db.from("message_templates").insert([
    {
      id: id(1), owner_user_id: pessoa.helena, ordem: 1000, title: "Confirmação de consulta", shortcut: "confirma",
      body: "Oi, {{primeiro_nome}}! Passando para confirmar sua consulta de amanhã. Posso manter o horário?",
    },
    {
      id: id(3), owner_user_id: null, ordem: 3000, title: "Cartão da clínica", shortcut: "cartao",
      body: "Que bom ter você com a gente, {{primeiro_nome}}! Segue o cartão da Clínica Bem Viver.",
      midias: [{ storage_path: caminho(ARQUIVO_IMAGEM, 3), media_mime: "image/png", media_size_bytes: imagem.length }],
    },
    {
      id: id(4), owner_user_id: null, ordem: 4000, title: "Orientações da fisioterapia", shortcut: null, body: "",
      midias: [{ storage_path: caminho(ARQUIVO_AUDIO, 4), media_mime: "audio/wav", media_size_bytes: audio.length }],
    },
  ].map((t) => ({ midias: [], ...t, organization_id: org, created_by_user_id: t.owner_user_id ?? pessoa.helena }))), "respostas do módulo");
}
