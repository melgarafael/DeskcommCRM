/**
 * A JANELA DE ENVIO DA AUTOMAÇÃO É A MESMA QUE O OPERADOR CONFIGUROU.
 *
 * ═══ As duas réguas que existiam ═══
 *
 * O produto tem um motor de pacing anti-ban completo — `lib/agent-engine/pacing`
 * — com janela horária no FUSO DO TENANT, domingo opcional, warm-up por idade do
 * número e throttle com jitter. Ele é editável por número na tela de Conexões
 * (`POST /api/v1/ai/pacing` → tabela `channel_knobs`) e é o que rege o agente.
 *
 * A automação tinha uma segunda régua, escrita à parte: `withinSendWindow()`,
 * 7h–22h fixas, avaliadas com `new Date().getHours()` — a hora do RELÓGIO DO
 * SERVIDOR. Duas consequências, e a segunda é pior:
 *
 *  1. Num contêiner Docker o relógio é UTC por padrão. "7h–22h" vira 4h–19h de
 *     Brasília: uma automação disparada às 19h30 do horário comercial ficava
 *     represada até as 4h da manhã, sem nada na tela dizendo isso.
 *  2. Quem abriu Conexões, mudou a janela do número e salvou, viu a mudança
 *     valer para o agente e NÃO valer para a automação. Controle que não
 *     controla é pior que controle nenhum: gasta a confiança de quem clicou.
 *
 * ═══ Por que este arquivo em vez de importar o store do pacing ═══
 *
 * `loadChannelKnobs` fala `pg.Pool`; a automação roda dentro do Next (drain do
 * `event_log`) e fala Supabase. A REGRA — que é a parte que não pode divergir —
 * é importada de lá, pura: `janelaDeEnvioAberta` e `proximaAberturaDaJanela`.
 * Só a leitura da linha é reescrita, contra a MESMA tabela e com os MESMOS
 * defaults. É a ponte mínima, no mesmo espírito de `lib/ai/gateway-binding.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { PACING_DEFAULTS, type PacingKnobs } from "@/lib/agent-engine/pacing/defaults";
import {
  janelaDeEnvioAberta,
  proximaAberturaDaJanela,
} from "@/lib/agent-engine/pacing/engine";
import { fusoDaJanela, parseWarmupCaps } from "@/lib/agent-engine/pacing/store";
import { logger } from "@/lib/logger";

interface LinhaDeKnobs {
  throttle_ms: number | null;
  jitter_max_ms: number | null;
  window_start_hour: number | null;
  window_end_hour: number | null;
  allow_sunday: boolean | null;
  timezone: string | null;
  warmup_daily_caps: unknown;
}

/**
 * Os knobs em vigor para este número. Sem linha em `channel_knobs` — o caso de
 * quem nunca abriu a tela — devolve os defaults do pacing (7h–22h) no fuso da
 * ORGANIZAÇÃO: a mesma escada de `fusoDaJanela` que o motor usa.
 */
export async function knobsDoCanal(
  admin: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
): Promise<PacingKnobs> {
  const [{ data, error }, { data: org }] = await Promise.all([
    admin
      .from("channel_knobs")
      .select(
        "throttle_ms, jitter_max_ms, window_start_hour, window_end_hour, allow_sunday, timezone, warmup_daily_caps",
      )
      .eq("organization_id", organizationId)
      .eq("channel_session_id", channelSessionId)
      .maybeSingle(),
    // Falha aqui vira `null`, e `fusoDaJanela` cai no padrão: o fuso é
    // refinamento, e não pode calar o envio.
    admin.from("organizations").select("timezone").eq("id", organizationId).maybeSingle(),
  ]);
  const fusoDaOrg = (org as { timezone?: string | null } | null)?.timezone;

  // Falha ABERTA na ação (a automação segue com os defaults) e nomeada no log:
  // uma leitura que falha não pode calar o envio, mas também não pode sumir.
  if (error) {
    logger.warn("[automation.janela] não foi possível ler os knobs do número — usando os padrões", {
      organizationId,
      channelSessionId,
      causa: error.message,
    });
    return { ...PACING_DEFAULTS, timezone: fusoDaJanela(null, fusoDaOrg) };
  }
  const linha = data as LinhaDeKnobs | null;
  if (!linha) return { ...PACING_DEFAULTS, timezone: fusoDaJanela(null, fusoDaOrg) };

  const caps = linha.warmup_daily_caps === null ? null : parseWarmupCaps(linha.warmup_daily_caps);
  return {
    throttleMs: linha.throttle_ms ?? PACING_DEFAULTS.throttleMs,
    jitterMaxMs: linha.jitter_max_ms ?? PACING_DEFAULTS.jitterMaxMs,
    windowStartHour: linha.window_start_hour ?? PACING_DEFAULTS.windowStartHour,
    windowEndHour: linha.window_end_hour ?? PACING_DEFAULTS.windowEndHour,
    allowSunday: linha.allow_sunday ?? PACING_DEFAULTS.allowSunday,
    timezone: fusoDaJanela(linha.timezone, fusoDaOrg),
    warmupDailyCaps: caps ?? PACING_DEFAULTS.warmupDailyCaps,
  };
}

/**
 * `null` = pode enviar agora. Caso contrário, o ISO da próxima abertura — que é
 * o que o motor devolve como `retry_at` para adiar o EVENTO inteiro.
 */
export async function adiarAteAJanelaAbrir(
  admin: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
  agora: Date = new Date(),
): Promise<string | null> {
  const knobs = await knobsDoCanal(admin, organizationId, channelSessionId);
  if (janelaDeEnvioAberta(agora, knobs)) return null;
  return proximaAberturaDaJanela(agora, knobs).toISOString();
}
