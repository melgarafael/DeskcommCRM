import type { InfiniteData } from "@tanstack/react-query";

/**
 * A MENSAGEM QUE CHEGA PELO REALTIME ENTRA NO FIO SEM REDE (#4325 item 5).
 *
 * ─── O que este arquivo substitui ───────────────────────────────────────────
 * `useMessagesRealtime` invalidava `["messages", conversaId]` a cada evento do
 * canal. Numa `useInfiniteQuery` isso refaz TODAS as páginas do histórico: quem
 * rolou três páginas para trás pagava três GET por mensagem — e o canal também
 * entrega os `UPDATE` de confirmação (enviada, entregue, lida), que chegam
 * vários por mensagem enviada. Na prática, a conversa aberta era a tela mais
 * caríssima do inbox, e por um evento que já traz a linha inteira.
 *
 * ─── Por que mesclar é seguro aqui, e não no caso das conversas ─────────────
 * A lista de conversas é ordenada NO SERVIDOR e cada linha carrega joins que o
 * evento não tem (`contacts`, `channel_sessions`) — por isso lá a mescla é
 * cercada por `atualizacao-da-lista.ts` e desiste em vários casos.
 *
 * O fio da conversa é o oposto: as páginas são buscadas de trás para a frente
 * (o cursor da rota é o mais ANTIGO da página), então `pages[0]` é o pedaço
 * MAIS NOVO — e DENTRO dele a ordem é CRESCENTE, a mesma em que o consumidor
 * desenha de cima para baixo (`app/api/v1/messages/_handler.ts`, o `.reverse()`
 * do fim da leitura) e a mesma em que o `useSendMessage` acrescenta o otimista.
 * Então:
 *
 *  - `INSERT` entra no FIM de `pages[0]` — mensagem nova é a mais recente, e o
 *    fio continua cronológico;
 *  - o balão otimista (`temp-…`) do PRÓPRIO envio sai quando a linha real
 *    entra, senão a mesma mensagem aparece duas vezes até o POST responder;
 *  - `UPDATE` de confirmação é mesclado PELO `id`, na página onde a mensagem
 *    estiver (o status é a única coisa que muda, e ela aparece no balão);
 *  - `DELETE` sai de onde estiver.
 *
 * ─── O autor ────────────────────────────────────────────────────────────────
 * `sent_by_user_name` é campo DERIVADO: quem o preenche é a rota, com uma
 * consulta a `auth.users` por página (`lib/users/nome-de-quem-enviou.ts`). A
 * linha do canal é a linha CRUA de `messages` e não o tem — sem ele o balão caía
 * em "Atendente", sem dizer quem da equipe enviou. Aqui o nome é preenchido sem
 * rede, por dois caminhos: o que o PRÓPRIO fio já sabe (mensagens do mesmo autor
 * que vieram pela rota trazem o nome) e o nome de quem está com a conversa
 * aberta (`autorAtual`), que cobre o primeiro envio de cada pessoa. Nome que não
 * se conhece fica ausente aqui, e quem o busca é o chamador (abaixo).
 *
 * ─── O que continua sendo rede ──────────────────────────────────────────────
 * Três casos, todos decididos em `useMessagesRealtime`:
 *  - payload que nem vira evento (`eventoDeMensagem` devolve `null`): invalida,
 *    que é o comportamento de antes;
 *  - os dois campos que a ROTA deriva e a linha crua não traz: o
 *    `sent_by_user_name` de um colega que o fio não conhece e o `texto_retido`
 *    da mensagem que o contato apagou (`mascararTextoRetido`). Esses eventos
 *    entram no cache E pedem uma releitura;
 *  - o que `aplicarEventoNoFio` não consegue aplicar (cache ainda sem página,
 *    `UPDATE`/`DELETE` de mensagem que não está carregada) devolve `null`, e o
 *    chamador o DESCARTA (`?? atual`): mensagem fora do cache não está na tela.
 * E a rede de segurança (`useRefetchDeSeguranca`) segue no lugar: se a mescla
 * perder um evento, é ela que percebe pela assinatura (contagem + id do mais
 * recente) e ressincroniza.
 */

/** Uma página do fio, do jeito que o `useInfiniteQuery` a guarda. */
export interface PaginaDeMensagens {
  data: Array<Record<string, unknown>>;
  meta?: { cursor?: string | null; has_more?: boolean };
}

