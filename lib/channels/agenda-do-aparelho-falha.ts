/**
 * POR QUE A LEITURA DA AGENDA DO APARELHO FALHOU — e de quem é a culpa (#4102).
 *
 * A agenda do celular é lida por `GET /api/contacts/all`, e o transporte
 * responde 400 quando o "store" da sessão está desligado — no NOWEB é o padrão:
 * a doc do WAHA diz, com todas as letras, que os endpoints de contatos "doesn't
 * work by default in NOWEB engine" sem `config.noweb.store.enabled`. No CRM esse
 * store é a opção **"Guardar o histórico anterior à vinculação"** da tela de
 * Conexões.
 *
 * Enquanto isso era só mais um `Error("waha_contacts_all_400")`, a rota
 * (`app/api/v1/contacts/import/agenda/route.ts`) tratava TODO erro da leitura
 * como "o WhatsApp não respondeu" — e quem tinha o número conectado lia que o
 * número não respondia, ficando travado até descobrir sozinho uma chave da
 * própria tela de conexões. O motivo tem de ser dito: um 400 pede LIGAR UMA
 * OPÇÃO, um timeout pede olhar a CONEXÃO, e um 5xx pede esperar.
 *
 * ─── Por que a classificação mora aqui, e não no adapter ────────────────────
 *
 * O adapter (`lib/channels/adapters/waha.ts`) é deliberadamente burro: cada
 * método delega ao `lib/waha/*` e não reimplementa regra. `lib/channels/` é a
 * fronteira que PODE nomear o transporte (é o que o lint de canal permite), e o
 * formato do erro dele (`waha_<operação>_<status>`, sem corpo — ver o cabeçalho
 * de `lib/waha/client.ts`) é o contrato que esta função lê. A rota, que não
 * pode nomear provider, consome só o vocabulário neutro daqui.
 *
 * ─── O que NÃO se faz com o corpo da resposta ───────────────────────────────
 *
 * O corpo do 400 não é lido: a doutrina do cliente é não deixar resposta de
 * terceiro atravessar (`lib/waha/client.ts` guarda só o status). A distinção é
 * por (endpoint, status) — 400 em `contacts/all` é o store desligado, ponto. Se
 * um dia o transporte separar os 400 por corpo, é aqui que a distinção entra.
 */

/** Em vocabulário de CANAL — nunca "waha_400". */
export type MotivoDaFalhaDaAgenda =
  /** O aparelho não entrega a agenda sem o store ligado. Ação: ligar a opção. */
  | "acervo_desligado"
  /** A sessão com o WhatsApp não vale mais (401/403). Ação: reconectar o número. */
  | "sessao_recusada"
  /** O servidor do canal falhou (5xx). Ação: esperar e tentar de novo. */
  | "servidor"
  /** O transporte não respondeu no teto, ou a rede caiu. Ação: conferir a conexão. */
  | "sem_resposta"
  /** O que não se encaixa acima — não invente causa. */
  | "indisponivel";

/**
 * A falha da leitura da agenda, já classificada, COM a causa técnica preservada.
 *
 * `causa` é a mensagem crua do transporte (`waha_contacts_all_400`,
 * `waha_timeout: …`): ela vai para o log e para o diagnóstico. A tela lê
 * `motivo` (pela resposta da rota), nunca `causa` — o status do provedor não é
 * informação de operador.
 */
export class FalhaDaAgendaDoAparelho extends Error {
  constructor(
    public readonly motivo: MotivoDaFalhaDaAgenda,
    public readonly causa: string,
  ) {
    super(causa);
    this.name = "FalhaDaAgendaDoAparelho";
  }
}

/**
 * O status HTTP embutido no erro do transporte (`waha_<operação>_<status>`).
 *
 * A operação pode ter MAIS DE UMA palavra — `waha_contacts_all_400` é o caso
 * desta issue —, daí `[a-z_]+` e não `[a-z]+`: com a classe curta o prefixo
 * "contacts_" era o único consumido, `all_400` sobrava e o 400 caía em
 * "indisponível". O adapter tem um leitor irmão (`statusHttpDoErroWaha`) para
 * os erros de sessão, onde a operação é uma palavra só.
 */
const STATUS_NO_ERRO = /^waha_(?:[a-z_]+_)?(\d{3})\b/;

/** Falhas de rede/relógio que não são HTTP nenhum. */
const SEM_RESPOSTA =
  /^(waha_timeout\b|fetch failed$)|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|aborted/i;

/**
 * Classifica o erro da leitura da agenda.
 *
 * Aceita o erro cru do transporte (é o que o serviço de sync repassa, sem
 * tocar) e a falha já classificada (devolvida como está, para o caminho não
 * perder o motivo se alguém classificar duas vezes).
 */
export function classificarFalhaDaAgenda(err: unknown): FalhaDaAgendaDoAparelho {
  if (err instanceof FalhaDaAgendaDoAparelho) return err;
  const causa = err instanceof Error ? err.message : String(err);

  // O relógio antes do status: `waha_timeout: …` não traz status nenhum, e um
  // corpo de erro que cite "400" não faz do timeout um 400.
  if (SEM_RESPOSTA.test(causa)) return new FalhaDaAgendaDoAparelho("sem_resposta", causa);

  const status = STATUS_NO_ERRO.exec(causa);
  if (status) {
    const codigo = Number(status[1]);
    // 400 em `contacts/all`: o store da sessão está desligado (doc do WAHA).
    // Nossos parâmetros são fixos (sessão, limit, offset, sortBy, sortOrder),
    // então um 400 aqui não é "pedido malformado" nosso.
    if (codigo === 400) return new FalhaDaAgendaDoAparelho("acervo_desligado", causa);
    if (codigo === 401 || codigo === 403)
      return new FalhaDaAgendaDoAparelho("sessao_recusada", causa);
    if (codigo >= 500) return new FalhaDaAgendaDoAparelho("servidor", causa);
  }
  return new FalhaDaAgendaDoAparelho("indisponivel", causa);
}
