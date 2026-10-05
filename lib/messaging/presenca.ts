/**
 * "digitando…" — a metade do atraso humano que é do CANAL.
 *
 * ─── O que este módulo é ────────────────────────────────────────────────────
 *
 * A borda entre "o turno do agente quer sinalizar presença" e "o canal sabe
 * como". Ele NÃO decide se deve sinalizar (isso é do turno), não espera (isso é
 * de `lib/agent-engine/agent/atraso-humano.ts`) e não sabe o nome de nenhum
 * provider — pede o adapter e testa se ele implementa o método.
 *
 * ─── Por que a resolução do destino é a MESMA do envio ──────────────────────
 *
 * O ref da sessão sai de `resolveSessionRef` e o endereço de `resolveRecipient`
 * — as mesmas duas funções que `app/api/v1/messages/_handler.ts` usa para
 * mandar a mensagem. Uma segunda maneira de descobrir "por qual número, para
 * qual endereço" divergiria da primeira no dia em que uma delas mudasse, e o
 * sintoma seria "digitando…" aparecendo numa conversa e a mensagem saindo
 * noutra. Endereçamento tem uma fonte só.
 *
 * ─── Silêncio é o desfecho normal ───────────────────────────────────────────
 *
 * Conversa que sumiu, sessão fora do ar, contato sem endereço, canal que não
 * sabe sinalizar, transporte não configurado: todos terminam sem chamada e sem
 * erro. Nenhum deles é defeito — são o estado corriqueiro de uma instalação
 * real, e transformá-los em exceção encheria o log de ruído sobre o normal.
 *
 * O que este módulo NÃO engole é a recusa do transporte: se o canal foi
 * chamado e disse não, o erro sobe. Quem chama (`esperarComoHumano`) é que
 * decide falhar macio, num ponto só e com teste próprio.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  CHANNEL_SESSION_REF_COLUMNS,
  DEFAULT_CHANNEL_PROVIDER,
  getAdapter,
  resolveSessionRef,
  type ChannelSessionRef,
} from "@/lib/channels";

/** Único estado em que o canal pode falar agora — mesmo critério do handler de envio. */
const SESSAO_SAUDAVEL = "WORKING";

interface ConversaParaPresenca {
  is_group: boolean;
  group_chat_id: string | null;
  contacts: {
    phone_number: string | null;
    wa_identity: string | null;
    wa_lid: string | null;
  } | null;
  channel_sessions: (ChannelSessionRef & { status: string }) | null;
}

export interface SinalizarDigitandoInput {
  /**
   * De FONTE CONFIÁVEL (row do job, cookie, token do webhook) — nunca do corpo
   * de um payload externo. Este módulo usa um client de service role, que
   * bypassa RLS: sem este filtro, um id de conversa vazado acenderia
   * "digitando…" no número de outro tenant.
   */
  organizationId: string;
  conversationId: string;
}

export async function sinalizarDigitando(
  supabase: SupabaseClient,
  input: SinalizarDigitandoInput,
): Promise<void> {
  const { data } = await supabase
    .from("conversations")
    .select(
      `is_group, group_chat_id, contacts:contact_id(phone_number, wa_identity, wa_lid), ` +
        `channel_sessions:channel_session_id(${CHANNEL_SESSION_REF_COLUMNS}, status)`,
    )
    .eq("id", input.conversationId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();

  const conversa = data as unknown as ConversaParaPresenca | null;
  if (!conversa) return;

  const sessao = conversa.channel_sessions;
  // Sessão fora do ar: o canal recusaria de qualquer forma, e perguntar custa
  // uma ida à rede dentro do caminho de resposta ao cliente.
  if (!sessao || sessao.status !== SESSAO_SAUDAVEL) return;

  const adapter = getAdapter(sessao.provider ?? DEFAULT_CHANNEL_PROVIDER);
  // Testa a presença do método — nunca pergunta QUAL provider é (invariante 1
  // da doutrina de restrição de canal).
  if (!adapter.signalTyping) return;

  const recipient = adapter.resolveRecipient({
    isGroup: conversa.is_group,
    groupChatId: conversa.group_chat_id,
    phoneNumber: conversa.contacts?.phone_number,
    waIdentity: conversa.contacts?.wa_identity,
    waLid: conversa.contacts?.wa_lid,
  });
  if (!recipient) return;

  await adapter.signalTyping({
    organizationId: input.organizationId,
    sessionRef: resolveSessionRef(sessao),
    recipient,
    inboundExternalId: await ultimaMensagemDoCliente(supabase, input),
  });
}

/**
 * O `external_id` da última mensagem que o cliente mandou nesta conversa.
 *
 * Há canal em que o "digitando…" não é da conversa, é da MENSAGEM que se está
 * respondendo: sem esse id ele não tem o que sinalizar. Buscar aqui, e não no
 * adapter, mantém o adapter burro (traduz formato, não lê banco de conversa) e
 * a leitura escopada por organização num lugar só, o mesmo da conversa acima.
 * A consulta só acontece depois de todos os "não há o que sinalizar", então
 * canal sem presença não paga por ela; o canal que ignora o campo paga uma
 * leitura pelo índice `(conversation_id, sent_at desc)`.
 *
 * Reação e mensagem de sistema ficam de fora: são registros do cliente, mas não
 * uma mensagem que alguém responde — e o id delas não é o que se quer ler.
 * `sent_at` (e não `created_at`) é a hora da mensagem, a mesma que o resto do
 * código usa para achar "a última do cliente"; reentrega fora de ordem não troca
 * a escolha.
 */
async function ultimaMensagemDoCliente(
  supabase: SupabaseClient,
  input: SinalizarDigitandoInput,
): Promise<string | null> {
  const { data } = await supabase
    .from("messages")
    .select("external_id")
    .eq("organization_id", input.organizationId)
    .eq("conversation_id", input.conversationId)
    .eq("direction", "inbound")
    .not("type", "in", "(reaction,system)")
    .order("sent_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { external_id: string | null } | null)?.external_id ?? null;
}
