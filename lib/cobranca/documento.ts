/**
 * O CPF/CNPJ de quem paga (spec da cobrança do revendedor §6.2, §7b). O Asaas
 * exige o documento para emitir Pix e boleto; ele vai DIRETO ao provedor e
 * nunca é gravado (§2.3, LGPD). Puro, sem servidor: a tela confere enquanto a
 * pessoa digita, a rota do checkout confere de novo antes de tocar o provedor,
 * e o adaptador confere como cinto. Aceita máscara (só a forma muda) e o CNPJ
 * alfanumérico da Receita Federal: 12 posições de dígito ou letra maiúscula e
 * 2 dígitos verificadores.
 */
import type { ProvedorDeCobranca } from "@/lib/cobranca/vocabulario";
import { isValidCpf } from "@/lib/legal/perfil-do-pais";

const PESOS_DO_CNPJ = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const SEPARADORES = /[.\-/\s]/g;

/** Mod-11 da Receita; cada posição vale o código do caractere − 48 (dígito = ele mesmo, A = 17). */
function digitoDoCnpj(base: string): number {
  const pesos = PESOS_DO_CNPJ.slice(PESOS_DO_CNPJ.length - base.length);
  const soma = [...base].reduce((total, c, i) => total + (c.charCodeAt(0) - 48) * (pesos[i] ?? 0), 0);
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

export function isValidCnpj(bruto: string): boolean {
  const s = bruto.replace(SEPARADORES, "").toUpperCase();
  if (!/^[0-9A-Z]{12}\d{2}$/.test(s) || /^(\d)\1{13}$/.test(s)) return false;
  return digitoDoCnpj(s.slice(0, 12)) === Number(s[12]) && digitoDoCnpj(s.slice(0, 13)) === Number(s[13]);
}

/** Só os caracteres do documento (CPF 11 dígitos; CNPJ 14), ou `null` se o dígito verificador não bate. */
export function documentoDoPagador(bruto: string): string | null {
  const s = bruto.replace(SEPARADORES, "").toUpperCase();
  if (/^\d{11}$/.test(s)) return isValidCpf(s) ? s : null;
  return isValidCnpj(s) ? s : null;
}

/** Pedir o documento só quando o checkout vai CRIAR o cliente no Asaas: quem já é cliente lá (reassinar) não digita de novo. */
export function exigeDocumento(provedor: ProvedorDeCobranca | null, clienteJaExiste: boolean): boolean {
  return provedor === "asaas" && !clienteJaExiste;
}

/** O CNPJ do cadastro da empresa vira sugestão só se o dígito confere; senão a pessoa digita. */
export function sugestaoDoCadastro(cnpj: string | null): string | null {
  return cnpj === null ? null : documentoDoPagador(cnpj);
}
