/**
 * As áreas do CRM que um módulo CONECTADO pode ler ou alterar, e o vocabulário de permissão
 * que as nomeia (`area.<área>.<leitura|escrita>`).
 *
 * Este módulo só guarda o VOCABULÁRIO. O significado de cada permissão de área (o que o host
 * faz quando um módulo conectado a usa) é dono da F3 da spec 33, e NÃO está aqui: nesta fatia
 * nenhuma capacidade consome estas permissões, e a tela só as lista para quem vai aceitar o
 * módulo. Uma permissão de área declarada não concede leitura nem escrita por si só.
 *
 * Spec: docs/specs/33-spec-modulo-conectado.md (seção F1).
 */
import { ehPermissao, type ExtensionPermission } from "./capacidades";

export const EXTENSION_AREAS = [
  "contatos",
  "negocios",
  "conversas",
  "agenda",
  "funis",
  "agentes_ia",
  "catalogo",
  "configuracao",
  "analise",
] as const;
export type ExtensionArea = (typeof EXTENSION_AREAS)[number];

export type ModoDeArea = "leitura" | "escrita";

/**
 * Devolve a permissão de uma área e de um modo. O resultado é checado contra
 * `EXTENSION_PERMISSIONS`: uma área ou modo fora do vocabulário lança, em vez de devolver um
 * texto que a lista fechada do manifesto recusaria depois, longe da causa.
 */
export function permissaoDaArea(area: ExtensionArea, modo: ModoDeArea): ExtensionPermission {
  const permissao = `area.${area}.${modo}`;
  if (!ehPermissao(permissao)) {
    throw new Error(`permissao de area fora do vocabulario: ${permissao}`);
  }
  return permissao;
}

export function ehPermissaoDeArea(permissao: ExtensionPermission): boolean {
  return permissao.startsWith("area.");
}
