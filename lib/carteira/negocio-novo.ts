/**
 * O NEGÓCIO NOVO NASCE COM O DONO DA CARTEIRA — o lado da ROTA (#2591, regra 4).
 *
 * ─── Por que isto é uma função de rota e não o gatilho ──────────────────────
 *
 * O gatilho `trg_crm_lead_nasce_na_carteira` (migration 0622) cobre todo
 * negócio que chega SEM dono — e é ele que entrega o dono nos cinco caminhos de
 * criação. Falta UM caso, que é o único em que o negócio chega COM dono: no
 * modo "Só os seus" (`visibility_mode = 'own'`), a rota preenche
 * `owner_user_id = quem criou` (padrão do #2547) ANTES do insert, e aí o
 * gatilho vê dono e não mexe em nada — o negócio nasceria com o Atendente que
 * riscou o cliente da carteira do colega.
 *
 * A issue decide o desfecho: "com carteira de outro vendedor, o negócio segue
 * para o dono da carteira, e no 'Só os seus' a criação é recusada com o motivo".
 * Recusar é mais honesto que redirecionar em silêncio: quem criou fica sabendo
 * que o cliente é de outro vendedor, e o 403 explicado já é o molde do #2556.
 *
 * ─── As quatro respostas, que são a mesa inteira ────────────────────────────
 *
 * - fora do modo `own` → não recusa (o gatilho entrega o dono, ou o negócio já
 *   veio com o dono que quem criou escolheu);
 * - sem carteira (ou dono que não conta: `viewer`, revogado, de outra org) →
 *   nada muda: é o padrão do #2547, o que o Atendente cria é dele;
 * - cliente da PRÓPRIA carteira → ele cria normalmente;
 * - cliente de OUTRA carteira → recusa com motivo.
 */
export interface PedidoDeNegocioNovo {
  /** `visibility_mode` da organização, lido no cookie — nunca do corpo. */
  modo: string | null | undefined;
  /** Quem está criando (o `authUser.id` da rota). */
  criadorId: string;
  /** `contacts.carteira_user_id`, e SÓ quando o vínculo ainda conta (`carteiraDoContato`). */
  donoDaCarteira: string | null;
}

export function recusaNegocioNaCarteiraDeOutro(entrada: PedidoDeNegocioNovo): boolean {
  if (entrada.modo !== "own") return false;
  if (!entrada.donoDaCarteira) return false;
  return entrada.donoDaCarteira !== entrada.criadorId;
}

/** O motivo, na forma que a rota traduz antes de devolver o 403. */
export const MOTIVO_DA_RECUSA = "Este cliente pertence à carteira de outro vendedor. O negócio novo nasce com o dono da carteira.";
