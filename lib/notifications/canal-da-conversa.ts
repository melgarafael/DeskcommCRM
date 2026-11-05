/**
 * Qual é a REDE da conversa que acabou de receber mensagem (issue #4094).
 *
 * A linha que chega pelo realtime de `messages` traz `channel_session_id`, não o
 * transporte: quem sabe o provider (e a plataforma social) é a sessão do canal.
 * A rota da conversa já devolve `channel_sessions` com os dois campos — a mesma
 * que a inbox usa para desenhar o logo —, então aqui só se pergunta a ela e se
 * traduz transporte → rede com `channelBrand`.
 *
 * Falha em qualquer ponto devolve `unknown`, e não uma exceção: o aviso precisa
 * sair de qualquer jeito; sem a informação do canal ele sai neutro, como antes
 * desta fatia.
 */
import { channelBrand } from "@/lib/channels/presentation";

/** Valor de `marcaDoCanal` para "não sei de onde veio" (fallback neutro). */
const SEM_CANAL = "unknown";

export async function canalDaConversa(conversationId: string | null): Promise<string> {
  if (!conversationId) return SEM_CANAL;
  try {
    const r = await fetch(`/api/v1/conversations/${conversationId}`, { credentials: "include" });
    if (!r.ok) return SEM_CANAL;
    const json = (await r.json()) as {
      data?: {
        channel_sessions?: { provider?: unknown; social_platform?: unknown } | null;
      } | null;
    };
    const sessao = json.data?.channel_sessions;
    return channelBrand({
      provider: typeof sessao?.provider === "string" ? sessao.provider : null,
      social_platform: typeof sessao?.social_platform === "string" ? sessao.social_platform : null,
    });
  } catch {
    return SEM_CANAL;
  }
}
