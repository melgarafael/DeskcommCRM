/**
 * PII masking helpers for LGPD preview endpoints.
 *
 * NEVER expose the RAW CPF — nos endpoints de preview ele é omitido por
 * inteiro, e o bruto só vive no `data.json` e na coluna cifrada.
 * Email: a***@dominio.com
 * Phone: (**) ****-${last4}
 *
 * A única exceção é `mascaraCpf`, que imprime o CPF do titular (mascarado)
 * no PRÓPRIO relatório de acesso — ver o cabeçalho da função, issue #2341.
 */

export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const atIdx = email.indexOf("@");
  if (atIdx <= 0) return "***";
  const local = email.slice(0, atIdx);
  const domain = email.slice(atIdx); // includes @
  const prefix = local[0] ?? "*";
  return `${prefix}***${domain}`;
}

export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  // Strip non-digits to extract last 4
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "(**) ****-****";
  const last4 = digits.slice(-4);
  return `(**) ****-${last4}`;
}

/**
 * O CPF do titular, mascarado, para o PDF de acesso (issue #2341).
 *
 * O relatório dizia "Informado na conversa (valor no arquivo de dados)", mas o
 * `data.json` ficava no Storage sem link no e-mail: o documento apontava
 * para um arquivo que quem o lê não tem. A saída escolhida foi imprimir o
 * valor AQUI, mascarado — o ponteiro para o arquivo sumiu.
 *
 * A régua é a mesma de `mascara()` (`lib/escalacao/aviso-ao-suporte.ts`): os
 * QUATRO ÚLTIMOS dígitos, e só. Para um CPF de 11 dígitos a saída mantém a
 * pontuação (***.***.*47-25), e o valor BRUTO continua só no `data.json`.
 *
 * Devolve `null` quando não há o que mostrar com segurança — quem chama cai
 * numa frase sem ponteiro, nunca no texto antigo.
 */
export function mascaraCpf(cpf: string | null | undefined): string | null {
  const digitos = (cpf ?? "").replace(/\D/g, "");
  if (digitos.length < 5) return null;
  const vistos = digitos.slice(-4);
  if (digitos.length !== 11) return `${"*".repeat(digitos.length - 4)}${vistos}`;
  const dig = (i: number) => (i >= digitos.length - 4 ? digitos[i]! : "*");
  const bloco = (de: number, ate: number) =>
    Array.from({ length: ate - de }, (_, k) => dig(de + k)).join("");
  return `${bloco(0, 3)}.${bloco(3, 6)}.${bloco(6, 9)}-${bloco(9, 11)}`;
}
