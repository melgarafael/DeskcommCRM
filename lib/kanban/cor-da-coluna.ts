import type { CSSProperties } from "react";

/**
 * A cor da etapa na COLUNA do quadro (#4802, item 2, continuação do #4846).
 *
 * O #4846 deixou escolher a cor pela tela, e o quadro a mostrava só numa
 * bolinha de 8 px ao lado do nome. Aqui a mesma cor pinta a coluna inteira em
 * tom pastel: a cor da etapa misturada com o fundo do quadro, e não a cor
 * chapada — o card (branco) continua legível, e o tom segue o tema claro e o
 * escuro porque a mistura usa as variáveis do tema.
 *
 * O valor vem do banco com o CHECK `crm_stages_color_format`
 * (`^#[0-9a-fA-F]{6}$`), mas o quadro também recebe etapa de importação e de
 * fixture; por isso a função só aceita hex de seis dígitos e devolve `undefined`
 * para qualquer outra coisa. Um texto vindo de fora nunca entra no `style`.
 */
const HEX_DE_SEIS = /^#[0-9a-fA-F]{6}$/;

/**
 * Quanto da cor da etapa entra no fundo da coluna e na borda dela. Tom leve de
 * propósito (doc 382 do mantenedor, B): o guia visual pede acento discreto em área
 * grande, e a borda continua o dobro do fundo para a fase ser reconhecível.
 */
export const PORCENTAGEM_DO_FUNDO = 18;
export const PORCENTAGEM_DA_BORDA = 36;

export function corDaEtapaValida(cor: string | null | undefined): cor is string {
  return typeof cor === "string" && HEX_DE_SEIS.test(cor);
}

/** O fundo pastel da coluna e do cabeçalho dela; `undefined` quando a etapa não tem cor. */
export function fundoDaColuna(cor: string | null | undefined): CSSProperties | undefined {
  if (!corDaEtapaValida(cor)) return undefined;
  return {
    backgroundColor: `color-mix(in srgb, ${cor} ${PORCENTAGEM_DO_FUNDO}%, var(--color-surface-elevated))`,
  };
}

/** A borda da coluna, no mesmo tom (mais forte que o fundo). */
export function bordaDaColuna(cor: string | null | undefined): CSSProperties | undefined {
  if (!corDaEtapaValida(cor)) return undefined;
  return {
    borderColor: `color-mix(in srgb, ${cor} ${PORCENTAGEM_DA_BORDA}%, var(--color-border))`,
  };
}
