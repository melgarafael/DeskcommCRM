/**
 * O estado do atendimento do chat no site (spec 36, F3): `sem_agente`, `aberto` ou `fechado`.
 *
 * A janela e o aviso são do AGENTE que atende a conexão (`trigger_config.filters.business_hours`),
 * os mesmos que o motor já usa para adiar o turno. Esta fatia não cria horário novo: lê a versão
 * publicada da conexão e devolve o estado para a janela mostrar.
 *
 * Falha ABERTA: erro de leitura vira `aberto` com `logger.warn`, e o chat segue funcionando.
 * O escopo é sempre `organization_id` e `channel_session_id` vindos da rota, nunca do corpo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { lerTextoDoAvisoForaDoHorario } from "@/lib/agent-engine/agent/aviso-fora-do-horario";
import { lerJanelaDeAtendimento, msAteAJanelaAbrir } from "@/lib/agent-engine/agent/janela-de-atendimento";
import { logger } from "@/lib/logger";

export type EstadoDoAtendimento = {
  estado: "sem_agente" | "aberto" | "fechado";
  /** Instante ISO-8601 UTC em que o atendimento volta. Só no estado `fechado`. */
  abreEm: string | null;
  /** Texto configurado no agente. Só no estado `fechado`, ou `null`. */
  aviso: string | null;
};

export type VersaoDoAtendimento = { triggerConfig: unknown; pausado: boolean };

const ABERTO: EstadoDoAtendimento = { estado: "aberto", abreEm: null, aviso: null };
const SEM_AGENTE: EstadoDoAtendimento = { estado: "sem_agente", abreEm: null, aviso: null };

/**
 * Pura. Usa o PRIMEIRO agente não pausado (a lista vem ordenada). Nenhum = `sem_agente`.
 * Sem janela legível ou fuso inválido = `aberto`. Fora da janela = `fechado`.
 */
export function decidirAtendimento(versoes: VersaoDoAtendimento[], agora: Date): EstadoDoAtendimento {
  const ativa = versoes.find((v) => v.pausado === false);
  if (ativa === undefined) return SEM_AGENTE;

  const janela = lerJanelaDeAtendimento(ativa.triggerConfig);
  if (janela === null) return ABERTO;

  const ms = msAteAJanelaAbrir(janela, agora);
  if (ms === null) return ABERTO;

  return {
    estado: "fechado",
    abreEm: new Date(agora.getTime() + ms).toISOString(),
    aviso: lerTextoDoAvisoForaDoHorario(ativa.triggerConfig),
  };
}

interface LinhaDaVersao {
  id: string;
  trigger_config: unknown;
  ai_agents: {
    published_version_id: string | null;
    paused_at: string | null;
    archived_at: string | null;
    priority: number | null;
    created_at: string | null;
  } | null;
}

/**
 * Lê a versão publicada da conexão e decide o estado. Qualquer erro (resposta com erro ou
 * exceção) vira `aberto`, com `logger.warn` (falha aberta: o chat nunca fica mudo por leitura).
 */
export async function carregarAtendimento(
  admin: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
  agora: Date,
): Promise<EstadoDoAtendimento> {
  try {
    const { data, error } = await admin
      .from("ai_agent_versions")
      .select("id, trigger_config, ai_agents!ai_agent_versions_agent_id_fkey(published_version_id, paused_at, archived_at, priority, created_at)")
      .eq("organization_id", organizationId)
      .eq("channel_session_id", channelSessionId)
      .eq("status", "published");
    if (error) throw new Error(error.message);

    const linhas = (data ?? []) as unknown as LinhaDaVersao[];
    const versoes = linhas
      // Mesmo critério de `escolherAgenteDoNumero`: só vale a versão que é a PUBLICADA do agente
      // (`ai_agents.published_version_id`), e agente arquivado não atende.
      .filter(
        (l) =>
          l.ai_agents !== null &&
          l.ai_agents.published_version_id === l.id &&
          (l.ai_agents.archived_at ?? null) === null,
      )
      .map((l) => ({
        triggerConfig: l.trigger_config,
        pausado: (l.ai_agents?.paused_at ?? null) !== null,
        prioridade: l.ai_agents?.priority ?? 0,
        criadoEm: l.ai_agents?.created_at ?? "",
      }))
      .sort(
        (a, b) =>
          Number(a.pausado) - Number(b.pausado) ||
          b.prioridade - a.prioridade ||
          a.criadoEm.localeCompare(b.criadoEm),
      )
      .map(({ triggerConfig, pausado }) => ({ triggerConfig, pausado }));

    return decidirAtendimento(versoes, agora);
  } catch (err) {
    logger.warn("webchat: leitura do horário do atendimento falhou; atendimento tratado como aberto", {
      organization_id: organizationId,
      channel_session_id: channelSessionId,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    });
    return ABERTO;
  }
}