type FioEmCache = InfiniteData<PaginaDeMensagens>;

export type EventoDeMensagem =
  | { tipo: "insercao"; linha: Record<string, unknown> }
  | { tipo: "atualizacao"; linha: Record<string, unknown> }
  | { tipo: "remocao"; id: string };

/**
 * Quem está com a conversa aberta.
 *
 * Serve para duas coisas que o evento não conta: reconhecer o balão otimista do
 * PRÓPRIO envio (o `temp-…` não tem id de servidor) e nomear o autor quando ele
 * ainda não apareceu no fio.
 */
export interface AutorDoFio {
  id: string;
  nome: string | null;
}

export interface OpcoesDoFio {
  autorAtual?: AutorDoFio | null;
}

function linhaComId(valor: unknown): Record<string, unknown> | null {
  if (!valor || typeof valor !== "object") return null;
  const linha = valor as Record<string, unknown>;
  return typeof linha.id === "string" && linha.id.length > 0 ? linha : null;
}

/**
 * O evento do canal, traduzido — `null` para o que não é evento de `messages`
 * (o canal é assinado só nessa tabela, mas o payload chega como `unknown`).
 */
export function eventoDeMensagem(payload: unknown): EventoDeMensagem | null {
  if (!payload || typeof payload !== "object") return null;
  const evento = payload as { eventType?: unknown; table?: unknown; new?: unknown; old?: unknown };

  if (typeof evento.table === "string" && evento.table !== "messages") return null;

  if (evento.eventType === "INSERT" || evento.eventType === "UPDATE") {
    const linha = linhaComId(evento.new);
    if (!linha) return null;
    return { tipo: evento.eventType === "INSERT" ? "insercao" : "atualizacao", linha };
  }

  if (evento.eventType === "DELETE") {
    // O `old` do DELETE depende do REPLICA IDENTITY da tabela (default: só a
    // PK, que é o que precisamos). Sem id não há o que remover.
    const linha = linhaComId(evento.old);
    if (!linha) return null;
    return { tipo: "remocao", id: linha.id as string };
  }

  return null;
}

/** Os campos do evento por cima da mensagem em cache; ausente não apaga. */
function mesclar(
  mensagem: Record<string, unknown>,
  atualizacao: Record<string, unknown>,
): Record<string, unknown> {
  const mesclada = { ...mensagem };
  for (const [campo, valor] of Object.entries(atualizacao)) {
    if (valor !== undefined) mesclada[campo] = valor;
  }
  return mesclada;
}

/** O balão que ainda não é mensagem: `id` `temp-…` ou `metadata._optimistic`. */
function ehBalaoOtimista(mensagem: Record<string, unknown>): boolean {
  if (typeof mensagem.id === "string" && mensagem.id.startsWith("temp-")) return true;
  const meta = mensagem.metadata as { _optimistic?: unknown } | null | undefined;
  return meta?._optimistic === true;
}

/**
 * Os nomes de autor que o fio JÁ conhece, por `sent_by_user_id`.
 *
 * Só entra quem tem nome resolvido: as linhas que chegaram pela rota (com
 * `sent_by_user_name` preenchido) e a pessoa que está com a conversa aberta. Um
 * id sem nome não vira chave — o balão continua em "Atendente", que é a
 * informação verdadeira.
 */
function nomesConhecidos(dados: FioEmCache, opcoes: OpcoesDoFio): Map<string, string> {
  const nomes = new Map<string, string>();
  for (const pagina of dados.pages) {
    for (const m of pagina.data) {
      const id = m.sent_by_user_id;
      const nome = m.sent_by_user_name;
      if (typeof id === "string" && typeof nome === "string" && nome.trim()) {
        nomes.set(id, nome);
      }
    }
  }
  const atual = opcoes.autorAtual;
  if (atual && typeof atual.nome === "string" && atual.nome.trim()) {
    nomes.set(atual.id, atual.nome);
  }
  return nomes;
}

/**
 * A linha do evento com o autor preenchido — quando o fio sabe quem é.
 *
 * O que a rota já resolveu chega aqui inteiro e não é tocado: a linha do canal
 * pode vir de uma versão que já projeta o campo, e aí ele é a verdade.
 */
