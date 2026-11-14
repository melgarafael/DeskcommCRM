import { PAPEIS_HUMANOS, type Role } from "@/lib/auth/types";

/**
 * O TEXTO RETIDO DE UMA MENSAGEM QUE O CONTATO APAGOU (#4500).
 *
 * ─── O que existe hoje, e por que este arquivo existe ──────────────────────
 *
 * O ingest do canal NUNCA limpa o corpo: o evento de revogação só carimba
 * `messages.revoked_at`. O texto
 * fica no banco, e a Inbox esconde — `textoDaApagadaApareceNaInbox` decide que a
 * apagada pelo CONTATO não mostra o corpo. Só que esconder no balão não é o
 * mesmo que não entregar: até esta mudança o corpo viajava no payload normal da
 * conversa (`MSG_COLS` inclui `body`), e qualquer leitura da rota — ou do
 * histórico pelo MCP — o recebia inteiro.
 *
 * Revelar passa a ser uma PORTA PRÓPRIA, com permissão por perfil e auditoria de
 * cada clique (`app/api/v1/messages/[id]/texto-retido/route.ts`). Para isso o
 * carregamento normal precisa PARAR de mandar o corpo — é `mascararTextoRetido`
 * aqui embaixo quem faz isso, no único ponto por onde todo mundo lê a thread.
 *
 * ─── As três decisões que este arquivo fixa ────────────────────────────────
 *
 * 1. A lista de perfis autorizados começa VAZIA. Nenhum papel entra por
 *    padrão — nem `admin`. Quem não configurou não revela nada, e é isso que
 *    faz a entrega ser `capacidade_nova` sem tirar acesso de ninguém.
 * 2. A lista é POR ORGANIZAÇÃO, e mora em `organizations.settings` (jsonb que já
 *    existe, com escritor próprio por bloco). Não há migration: uma coluna nova
 *    só para isto exigiria espelho no baseline e uma cerimônia de numeração para
 *    guardar um array de quatro valores.
 * 3. Só PAPEL HUMANO entra. `ai_operator` não é assento de gente
 *    (`PAPEIS_HUMANOS`) e valor desconhecido — resto de versão futura, jsonb
 *    editado à mão — é DESCARTADO na leitura, nunca aceito por engano.
 */

/** A chave em `organizations.settings`. Nada além dela pertence a esta feature. */
export const CHAVE_DO_TEXTO_RETIDO = "texto_retido";

/**
 * A prévia da conversa quando a última mensagem é uma apagada pelo contato.
 *
 * Substitui o corpo em `conversations.last_message_preview` — a coluna que a
 * lista da Inbox MOSTRA e pela qual a busca filtra (`ilike`). Sem esta troca, o
 * contato apaga a mensagem e o texto continua na lista e na busca, que é
 * justamente o caminho que a #4500 manda fechar.
 */
export const PREVIA_DA_APAGADA_PELO_CONTATO = "Mensagem apagada pelo contato";

/** O campo que o payload da thread usa para dizer "existe texto retido aqui". */
export const CAMPO_TEXTO_RETIDO = "texto_retido";

/**
 * Os perfis que o administrador pode marcar na tela — a mesma lista de papéis
 * humanos que a Equipe usa (`PAPEIS_HUMANOS`), e não uma segunda lista manual
 * que divergiria na primeira vez que alguém mexesse numa só.
 */
export const PERFIS_AUTORIZAVEIS: readonly Role[] = PAPEIS_HUMANOS;

/**
 * Os perfis autorizados daquela organização. Ausente, `null`, formato errado ou
 * papel desconhecido → lista VAZIA (ou só os valores válidos que sobraram).
 *
 * A leitura é tolerante de propósito: `settings` é jsonb compartilhado por
 * vários donos, e um bloco corrompido não pode derrubar a rota de revelação com
 * 500 — tem que negar.
 */
export function perfisDoTextoRetido(settings: unknown): Role[] {
  if (!settings || typeof settings !== "object") return [];
  const bloco = (settings as Record<string, unknown>)[CHAVE_DO_TEXTO_RETIDO];
  if (!bloco || typeof bloco !== "object") return [];
  const perfis = (bloco as Record<string, unknown>).perfis;
  if (!Array.isArray(perfis)) return [];

  const validos: Role[] = [];
  for (const item of perfis) {
    if (typeof item !== "string") continue;
    // `PAPEIS_HUMANOS.includes` com o tipo estreito: um valor fora da lista
    // (inclusive `ai_operator`) não entra.
    const papel = PAPEIS_HUMANOS.find((p) => p === item);
    if (papel && !validos.includes(papel)) validos.push(papel);
  }
  return validos;
}

/**
 * Este perfil, NESTA organização, pode ver o texto retido?
 *
 * `role` é o papel já resolvido pelo gate da rota (`requireRole`), nunca o que o
 * cliente mandou. Papel nulo (sessão sem vínculo) nega.
 */
export function podeVerTextoRetido(settings: unknown, role: string | null | undefined): boolean {
  if (!role) return false;
  return perfisDoTextoRetido(settings).some((perfil) => perfil === role);
}

/** O bloco novo de `settings`, pronto para gravar (merge feito pelo chamador). */
export function blocoDoTextoRetido(perfis: readonly Role[]): Record<string, unknown> {
  return { perfis: [...perfis] };
}

type MensagemMascaravel = {
  direction?: string | null;
  revoked_at?: string | null;
  body?: string | null;
  media_derived_text?: string | null;
};

/**
 * A MÁSCARA DO PAYLOAD: o corpo de uma mensagem apagada PELO CONTATO não sai da
 * leitura normal da thread.
 *
 * Mora aqui — e não no handler — porque o handler é a porta de TODO consumidor
 * do histórico (rota REST com sessão, rota com `Bearer dsk_…`, tools MCP com
 * service role). Um mascaramento no componente esconderia o balão e deixaria o
 * texto no JSON; um só no handler deixaria a próxima porta repetir o esquecimento.
 *
 * O que a linha DEVOLVE no lugar: `body: null`, a transcrição de mídia também
 * (é texto derivado do mesmo conteúdo) e `texto_retido: true` quando havia algo
 * retido. O booleano é o que deixa o botão "Ver texto retido" aparecer sem que o
 * navegador receba uma vírgula do texto.
 *
 * A apagada pelo ATENDENTE não é tocada: a régua de
 * `textoDaApagadaApareceNaInbox` mostra o corpo dela à equipe, e mascarar aqui
 * mudaria esse comportamento sem ninguém ter pedido.
 */
export function mascararTextoRetido<T extends MensagemMascaravel>(
  mensagem: T,
): T & { texto_retido?: boolean } {
  if (mensagem.revoked_at == null || mensagem.direction !== "inbound") return mensagem;

  const retido = Boolean(mensagem.body?.trim() || mensagem.media_derived_text?.trim());
  const mascarada: T & { texto_retido?: boolean } = {
    ...mensagem,
    body: null,
    media_derived_text: null,
  };
  if (retido) mascarada[CAMPO_TEXTO_RETIDO] = true;
  return mascarada;
}
