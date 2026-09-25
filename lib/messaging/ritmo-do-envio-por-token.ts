/**
 * O freio anti-ban de quem envia pela API com TOKEN — REST (`Bearer dsk_...`) e MCP.
 *
 * ## Por que existe
 *
 * `POST /api/v1/messages` e as ferramentas MCP de envio chamam
 * `sendMessageHandler` direto, sem a cadeia `before_send` (`runBeforeSend`). Pela
 * tela isso é certo: um atendente não digita rápido o bastante para queimar o
 * número. Por token não é: um script ou um agente externo em laço mandava
 * centenas de mensagens seguidas pelo mesmo número, sem espaçamento, sem teto de
 * warm-up — e sem contar no `pacing_ledger`, então o agente do próprio CRM seguia
 * achando que o número estava folgado.
 *
 * ## O que NÃO é
 *
 * Não é uma segunda REGRA. A decisão é `criarPacingDoCanal` (`ledger-supabase.ts`),
 * a mesma que o aviso ao suporte usa: espaçamento + teto diário (warm-up e
 * `daily_message_limit`). Os vetos de CONTEÚDO (promessa, vocabulário interno,
 * disclosure) ficam de fora de propósito — são para texto escrito pela IA do
 * CRM, e quem chama por token responde pelo que escreve.
 *
 * A janela de horário (7h-22h) também fica de fora: integração legítima manda
 * confirmação de pedido às 23h, e represá-la até as 7h quebraria o caso de uso.
 *
 * ## Limite conhecido
 *
 * Não há lock por número (o agente usa `pg_advisory_xact_lock`, que o PostgREST
 * não oferece). Duas chamadas CONCORRENTES leem o mesmo ledger e passam juntas.
 * O que segura a rajada paralela é o teto de chamadas por token (REST: nesta
 * rota; MCP: `lib/mcp/rate-limit.ts`), não este freio.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  criarPacingDoCanal,
  type DecisaoDeEspacamento,
} from "@/lib/agent-engine/pacing/ledger-supabase";
import { ApiError } from "@/lib/api/types";
import { capabilitiesOf, DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels/capabilities";
import type { ChannelProvider } from "@/lib/channels/types";

/**
 * Espaçamento curto é ESPERADO dentro da requisição (o throttle é ~1,2s + jitter);
 * acima disto a requisição devolve 429 em vez de segurar a conexão aberta.
 */
export const ESPERA_MAXIMA_MS = 5_000;

export interface CanalDaConversa {
  channelSessionId: string;
  provider: string | null;
}

export interface DepsDoRitmo {
  lerCanalDaConversa(organizationId: string, conversationId: string): Promise<CanalDaConversa | null>;
  lerCanalDaSessao?(organizationId: string, channelSessionId: string): Promise<CanalDaConversa | null>;
  pacing: {
    decide(organizationId: string, channelSessionId: string, agora: Date): Promise<DecisaoDeEspacamento>;
    registraEnvio(organizationId: string, channelSessionId: string, quando: Date): Promise<void>;
  };
  sleep(ms: number): Promise<void>;
  agora(): Date;
}

/** Entrada aceita por `segurarEnvioPorToken`: por conversa existente ou direto pela sessão do canal. */
export type EntradaDoFreio =
  | { organizationId: string; conversationId: string; requestId: string }
  | { organizationId: string; channelSessionId: string; requestId: string };

/** O que `segurarEnvioPorToken` devolve e `registrarEnvioPorToken` consome. */
export type EnvioSegurado = { channelSessionId: string } | null;

function temRiscoDeBan(provider: string | null): boolean {
  try {
    return capabilitiesOf((provider ?? DEFAULT_CHANNEL_PROVIDER) as ChannelProvider).banRisk;
  } catch {
    // Provider fora da matriz: falha FECHADA. Errar para "sem risco" desarmaria
    // o freio num número que pode ser banido.
    return true;
  }
}

