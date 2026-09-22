/**
 * Farejador de imagem — o tipo sai dos BYTES, não do header.
 *
 * O `allowed_mime_types` do bucket e o `accept` do input comparam o que QUEM
 * SOBE declara. Quem decide de verdade é esta função, usada pelas rotas de
 * upload (comprovante de entrega, fotos do produto). Um lugar só: dois
 * farejadores divergem no primeiro formato novo.
 */
export type TipoDeImagem = "jpg" | "png" | "webp";

export function detectarTipoImagem(bytes: Uint8Array): TipoDeImagem | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  )
    return "png";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  )
    return "webp";
  return null;
}

export function mimeDaImagem(tipo: TipoDeImagem): string {
  return tipo === "jpg" ? "image/jpeg" : tipo === "png" ? "image/png" : "image/webp";
}
