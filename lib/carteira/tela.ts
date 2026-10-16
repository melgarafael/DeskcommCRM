/**
 * A TELA DA CARTEIRA — o motor (#2667) virado em estado de interface (#2591).
 *
 * O motor já responde "quem é o dono" (`lib/carteira/dono.ts`). O que faltava era
 * a TELA dizer isso para quem atende, e as duas decisões de tela são regra, não
 * JSX: elas moram aqui para poderem ser medidas sem DOM, e para a faixa do chat
 * e o cartão da ficha NÃO divergirem sobre o mesmo contato — divergir aqui é o
 * defeito invisível que a issue existe para consertar (o cliente de A atendido
 * por B sem ninguém avisar).
 *
 * ─── Os quatro estados, e por que são quatro ───────────────────────────────
 *
 *   sem_carteira   não há dono gravado: nada muda em relação a hoje (regra 1).
 *   dono_inativo   há dono gravado, mas o VÍNCULO não conta — quem saiu da
 *                  equipe ou quem só lê (`viewer`) não é dono (regra 5). O
 *                  cartão avisa; a faixa do chat NÃO avisa, porque não há a
 *                  quem prometer nada.
 *   mesmo_dono     o dono é quem atende: ele enxerga que o cliente é dele.
 *   outro_dono     o dono é OUTRA pessoa: é o único estado que vira faixa em
 *                  cima do chat (regra 2 — "o atendente precisa saber antes de
 *                  prometer algo").
 *
 * A régua de quem CONTA (papel que conta, membro aceito, não revogado) NÃO é
 * reescrita aqui: ela já existe em `lib/carteira/dono.ts` e o servidor a aplica
 * no banco. Aqui só se lê o resultado dela (`qualificado`).
 */

/** O que o servidor devolve para a tela da carteira de um contato. */
export interface CarteiraDaTela {
  /** O id gravado em `contacts.carteira_user_id`, qualificado ou não. */
  dono_user_id: string | null;
  /** O vínculo de hoje conta? (membro ativo da org, papel `agent`/`manager`/`admin`.) */
  qualificado: boolean;
}

/** Os quatro estados da tela — o resto da UI decide o texto a partir deles. */
export type EstadoDaCarteira = "sem_carteira" | "dono_inativo" | "mesmo_dono" | "outro_dono";

/**
 * O estado da tela da carteira para um contato, dado quem atende.
 *
 * `quemAtendeId` é o responsável pela conversa (`conversations.assigned_to_user_id`)
 * ou `null` quando ninguém assumiu. Sem responsável, o dono é sempre "outro":
 * não se sabe quem vai responder, e omitir o aviso só porque a conversa está
 * na fila é exatamente o caso em que o negócio nasce no nome errado.
 */
export function estadoDaCarteira(
  carteira: CarteiraDaTela,
  quemAtendeId: string | null | undefined,
): EstadoDaCarteira {
  if (!carteira.dono_user_id) return "sem_carteira";
  if (!carteira.qualificado) return "dono_inativo";
  if (quemAtendeId && carteira.dono_user_id === quemAtendeId) return "mesmo_dono";
  return "outro_dono";
}

/**
 * A faixa em cima do chat aparece SÓ quando o dono é outra pessoa (regra 2).
 *
 * O estado `dono_inativo` fica de fora de propósito: um dono que saiu da equipe
 * ou que só lê não conta (regra 5), então não há "carteira de alguém" para
 * prometer — avisar ali seria criar a tarefa que o motor já decidiu não criar.
 * O cartão da ficha continua mostrando, porque ali a informação serve a quem vai
 * CONSERTAR a carteira.
 */
export function faixaDaCarteiraAparece(estado: EstadoDaCarteira): boolean {
  return estado === "outro_dono";
}