/**
 * Segura o envio até o número poder mandar, ou recusa com 429.
 *
 * Devolve `null` quando não há o que frear (canal sem risco de ban, ou conversa
 * que não é desta organização — aí quem responde é o handler, com o 404 dele).
 */
export async function segurarEnvioPorToken(
  deps: DepsDoRitmo,
  entrada: EntradaDoFreio,
): Promise<EnvioSegurado> {
  const canal =
    "channelSessionId" in entrada
      ? await (deps.lerCanalDaSessao
          ? deps.lerCanalDaSessao(entrada.organizationId, entrada.channelSessionId)
          : null)
      : await deps.lerCanalDaConversa(entrada.organizationId, entrada.conversationId);
  if (!canal || !temRiscoDeBan(canal.provider)) return null;

  const agora = deps.agora();
  const decisao = await deps.pacing.decide(entrada.organizationId, canal.channelSessionId, agora);
  if (decisao.liberado) return { channelSessionId: canal.channelSessionId };

  const esperaMs = Math.max(0, decisao.liberaEm.getTime() - agora.getTime());
  if (decisao.motivo === "espacamento" && esperaMs <= ESPERA_MAXIMA_MS) {
    await deps.sleep(esperaMs);
    return { channelSessionId: canal.channelSessionId };
  }

  const retryAfterSeconds = Math.max(1, Math.ceil(esperaMs / 1000));
  const liberaEm = decisao.liberaEm.toISOString();
  // O valor vai no texto, não só em `details`: o servidor MCP devolve ao cliente apenas a
  // mensagem do erro (lib/mcp/server.ts), e um modelo sem o horário não sabe quando voltar.
  throw new ApiError(
    429,
    "rate_limited",
    { motivo: decisao.motivo, libera_em: liberaEm, retry_after_seconds: retryAfterSeconds },
    entrada.requestId,
    decisao.motivo === "teto_diario"
      ? `Este número atingiu o limite de envios de hoje. Tente de novo depois de ${liberaEm} (em ${retryAfterSeconds}s).`
      : `Envios rápidos demais para este número. Tente de novo em ${retryAfterSeconds}s.`,
  );
}

/** Conta no `pacing_ledger` o envio que passou pelo freio e não falhou. Nunca lança. */
export async function registrarEnvioPorToken(
  deps: Pick<DepsDoRitmo, "pacing" | "agora">,
  organizationId: string,
  segurado: EnvioSegurado,
  status: string,
): Promise<void> {
  if (!segurado || status === "failed") return;
  await deps.pacing.registraEnvio(organizationId, segurado.channelSessionId, deps.agora());
}

/** As dependências reais. `admin` é service role: toda leitura filtra `organization_id`. */
export async function depsDoRitmo(admin: SupabaseClient): Promise<DepsDoRitmo> {
  return {
    async lerCanalDaConversa(organizationId, conversationId) {
      const { data } = await admin
        .from("conversations")
        .select("channel_session_id, channel_sessions:channel_session_id(provider)")
        .eq("organization_id", organizationId)
        .eq("id", conversationId)
        .maybeSingle();
      const linha = data as {
        channel_session_id: string | null;
        channel_sessions: { provider: string | null } | null;
      } | null;
      if (!linha?.channel_session_id) return null;
      return {
        channelSessionId: linha.channel_session_id,
        provider: linha.channel_sessions?.provider ?? null,
      };
    },
    async lerCanalDaSessao(organizationId, channelSessionId) {
      const { data } = await admin
        .from("channel_sessions")
        .select("id, provider")
        .eq("organization_id", organizationId)
        .eq("id", channelSessionId)
        .maybeSingle();
      const linha = data as { id: string; provider: string | null } | null;
      if (!linha?.id) return null;
      return {
        channelSessionId: linha.id,
        provider: linha.provider ?? null,
      };
    },
    pacing: await criarPacingDoCanal(admin),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    agora: () => new Date(),
  };
}
