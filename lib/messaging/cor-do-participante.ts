/**
 * A COR DE CADA PARTICIPANTE NUM GRUPO — como no WhatsApp do celular: cada
 * pessoa ganha uma cor, e o NOME dela sai nessa cor, para distinguir de
 * relance quem falou. O balão não muda.
 *
 * A cor sai de um hash da IDENTIDADE da pessoa (`lid`, senão telefone, senão
 * nome), não da ordem em que ela aparece: a mesma pessoa tem a mesma cor em
 * todo o fio, depois de recarregar e em outro computador. Duas pessoas podem
 * cair na mesma cor (o WhatsApp também deixa); a paleta tem 12 tons para isso
 * ser raro num grupo comum.
 *
 * Cada tom tem uma variante por tema: o nome tem ~11px, então precisa de
 * contraste de TEXTO (≥ 4,5:1, WCAG 1.4.3) contra o fundo do balão recebido
 * (`--color-surface-elevated`) no claro e no escuro. Um tom só não chega lá
 * nos dois — medido em `cor-do-participante.test.ts`, que lê o fundo do
 * `app/globals.css`.
 */
import type { RemetenteDeGrupo } from "@/lib/messaging/remetente-de-grupo";

export const PALETA_DE_PARTICIPANTES = [
  { claro: "#c8218a", escuro: "#f24fae" },
  { claro: "#036adb", escuro: "#398eff" },
  { claro: "#067a70", escuro: "#02a698" },
  { claro: "#bc4801", escuro: "#fc6d26" },
  { claro: "#8f42e8", escuro: "#aa70fe" },
  { claro: "#077d58", escuro: "#35cd96" },
  { claro: "#cc3037", escuro: "#f55958" },
  { claro: "#017892", escuro: "#00b2d6" },
  { claro: "#846b04", escuro: "#c4a000" },
  { claro: "#5864cc", escuro: "#7c8cf8" },
  { claro: "#b24a68", escuro: "#ff8fab" },
  { claro: "#4d7903", escuro: "#8bc34a" },
] as const;

export type CorDoParticipante = (typeof PALETA_DE_PARTICIPANTES)[number];

/** FNV-1a de 32 bits: estável, sem dependência, bem espalhado para chaves curtas. */
function hash(texto: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A cor do participante; `null` quando não dá para saber quem é. */
export function corDoParticipante(r: Pick<RemetenteDeGrupo, "lid" | "phone" | "name">): CorDoParticipante | null {
  const chave = r.lid ?? r.phone ?? r.name;
  if (!chave) return null;
  return PALETA_DE_PARTICIPANTES[hash(chave) % PALETA_DE_PARTICIPANTES.length] ?? null;
}
