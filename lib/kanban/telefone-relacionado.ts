import { canonicalPhoneBR, normalizePhoneBR } from "@/lib/channels/phone-variants";

/** O mínimo que a decisão precisa saber de um contato já conhecido. */
export type ContatoConhecido = {
  id: string;
  phone_number?: string | null;
};

/** O mínimo que a decisão precisa saber de quem já está ligado ao negócio. */
export type PessoaLigada = {
  contact_id: string;
};

/**
 * O que fazer com o número que o usuário digitou no "+ telefone" da ficha.
 *
 * Existe separada do componente para poder ser testada sem montar tela: a
 * regra é só comparação de telefone, e é onde os erros caros moram — número
 * em formato diferente do gravado (a mesma pessoa virando dois contatos) e
 * número já ligado ao negócio (ligação duplicada).
 */
export type DecisaoDoTelefone =
  | { tipo: "invalido" }
  | { tipo: "ja_relacionado"; contactId: string }
  | { tipo: "ligar_existente"; contactId: string }
  | { tipo: "criar_e_ligar"; canonico: string };

export function decidirTelefone(
  numero: string,
  pessoas: PessoaLigada[],
  contatos: ContatoConhecido[],
): DecisaoDoTelefone {
  const canonico = normalizePhoneBR(numero);
  if (!canonico) return { tipo: "invalido" };

  const existente = contatos.find(
    (c) => Boolean(c.phone_number) && canonicalPhoneBR(c.phone_number as string) === canonico,
  );
  if (!existente) return { tipo: "criar_e_ligar", canonico };

  const jaLigado = pessoas.some((p) => p.contact_id === existente.id);
  return jaLigado
    ? { tipo: "ja_relacionado", contactId: existente.id }
    : { tipo: "ligar_existente", contactId: existente.id };
}
