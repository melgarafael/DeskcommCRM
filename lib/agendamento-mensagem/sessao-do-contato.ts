/**
 * ESCOLHA DA CONVERSA (E DA SESSÃO) PELO QUAL O AGENDAMENTO SAI.
 *
 * O agendamento nasce numa conversa, e a conversa nasce numa conexão. Se a
 * conexão cai e o número é lido de novo por QR, a conexão nova tem outro id, e a
 * conversa antiga fica apontando para uma sessão parada: o envio nunca sai.
 *
 * A regra (decidida pelo mantenedor na #4431, 24/11): o envio sai pela conversa
 * MAIS RECENTE do contato cuja sessão está CONECTADA e tem o MESMO número de
 * telefone da conexão original. Outro número da empresa no ar não serve: o
 * cliente não deve receber de um número que talvez não conheça. Sem nenhuma,
 * não há envio nesta rodada; quem decide o que acontece depois é a escolha de
 * quem agendou (ver o cron).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ConversaDoContato {
  id: string;
  channel_session_id: string;
  /** Último contato recebido, ou a criação da conversa, quando ainda não houve. */
  ultimo_contato_em: string | null;
  status_da_sessao: string | null;
  /** Número de telefone da conexão desta conversa. */
  telefone_da_sessao: string | null;
}

export interface ConversaEscolhida {
  conversation_id: string;
  channel_session_id: string;
}

/**
 * Função pura: a conversa de envio entre as do contato. `null` = nenhuma conectada
 * na conexão original (`sessaoOriginalId`) nem em outra com o mesmo número
 * (`telefoneDaConexao`).
 */
export function escolherConversaConectada(
  conversas: readonly ConversaDoContato[],
  telefoneDaConexao: string | null,
  sessaoOriginalId?: string,
): ConversaEscolhida | null {
  // A própria conexão original é o mesmo número por definição, mesmo sem o número
  // gravado (a coluna só é preenchida quando alguém abre Conexões). Outra conexão
  // só vale com o número provado igual: sem número de referência, nenhuma outra.
  const mesmoNumero = (c: ConversaDoContato) =>
    c.channel_session_id === sessaoOriginalId ||
    (Boolean(telefoneDaConexao) && c.telefone_da_sessao === telefoneDaConexao);
  const conectadas = conversas.filter((c) => c.status_da_sessao === "WORKING" && mesmoNumero(c));
  if (conectadas.length === 0) return null;
  // Mais recente primeiro. Empate (ou sem data) mantém a ordem recebida: determinístico.
  const ordenadas = [...conectadas].sort((a, b) => {
    const ta = a.ultimo_contato_em ? Date.parse(a.ultimo_contato_em) : 0;
    const tb = b.ultimo_contato_em ? Date.parse(b.ultimo_contato_em) : 0;
    return tb - ta;
  });
  const escolhida = ordenadas[0];
  if (!escolhida) return null;
  return { conversation_id: escolhida.id, channel_session_id: escolhida.channel_session_id };
}

/**
 * Lê as conversas do contato na organização e escolhe a de envio, entre as que
 * estão em conexões com o mesmo número da conexão original do agendamento.
 */
export async function resolverConversaConectada(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
  sessaoOriginalId: string,
): Promise<ConversaEscolhida | null> {
  const { data: original, error: erroOriginal } = await admin
    .from("channel_sessions")
    .select("phone_number")
    .eq("id", sessaoOriginalId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  // Leitura que falhou não pode cancelar nem trocar a conversa: erro sobe e a rodada espera.
  if (erroOriginal) throw new Error(`sessao_original_falhou: ${erroOriginal.message}`);

  const { data, error } = await admin
    .from("conversations")
    .select("id, channel_session_id, last_inbound_at, created_at, channel_sessions:channel_session_id(status, phone_number)")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId);
  if (error) throw new Error(`conversas_do_contato_falhou: ${error.message}`);

  const linhas = (data ?? []) as unknown as Array<{
    id: string;
    channel_session_id: string;
    last_inbound_at: string | null;
    created_at: string | null;
    channel_sessions: { status: string | null; phone_number: string | null } | { status: string | null; phone_number: string | null }[] | null;
  }>;

  return escolherConversaConectada(
    linhas.map((l) => {
      const sessao = Array.isArray(l.channel_sessions) ? l.channel_sessions[0] : l.channel_sessions;
      return {
        id: l.id,
        channel_session_id: l.channel_session_id,
        ultimo_contato_em: l.last_inbound_at ?? l.created_at,
        status_da_sessao: sessao?.status ?? null,
        telefone_da_sessao: sessao?.phone_number ?? null,
      };
    }),
    original?.phone_number ?? null,
    sessaoOriginalId,
  );
}