function comAutor(
  linha: Record<string, unknown>,
  nomes: Map<string, string>,
): Record<string, unknown> {
  const nome = linha.sent_by_user_name;
  if (typeof nome === "string" && nome.trim()) return linha;
  const id = linha.sent_by_user_id;
  if (typeof id !== "string" || !id) return linha;
  const resolvido = nomes.get(id);
  return resolvido ? { ...linha, sent_by_user_name: resolvido } : linha;
}

/**
 * O `INSERT` é a confirmação do balão otimista que está no fio?
 *
 * Sim quando o fio tem um otimista com o MESMO corpo e a linha real é um envio
 * DE QUEM ESTÁ AQUI (`autorAtual`). As duas condições importam: pelo corpo
 * sozinho, a mensagem de um colega com o mesmo texto ("ok") comeria o balão
 * otimista de um envio que ainda está em voo; pelo autor sozinho, dois envios
 * diferentes da mesma pessoa (outra aba) se atropelariam.
 *
 * Devolve as páginas sem ele. Idempotente: sem otimista correspondente, as
 * páginas voltam iguais.
 */
function semOBalaoOtimistaDoEnvio(
  dados: FioEmCache,
  linha: Record<string, unknown>,
  opcoes: OpcoesDoFio,
): FioEmCache {
  const autor = opcoes.autorAtual;
  if (!autor || linha.sent_by_user_id !== autor.id) return dados;

  const corpo = (linha.body ?? null) as string | null;
  const vira = (m: Record<string, unknown>) =>
    ehBalaoOtimista(m) && ((m.body ?? null) as string | null) === corpo;
  if (!dados.pages.some((p) => p.data.some(vira))) return dados;

  return {
    ...dados,
    pages: dados.pages.map((p) =>
      p.data.some(vira) ? { ...p, data: p.data.filter((m) => !vira(m)) } : p,
    ),
  };
}

/**
 * O fio em cache com o evento aplicado — ou `null` quando não há onde aplicar.
 *
 * `INSERT` de uma mensagem que já está no cache é IGNORADO: o canal pode
 * reentregar, e duplicar o balão é pior que não fazer nada (a rede de segurança
 * confere a assinatura de qualquer forma).
 */
export function aplicarEventoNoFio(
  dados: FioEmCache | undefined,
  evento: EventoDeMensagem,
  opcoes: OpcoesDoFio = {},
): FioEmCache | null {
  if (!dados || !Array.isArray(dados.pages) || dados.pages.length === 0) return null;
  const primeira = dados.pages[0];
  if (!primeira || !Array.isArray(primeira.data)) return null;

  const id = evento.tipo === "remocao" ? evento.id : (evento.linha.id as string);
  const jaNoFio = dados.pages.some((p) => p.data.some((m) => m.id === id));

  if (evento.tipo === "insercao") {
    if (jaNoFio) return dados;
    // A mensagem real entra no FIM — é a mais recente do pedaço mais novo — e
    // leva junto o balão otimista do mesmo envio, se ele estiver no fio.
    const linha = comAutor(evento.linha, nomesConhecidos(dados, opcoes));
    const semOtimista = semOBalaoOtimistaDoEnvio(dados, linha, opcoes);
    const novaPrimeira = semOtimista.pages[0] ?? primeira;
    return {
      ...semOtimista,
      pages: [
        { ...novaPrimeira, data: [...novaPrimeira.data, linha] },
        ...semOtimista.pages.slice(1),
      ],
    };
  }

  if (!jaNoFio) return null;

  if (evento.tipo === "remocao") {
    return {
      ...dados,
      pages: dados.pages.map((p) =>
        p.data.some((m) => m.id === id) ? { ...p, data: p.data.filter((m) => m.id !== id) } : p,
      ),
    };
  }

  // `UPDATE`: a confirmação também chega sem o nome do autor; o que já está no
  // balão é preservado (`undefined` não sobrescreve), e o que falta é suprido
  // pelo que o fio sabe.
  const linha = comAutor(evento.linha, nomesConhecidos(dados, opcoes));
  return {
    ...dados,
    pages: dados.pages.map((p) =>
      p.data.some((m) => m.id === id)
        ? {
            ...p,
            data: p.data.map((m) => (m.id === id ? mesclar(m, linha) : m)),
          }
        : p,
    ),
  };
}
