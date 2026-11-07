"use client";

import { useWatch, type Control, type FieldValues, type Path } from "react-hook-form";

import { formatValorDoNegocio, parseReaisToCents } from "@/lib/money";

/**
 * Mostra, embaixo do campo, como o valor digitado foi entendido.
 *
 * Dinheiro nunca deve ser interpretado em silêncio: era assim que "249.90"
 * virava R$ 24.990,00 e só aparecia no relatório, dias depois. Com o eco, quem
 * digita vê o número que vai ser gravado antes de salvar.
 *
 * Usa `useWatch` (e não `form.watch()` dentro do render) porque o segundo
 * devolve uma função que o React Compiler não consegue memoizar, e ele então
 * desiste de otimizar o formulário inteiro.
 */
export function EcoDoValor<T extends FieldValues>({
  control,
  moeda,
  campo = "valueReais" as Path<T>,
}: {
  control: Control<T>;
  /** A moeda do NEGÓCIO; o eco em real embaixo de um campo em euro era o defeito. */
  moeda: string;
  /**
   * Qual campo monetário ecoar. O valor único continua sendo o padrão (nenhum
   * chamador atual muda); o campo de VALOR RECORRENTE (fatia 1 da #3602) passa
   * o seu nome, porque dinheiro digitado em silêncio é o defeito que este
   * componente existe para impedir — e mensalidade é dinheiro.
   */
  campo?: Path<T>;
}) {
  const digitado = useWatch({ control, name: campo }) as unknown as string | undefined;
  // A MESMA moeda do rótulo e do valor gravado: o eco é o que a pessoa vê
  // antes de salvar, então ele não pode ler o número por outra régua (#3331).
  const centavos = parseReaisToCents(digitado ?? "", moeda);
  if (centavos === null) return null;
  // `formatValorDoNegocio`, e NÃO `formatCents`: o negócio guarda o valor ×100
  // em qualquer moeda (é o que `parseReaisToCents` acabou de fazer logo acima),
  // enquanto `formatCents` lê unidades menores. Em moeda sem centavos as duas
  // réguas divergem por cem — o eco mostraria `Gs. 12.500.000` onde o card
  // mostra `Gs. 125.000`.
  return <p className="text-xs text-muted-foreground">= {formatValorDoNegocio(centavos, moeda)}</p>;
}
