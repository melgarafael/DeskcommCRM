/**
 * A LISTA DE PESSOAS DA AGENDA — issue 896, item 1.
 *
 * A Agenda precisa de uma coisa só da equipe: QUEM tem agenda para mostrar, com
 * o nome que aparece na barra de pessoas. Ela pedia isso em `/api/v1/team`, que
 * é manager+ (spec 13 §4) e devolve e-mail e último acesso — então o Atendente
 * recebia 403, a lista voltava vazia e a tela ainda dizia "Você" no lugar do
 * nome de quem publicou os horários.
 *
 * Duas saídas ruins e uma boa: baixar o papel de `/api/v1/team` entrega e-mail e
 * último acesso a quem só precisa de nomes (é a exceção que a própria
 * `/api/v1/team/assignable` documenta como "mínima"), e a Agenda desistir de
 * listar deixa o Atendente sem ver com quem é o compromisso. A boa é a lista
 * MÍNIMA, com o menor papel que resolve: quem lê a agenda de outra pessoa é
 * `agent`, e o que sai daqui é id, papel, nome e rótulo de apresentação.
 * O fallback explícito por e-mail é restrito à agenda, sem reduzir o papel da rota da equipe.
 */
export const ROTA_DA_LISTA_DE_PESSOAS = "/api/v1/agenda/pessoas";

/**
 * O menor papel que lê a lista. `agent` (Atendente) e não `manager`: marcar na
 * agenda de outra pessoa é o trabalho do atendente, e sem a lista ele não
 * escolhe a pessoa nem vê de quem é o horário. Subir este papel devolve o 403
 * que a issue descreve.
 */
export const PAPEL_MINIMO_DA_LISTA = "agent";

/**
 * As colunas expostas. `email` e `last_sign_in_at` NÃO entram: a barra de
 * pessoas usa display_label: nome válido, ou e-mail quando falta nome.
 * Não expõe e-mail separadamente quando já existe nome; full_name conserva seu contrato.
 */
export const CAMPOS_DA_LISTA = ["user_id", "role", "full_name", "display_label"] as const;

/**
 * POR QUE a lista não veio — o que a tela precisa dizer.
 *
 * O aviso genérico ("Você não tem permissão para esta ação") não diz o que
 * fazer e, na agenda, chegava sem nenhuma pista de que a lista de pessoas era
 * o que faltava: a grade continuava ali, só sem os nomes. A frase diz de que
 * permissão se trata e o que resta funcionando.
 */
export function motivoDaFalhaNaLista(status?: number): string {
  if (status === 401) {
    return "Sua sessão expirou: entre de novo para ver a agenda da equipe.";
  }
  if (status === 403) {
    return "Ver a agenda de outra pessoa exige ler a lista da equipe (papel de atendente ou acima), e o seu papel não permite. A sua própria agenda continua funcionando.";
  }
  return "Não foi possível carregar a lista de pessoas da equipe. A sua própria agenda continua funcionando.";
}
