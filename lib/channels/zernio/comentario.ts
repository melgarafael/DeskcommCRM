/**
 * O COMENTÁRIO de um post — lido do webhook do provedor (#4075).
 *
 * ─── Por que este arquivo existe, e por que ele é PURO ─────────────────────
 *
 * Até aqui o webhook do canal social só lia eventos de MENSAGEM: recebida,
 * enviada, status, editada, apagada. `comment.*` caía no `null` de
 * `parseZernioInbound` e a rota respondia 200 `evento_sem_interesse` — o
 * comentário do cliente não era gravado, não virava evento e não disparava
 * regra nenhuma. É o pedido da #4075: "comente QUERO que eu te mando o link".
 *
 * Nada aqui toca banco, rede ou relógio. A separação é a mesma de
 * `./webhook.ts`: o que decide *o que o payload diz* prova-se sem
 * infraestrutura; o que escreve mora em `./ingest-comentario.ts`.
 *
 * ─── O FIO NÃO FOI MEDIDO CONTRA O PROVEDOR ────────────────────────────────
 *
 * Declarado, e não escondido: não houve credencial de conta comercial para
 * disparar um comentário de verdade e ler o payload. O nome do evento e a
 * grafia dos campos abaixo seguem a forma que o provedor já usa nos eventos de
 * mensagem (`event`, `account`, objeto do fato, `from` com `id`/`username`), e
 * os LEITORES aceitam as grafias alternativas que a Meta usa
 * (`postId`/`post_id`, `text`/`content`/`body`, `from`/`sender`/`author`).
 *
 * O que protege o primeiro dia real: o corpo cru de TODO webhook é arquivado
 * antes de qualquer leitura (`arquivo-de-webhook`), então a primeira entrega
 * de verdade — casando ou não — deixa o payload no banco. Se o nome do evento
 * for outro, quem investigar lê o arquivo e troca a constante
 * `EVENTO_DE_COMENTARIO`; o resto do caminho não muda.
 */
type Bruto = Record<string, unknown>;

const obj = (v: unknown): Bruto | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Bruto) : null;
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** O nome do evento de comentário no fio. Um só lugar para trocar quando medir. */
export const EVENTO_DE_COMENTARIO = "comment.created";

/** A rede cujo comentário este leitor aceita. Facebook entra pelo mesmo desenho. */
export const PLATAFORMA_DO_COMENTARIO = "instagram";

export interface ZernioComment {
  /** Id do comentário NO PROVEDOR — é a chave de idempotência da reentrega. */
  externalId: string;
  /** Post comentado. É o recorte "só neste post" da regra. */
  postId: string;
  platform: string;
  /** O texto do comentário, já sem espaços nas pontas. */
  text: string;
  /** Quem comentou, na âncora do canal social (o mesmo id que a DM usa). */
  authorId: string;
  authorUsername: string | null;
  authorName: string | null;
  /** Conta conectada que recebeu — casa com `channel_sessions.zernio_account_id`. */
  accountId: string | null;
  createdAt: string | null;
  /**
   * O comentário é do PRÓPRIO perfil? Responder o próprio post (a "private
   * reply" ou uma resposta pública) volta pelo mesmo webhook. Sem esta marca, a
   * regra do operador responderia a si mesma, e o laço só pararia na cota do
   * provedor.
   */
  fromSelf: boolean;
}

/**
 * Lê um payload de comentário. `null` quando não é isso — outro evento, outra
 * rede, ou payload sem o que identifica o comentário.
 *
 * Devolver `null` em vez de lançar é a mesma decisão de `parseZernioInbound`: a
 * rota responde 200 e o provedor para de reentregar um evento que nunca vai nos
 * servir.
 */
export function parseZernioComment(payload: unknown): ZernioComment | null {
  const p = obj(payload);
  if (!p) return null;
  if (str(p.event) !== EVENTO_DE_COMENTARIO) return null;

  const c = obj(p.comment);
  if (!c) return null;

  const conta = obj(p.account);
  // A conta serve outras redes; o comentário de outra plataforma não é deste
  // leitor. `platform` vem no comentário ou na conta, e as duas precisam dizer
  // Instagram quando dizem alguma coisa.
  const plataformaDoComentario = str(c.platform) ?? str(conta?.platform);
  if (plataformaDoComentario !== PLATAFORMA_DO_COMENTARIO) return null;

  const externalId = str(c.id) ?? str(c.commentId) ?? str(c.platformCommentId);
  if (!externalId) return null;

  // O post: `postId` é a grafia do provedor; as outras são as da Meta.
  const postId =
    str(c.postId) ??
    str(c.post_id) ??
    str(obj(c.post)?.id) ??
    str(obj(c.media)?.id) ??
    str(c.mediaId);
  if (!postId) return null;

  // O autor: `from` é a grafia do provedor; `sender`/`author` são as irmãs.
  const autor = obj(c.from) ?? obj(c.sender) ?? obj(c.author);
  const authorId = str(autor?.id) ?? str(c.authorId);
  if (!authorId) return null;

  const texto = str(c.text) ?? str(c.content) ?? str(c.body);

  const proprioId = str(autor?.id);
  const proprioNome = str(autor?.username);
  const idDaConta = str(conta?.selfId) ?? str(conta?.platformId) ?? str(conta?.instagramId);
  const usuarioDaConta = str(conta?.username);

  return {
    externalId,
    postId,
    platform: PLATAFORMA_DO_COMENTARIO,
    // Comentário sem texto (só emoji em anexo, por exemplo) não casa palavra
    // nenhuma — mas continua sendo linha gravada, para o histórico não mentir.
    text: texto?.trim() ?? "",
    authorId,
    authorUsername: proprioNome,
    authorName: str(autor?.name) ?? str(autor?.displayName),
    accountId: str(conta?.id) ?? str(conta?.accountId) ?? str(p.accountId),
    createdAt: str(c.createdAt) ?? str(c.created_at) ?? str(c.timestamp),
    fromSelf:
      autor?.isSelf === true ||
      (idDaConta !== null && proprioId !== null && idDaConta === proprioId) ||
      (usuarioDaConta !== null && proprioNome !== null && usuarioDaConta === proprioNome),
  };
}
