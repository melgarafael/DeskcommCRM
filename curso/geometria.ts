/** Recorta o alvo à foto; sem interseção, falha em vez de gravar altura negativa. */
export function caixaNaFoto(
  b: { x: number; y: number; width: number; height: number },
  largura: number,
  altura: number,
) {
  const x = Math.max(0, b.x), y = Math.max(0, b.y);
  const direita = Math.min(largura, b.x + b.width), baixo = Math.min(altura, b.y + b.height);
  if (![x, y, direita, baixo].every(Number.isFinite) || direita <= x || baixo <= y) {
    throw new Error("alvo fora da foto — ajuste a rolagem ou os destaques do passo");
  }
  return { x, y, w: direita - x, h: baixo - y };
}
