/**
 * A COR DE CADA PARTICIPANTE NUM GRUPO (kvgroup) — como no WhatsApp do
 * celular: cada pessoa ganha uma cor, e toda mensagem dela (nome e balão) sai
 * nessa cor, para distinguir de relance quem falou.
 *
 * A cor sai de um hash da IDENTIDADE da pessoa (`lid`, senão telefone, senão
 * nome), não da ordem em que ela aparece: a mesma pessoa tem a mesma cor em
 * todo o fio, depois de recarregar e em outro computador. Duas pessoas podem
 * cair na mesma cor (o WhatsApp também deixa); a paleta tem 12 tons para isso
 * ser raro num grupo comum.
 */
import type { RemetenteDeGrupo } from "@/lib/messaging/remetente-de-grupo";

/** Tons vivos, legíveis sobre o fundo escuro; no claro o texto é escurecido no CSS. */
export const PALETA_DE_PARTICIPANTES = [
  "#e542a3",
  "#1f7aec",
  "#02a698",
  "#fc6d26",
  "#a259ff",
  "#35cd96",
  "#f05454",
  "#00b2d6",
  "#c4a000",
  "#7c8cf8",
  "#ff8fab",
  "#8bc34a",
] as const;

/** FNV-1a de 32 bits: estável, sem dependência, bem espalhado para chaves curtas. */
function hash(texto: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A chave de identidade do participante, ou `null` quando não há nenhuma. */
export function chaveDoParticipante(r: Pick<RemetenteDeGrupo, "lid" | "phone" | "name">): string | null {
  return r.lid ?? r.phone ?? r.name ?? null;
}

/** A cor do participante; `null` quando não dá para saber quem é. */
export function corDoParticipante(
  r: Pick<RemetenteDeGrupo, "lid" | "phone" | "name">,
): (typeof PALETA_DE_PARTICIPANTES)[number] | null {
  const chave = chaveDoParticipante(r);
  if (!chave) return null;
  return PALETA_DE_PARTICIPANTES[hash(chave) % PALETA_DE_PARTICIPANTES.length]!;
}
