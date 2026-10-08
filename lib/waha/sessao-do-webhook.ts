/**
 * A conexão (e o segredo do HMAC) que um webhook do WAHA precisa — com memória
 * curta no processo.
 *
 * ═══ Por que existe ═══
 *
 * Todo evento do WAHA (mensagem, ack, mudança de estado) fazia DUAS chamadas ao
 * banco antes de qualquer trabalho: buscar `channel_sessions` pelo nome/token e
 * decifrar o segredo por `fn_decrypt_oauth`. Medido numa VPS em 06/10/2026, no
 * painel de logs do Supabase: `GET /rest/v1/channel_sessions?waha_session_name=…`
 * era a linha mais repetida — e a conta do plano grátis estourou a cota de
 * ingestão de logs em 14×. Pior no dia ruim: com o banco lento, o webhook falha,
 * o WAHA reentrega, e cada reentrega refaz as duas chamadas, empilhando carga
 * justamente quando o banco menos aguenta.
 *
 * ═══ O que pode ficar velho, e por quanto tempo ═══
 *
 * `TTL_MS` (30 s). Os campos lidos daqui mudam raramente (organização, nome,
 * segredo, flags de aquecimento). O pior caso de cada um:
 *   - segredo trocado: o próximo webhook falha o HMAC; a rota chama
 *     `esquecerSessaoDoWebhook` e o seguinte já lê do banco. O WAHA reentrega.
 *   - canal arquivado: até 30 s de eventos em voo ainda são ingeridos — o mesmo
 *     que já acontecia com evento que chegava logo antes do arquivamento.
 *
 * ═══ O que NÃO entra na memória ═══
 *
 * Erro de consulta, "não encontrado" e decifragem que LANÇOU. Guardar a ausência
 * faria um canal recém-criado ignorar seus primeiros eventos por 30 s; guardar o
 * erro estenderia uma falha passageira do banco.
 *
 * Segredo `null` com o RPC tendo RESPONDIDO entra, sim: é o estado permanente de
 * toda sessão WAHA, que nasce com `webhook_secret_encrypted = '\x00'` e que
 * `fn_decrypt_oauth` devolve como NULL de propósito (migration 0240). Sem guardar
 * esse caso, a memória nunca guardaria nada numa instalação criada pelo produto.
 * É seguro: o segredo só confere assinatura, e um evento assinado que falha já
 * chama `esquecerSessaoDoWebhook` — o seguinte relê do banco.
 */

export const TTL_MS = 30_000;
/** Teto de entradas: uma instalação tem poucas conexões; isto só evita crescer sem fim. */
export const MAX_ENTRADAS = 500;

export interface LinhaDaSessao {
  id: string;
  organization_id: string;
  waha_session_name: string;
  webhook_secret_encrypted: string | null;
  status: string | null;
  is_warmup_complete: boolean | null;
  warmup_started_at: string | null;
}

export interface SessaoComSegredo<T extends LinhaDaSessao = LinhaDaSessao> {
  session: T;
  /** Segredo decifrado; `null` quando não há credencial ou a decifragem falhou. */
  segredo: string | null;
}

type Resultado<T extends LinhaDaSessao> =
  | { ok: true; valor: SessaoComSegredo<T> | null }
  | { ok: false; erro: string };

const memoria = new Map<string, { valor: SessaoComSegredo; expiraEm: number }>();

/**
 * Devolve a conexão + segredo da chave (`nome:<sessão>` ou `token:<token>`),
 * da memória quando ainda vale, do banco quando não.
 *
 * `carregar` e `decifrar` são injetados: a regra de cache fica testável sem
 * banco, e cada rota mantém a sua consulta (por nome ou por token). `decifrar`
 * devolve `null` quando não há credencial e LANÇA quando a decifragem falhou.
 */
export async function sessaoDoWebhook<T extends LinhaDaSessao>(
  chave: string,
  carregar: () => Promise<{ data: T | null; error: { message: string } | null }>,
  decifrar: (cifrado: string | null) => Promise<string | null>,
  agora: number = Date.now(),
): Promise<Resultado<T>> {
  const guardada = memoria.get(chave);
  if (guardada && guardada.expiraEm > agora) {
    return { ok: true, valor: guardada.valor as SessaoComSegredo<T> };
  }
  if (guardada) memoria.delete(chave);

  const { data, error } = await carregar();
  if (error) return { ok: false, erro: error.message };
  if (!data) return { ok: true, valor: null };

  let segredo: string | null;
  try {
    segredo = await decifrar(data.webhook_secret_encrypted);
  } catch {
    // Decifragem que falhou (erro do RPC) não vai para a memória: a próxima chamada tenta de novo.
    return { ok: true, valor: { session: data, segredo: null } };
  }
  const valor: SessaoComSegredo<T> = { session: data, segredo };
  if (memoria.size >= MAX_ENTRADAS) {
    const maisAntiga = memoria.keys().next().value;
    if (maisAntiga !== undefined) memoria.delete(maisAntiga);
  }
  memoria.set(chave, { valor, expiraEm: agora + TTL_MS });
  return { ok: true, valor };
}

/** Tira a chave da memória — chamado quando o HMAC falha com o segredo guardado. */
export function esquecerSessaoDoWebhook(chave: string): void {
  memoria.delete(chave);
}

/** Só para teste. */
export function limparMemoriaDeSessoes(): void {
  memoria.clear();
}
