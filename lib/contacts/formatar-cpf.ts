/**
 * O CPF como se lê na tela: `000.000.000-00`.
 *
 * Mora fora de `lib/contacts/cpf.ts` de propósito: aquele módulo importa
 * `node:crypto` (o hash) e não pode entrar no bundle do navegador; este é puro
 * e serve à ficha do contato.
 *
 * Aceita o valor com ou sem máscara — as fichas gravadas antes de a cifra
 * guardar só os dígitos têm o texto como foi digitado. O que não tem 11 dígitos
 * volta como veio, sem inventar máscara: um documento de outro formato não vira
 * um CPF falso.
 */
export function formatarCpf(raw: string): string {
  const digitos = raw.replace(/\D/g, "");
  if (digitos.length !== 11) return raw.trim();
  return `${digitos.slice(0, 3)}.${digitos.slice(3, 6)}.${digitos.slice(6, 9)}-${digitos.slice(9)}`;
}
