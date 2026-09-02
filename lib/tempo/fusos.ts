/**
 * Os fusos horários que a tela oferece — e a checagem de que o fuso EXISTE.
 *
 * ─── O defeito, medido ─────────────────────────────────────────────────────
 *
 * O campo do fuso da janela de envio era texto livre, validado só por
 * `z.string().min(1).max(64)`. Qualquer coisa passava. E o motor usa
 * `Intl.DateTimeFormat({ timeZone })`, que LANÇA `RangeError` num fuso que não
 * existe:
 *
 *   America/Asuncion   → 23h        ✓
 *   America/Asunción   → RangeError  ← o acento que um hispanofalante escreve
 *   Asuncion           → RangeError
 *
 * Ou seja: um acento no campo salvava sem reclamar e derrubava a avaliação da
 * janela em TODO envio daquele canal. O defeito não aparece na tela que o
 * causou — aparece no worker, horas depois, como envio que não sai.
 *
 * ─── Duas defesas, e as duas fazem falta ───────────────────────────────────
 *
 * A LISTA impede o erro de digitação, que é a origem real. A CHECAGEM defende a
 * API, que aceita qualquer cliente e não passa pela tela — e defende a lista de
 * si mesma, se alguém acrescentar um código errado aqui.
 */

/**
 * Fusos oferecidos, agrupados pelo que este público usa.
 *
 * Não é a lista IANA inteira (são centenas). Faltar um é um pedido de uma
 * linha; oferecer trezentos faz o operador procurar o dele numa lista que não
 * termina — e a busca é justamente onde ele digita errado.
 */
export const FUSOS_OFERECIDOS: { codigo: string; rotulo: string }[] = [
  { codigo: "Africa/Maputo", rotulo: "Maputo (Moçambique)" },
  { codigo: "America/Asuncion", rotulo: "Assunção (Paraguai)" },
  { codigo: "America/Argentina/Buenos_Aires", rotulo: "Buenos Aires (Argentina)" },
  { codigo: "America/Montevideo", rotulo: "Montevidéu (Uruguai)" },
  { codigo: "America/Santiago", rotulo: "Santiago (Chile)" },
  { codigo: "America/La_Paz", rotulo: "La Paz (Bolívia)" },
  { codigo: "America/Lima", rotulo: "Lima (Peru)" },
  { codigo: "America/Bogota", rotulo: "Bogotá (Colômbia)" },
  { codigo: "America/Mexico_City", rotulo: "Cidade do México (México)" },
  { codigo: "America/Sao_Paulo", rotulo: "São Paulo (Brasil)" },
  { codigo: "America/Manaus", rotulo: "Manaus (Brasil)" },
  { codigo: "America/Belem", rotulo: "Belém (Brasil)" },
  { codigo: "America/Recife", rotulo: "Recife (Brasil)" },
  { codigo: "America/Fortaleza", rotulo: "Fortaleza (Brasil)" },
  { codigo: "UTC", rotulo: "UTC" },
];

/**
 * O runtime consegue usar este fuso?
 *
 * Pergunta ao `Intl`, e não a uma lista: é o `Intl` que o motor da janela usa, e
 * uma lista nossa responderia "sim" para um código que ele recusa. A base de
 * fusos muda (países criam e apagam zonas), e quem sabe qual versão está
 * instalada é o próprio runtime.
 */
export function fusoValido(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}
