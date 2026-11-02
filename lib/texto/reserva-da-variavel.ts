/**
 * O texto de reserva de uma variável: `{{primeiro_nome|"aluno"}}`.
 *
 * Se a variável não tiver valor, sai o texto entre aspas; se tiver, a reserva
 * é ignorada. Este arquivo só guarda a SINTAXE, para que todo renderizador de
 * `{{...}}` (automação, follow-up, Inbox, campanha) leia a mesma forma.
 *
 * Aspas retas ou tipográficas (quem cola de um editor traz “assim”). A reserva
 * tem 1 a 100 caracteres depois de aparada e não aceita `{`, `}` nem aspas:
 * é texto, nunca variável, e não reabre expressão. Fora disso o token não casa
 * e segue como texto solto, o destino de tudo que o renderizador não conhece.
 *
 * Sem grupo de captura de nome: o fragmento tem UM grupo, o da reserva, e vai
 * logo antes do `}}` de cada regex.
 */
export const RESERVA_DA_VARIAVEL =
  String.raw`(?:\|\s*["“]\s*([^"“”{}\s](?:[^"“”{}]{0,98}[^"“”{}\s])?)\s*["”]\s*)?`;
