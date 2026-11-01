/**
 * Normalização de CNPJ (14 posições, dígito ou letra) e nome (casefold + espaços).
 * Não toca em organizations.cnpj — empresas clientes vivem em `companies`.
 */
import { isValidCnpj } from "@/lib/cobranca/documento";

/** A máscara do CNPJ: ponto, barra, hífen e espaço. Só a FORMA sai daqui. */
const MASCARA = /[.\-/\s]/g;
/** 12 posições (dígito ou letra) + 2 dígitos verificadores. */
const POSICOES = 14;
/** Já em MAIÚSCULA e sem máscara: é a forma que a coluna guarda. */
const FORMA_NORMALIZADA = /^[0-9A-Z]{14}$/;

/**
 * A recusa do cadastro, da edição, da consulta e da importação. Uma constante
 * porque a mesma frase vale nas quatro portas: "inválido" sem dizer o que
 * conferir não ajuda quem digitou o documento errado, e quatro textos escritos
 * à mão divergem no primeiro ajuste.
 */
export const MENSAGEM_DE_CNPJ_INVALIDO =
  "CNPJ inválido: confira as 12 posições (dígitos ou letras) e os 2 dígitos verificadores.";

/**
 * Devolve as 14 posições do CNPJ em MAIÚSCULA e sem máscara, ou `null` quando
 * formato/DV são inválidos.
 *
 * Aceita os DOIS formatos que a Receita emite: o numérico (`11.222.333/0001-81`)
 * e o ALFANUMÉRICO (`12.ABC.345/01DE-35`, o exemplo da Nota Técnica — 12
 * posições de dígito ou letra e 2 dígitos verificadores). A letra entra em
 * MAIÚSCULA porque é a forma canônica: `a` e `A` valem o MESMO código no mod-11,
 * e guardar as duas formas deixaria o mesmo documento com dois
 * `normalized_cnpj` — o índice único por organização
 * (`companies_org_normalized_cnpj_uidx`) deixaria de segurar a duplicata.
 *
 * O TAMANHO não basta: `11.222.333/0001-00` tem 14 dígitos e não é CNPJ válido.
 * Antes desta régua a empresa entrava com o número errado, e o erro só aparecia
 * depois, ao tentar enriquecer o cadastro. O checksum confere o dígito; ele não
 * comprova existência nem situação cadastral na Receita.
 *
 * Quem confere o dígito é `isValidCnpj`, a MESMA função que a cobrança usa no
 * documento do pagador (mod-11 da Receita). Uma implementação só: duas réguas
 * divergiriam no dia em que uma aprendesse um caso novo — foi exatamente o que
 * aconteceu até a #3495, com a cobrança já lendo o alfanumérico e o cadastro
 * ainda recusando.
 *
 * Só a MÁSCARA é descartada. Texto em volta do número (`CNPJ: 11.222...`) não é
 * máscara: reprova em vez de virar número por acidente, que é como um campo
 * escrito à mão entrava como se fosse documento.
 */
export function normalizeCnpj(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const cnpj = String(raw).replace(MASCARA, "").toUpperCase();
  if (cnpj.length !== POSICOES) return null;
  // `isValidCnpj` já recusa a sequência trivial (000... / 111...), o DV errado
  // e a letra onde o par de verificadores tem de ser numérico.
  return isValidCnpj(cnpj) ? cnpj : null;
}

/** A máscara visual (`12.ABC.345/01DE-35`); devolve o valor recebido se não for CNPJ. */
export function formatCnpj(normalized: string): string {
  const cnpj = normalized.replace(MASCARA, "").toUpperCase();
  if (!FORMA_NORMALIZADA.test(cnpj)) return normalized;
  return `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-${cnpj.slice(12)}`;
}

export function normalizePersonName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const collapsed = raw
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return collapsed.length > 0 ? collapsed : null;
}
