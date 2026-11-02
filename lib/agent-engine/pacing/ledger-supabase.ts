/**
 * O `pacing_ledger` LIDO PELO LADO DO CRM — a ponte mínima, não uma segunda régua.
 *
 * ## Por que existe
 *
 * `loadPacingState`/`recordSend` (`./store.ts`) falam `pg.Pool`, porque o motor
 * do agente tem pool próprio. O consumidor do `event_log` roda dentro do Next e
 * fala Supabase. A MESMA tabela, o MESMO significado, outro client — é
 * exatamente o precedente declarado em `lib/automation/janela-do-canal.ts`:
 * *"a REGRA é importada de lá, pura; só a leitura da linha é reescrita"*.
 *
 * **O que NÃO pode existir é uma segunda REGRA.** `warmupCapFor` e
 * `dayStartInTz` vêm de `./engine`; os números (`throttleMs`, `jitterMaxMs`,
 * `warmupDailyCaps`) vêm de `knobsDoCanal`, que já lê `channel_knobs` pelo
 * mesmo client.
 *
 * ## ⚠️ A JANELA DE HORÁRIO NÃO ENTRA AQUI, e é decisão do dono
 *
 * `decidePacing` (`./engine`) junta três coisas: janela horária, warm-up/teto e
 * espaçamento. Para o AVISO INTERNO só as duas últimas valem — a janela protege
 * o CLIENTE de receber mensagem fora de hora, e a equipe de suporte é interna e
 * pediu para ser avisada na hora. Usar `decidePacing` inteiro aqui represaria
 * até as 7h o aviso de um caso aberto às 23h, que é justamente o que mais
 * precisa chegar.
 *
 * O que se mantém é o que protege o NÚMERO: espaçamento e teto diário de
 * warm-up. Um número banido leva junto o atendimento de todos os clientes
 * daquela organização — e o aviso gasta uma mensagem como qualquer outra.
 *
 * ## Falha de gravação é ABERTA
 *
 * Quem chama `registrarEnvioNoLedger` já mandou a mensagem. Não contar é pior
 * que não avisar; derrubar o chamador DEPOIS do envio produziria aviso em
 * dobro. Por isso o erro vira log e a função retorna.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { knobsDoCanal } from "@/lib/automation/janela-do-canal";
import { logger } from "@/lib/logger";

import { dayStartInTz, warmupCapFor } from "./engine";

/** O que o ledger responde sobre este número. */
export interface EstadoDoPacing {
  /** Último envio deste número, em qualquer dia — a base do espaçamento. */
  lastSentAt: Date | null;
  /** Envios deste número desde a meia-noite LOCAL do tenant. */
  sentToday: number;
  /** `channel_knobs.number_activated_at`; `null` = idade 0 (o degrau mais conservador). */
  numberActivatedAt: Date | null;
}

export type DecisaoDeEspacamento =
  | { liberado: true }
  | { liberado: false; motivo: "espacamento" | "teto_diario"; liberaEm: Date };

/**
 * Lê `pacing_ledger` pelo PostgREST.
 *
 * Duas consultas e não uma agregação: o PostgREST não expõe `max()` junto de um
 * `count(*) filter (...)` numa chamada só sem uma view, e uma view nova seria
 * schema novo para responder o que duas leituras baratas já respondem. A
 * primeira traz a última linha (ordenada, limite 1); a segunda conta as do dia
 * local com `head: true`, que não transfere linha nenhuma.
 */
export async function lerEstadoDoPacing(
  admin: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
  entrada: { agora: Date; timezone: string },
): Promise<EstadoDoPacing> {
  const inicioDoDia = dayStartInTz(entrada.agora, entrada.timezone);

  const ultimo = await admin
    .from("pacing_ledger")
    .select("sent_at")
    .eq("organization_id", organizationId)
    .eq("channel_session_id", channelSessionId)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const doDia = await admin
    .from("pacing_ledger")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("channel_session_id", channelSessionId)
    .eq("resposta", false)
    .gte("sent_at", inicioDoDia.toISOString());

  const knobs = await admin
    .from("channel_knobs")
    .select("number_activated_at")
    .eq("organization_id", organizationId)
    .eq("channel_session_id", channelSessionId)
    .maybeSingle();

  // Falha ABERTA na ação e NOMEADA no log: uma leitura que falha não pode calar
  // o aviso, mas também não pode sumir. O desfecho sem dado é o CONSERVADOR —
  // `sentToday: 0` liberaria o envio, e é por isso que o erro entra no log em
  // vez de virar silêncio.
  for (const [qual, erro] of [
    ["ultimo envio", ultimo.error],
    ["contagem do dia", doDia.error],
    ["knobs do numero", knobs.error],
  ] as const) {
    if (erro) {
      logger.warn("[pacing] leitura do ledger falhou — seguindo com o que foi lido", {
        organizationId,
        channelSessionId,
        qual,
        causa: erro.message,
      });
    }
  }

  const sentAt = (ultimo.data as { sent_at?: string } | null)?.sent_at ?? null;
  const ativado = (knobs.data as { number_activated_at?: string | null } | null)
    ?.number_activated_at;

  return {
    lastSentAt: sentAt ? new Date(sentAt) : null,
    sentToday: doDia.count ?? 0,
    numberActivatedAt: ativado ? new Date(ativado) : null,
  };
}

/**
 * Registra um envio efetivado. **Nunca lança** — ver o cabeçalho.
 *
 * O escritor "oficial" continua sendo `recordSend` (`./store.ts`): o que não
 * pode existir é uma segunda REGRA, e a regra desta tabela é "uma linha por
 * mensagem que saiu". A forma da linha é a mesma.
 */
export async function registrarEnvioNoLedger(
  admin: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
  quando: Date = new Date(),
): Promise<void> {
  const { error } = await admin.from("pacing_ledger").insert({
    organization_id: organizationId,
    channel_session_id: channelSessionId,
    sent_at: quando.toISOString(),
  });
  if (error) {
    logger.warn("[pacing] envio não contabilizado no ledger", {
      organizationId,
      channelSessionId,
      causa: error.message,
    });
  }
}

/**
 * A decisão PURA: dá para mandar agora, e se não dá, quando dá?
 *
 * Só as duas regras que protegem o NÚMERO. A ordem importa: o teto diário é
 * checado antes do espaçamento porque ele adia por horas e o outro por
 * segundos — perguntar na ordem inversa devolveria "espere 1,2 s" a um número
 * que só volta a enviar amanhã.
 */
export function decidirEspacamento(entrada: {
  agora: Date;
  estado: EstadoDoPacing;
  throttleMs: number;
  jitterMaxMs: number;
  timezone: string;
  warmupDailyCaps: Parameters<typeof warmupCapFor>[1];
  /** `channel_sessions.daily_message_limit` — a fonte única do teto ABSOLUTO. */
  crmDailyLimit: number | null;
  rng?: () => number;
}): DecisaoDeEspacamento {
  const { agora, estado } = entrada;
  const rng = entrada.rng ?? Math.random;

  // Idade do número em dias. `Math.max(0, …)` porque `number_activated_at` no
  // futuro (typo do admin, relógio torto) tem de cair no degrau MAIS
  // conservador — o warm-up falha fechado, nunca aberto.
  const idadeDias = estado.numberActivatedAt
    ? Math.max(0, (agora.getTime() - estado.numberActivatedAt.getTime()) / 86_400_000)
    : 0;
  const capDoWarmup = warmupCapFor(idadeDias, entrada.warmupDailyCaps);
  const caps = [capDoWarmup, entrada.crmDailyLimit].filter(
    (c): c is number => typeof c === "number" && Number.isFinite(c),
  );
  const cap = caps.length > 0 ? Math.min(...caps) : null;

  if (cap !== null && estado.sentToday >= cap) {
    // O contador zera na meia-noite LOCAL do tenant — é exatamente esse o
    // instante em que este número volta a poder enviar. Um `+24h` cru daria uma
    // hora arbitrária e faria o aviso sair no meio da madrugada seguinte.
    const amanha = dayStartInTz(new Date(agora.getTime() + 86_400_000), entrada.timezone);
    return { liberado: false, motivo: "teto_diario", liberaEm: amanha };
  }

  if (estado.lastSentAt) {
    // O jitter existe porque intervalo fixo é assinatura de robô — e é o padrão
    // que faz um número ser banido.
    const espera = entrada.throttleMs + Math.floor(rng() * Math.max(0, entrada.jitterMaxMs));
    const liberaEm = new Date(estado.lastSentAt.getTime() + espera);
    if (liberaEm.getTime() > agora.getTime()) {
      return { liberado: false, motivo: "espacamento", liberaEm };
    }
  }

  return { liberado: true };
}

/**
 * O adapter pronto: lê os knobs, lê o ledger, decide.
 *
 * Existe para o chamador não ter de saber a ordem das três leituras — e para a
 * REGRA (`decidirEspacamento`) continuar testável sem banco nenhum.
 */
export async function criarPacingDoCanal(admin: SupabaseClient) {
  return {
    async decide(organizationId: string, channelSessionId: string, agora: Date) {
      const knobs = await knobsDoCanal(admin, organizationId, channelSessionId);
      const estado = await lerEstadoDoPacing(admin, organizationId, channelSessionId, {
        agora,
        timezone: knobs.timezone,
      });
      const { data } = await admin
        .from("channel_sessions")
        .select("daily_message_limit")
        .eq("organization_id", organizationId)
        .eq("id", channelSessionId)
        .maybeSingle();
      return decidirEspacamento({
        agora,
        estado,
        throttleMs: knobs.throttleMs,
        jitterMaxMs: knobs.jitterMaxMs,
        timezone: knobs.timezone,
        warmupDailyCaps: knobs.warmupDailyCaps,
        crmDailyLimit:
          (data as { daily_message_limit?: number | null } | null)?.daily_message_limit ?? null,
      });
    },
    async registraEnvio(organizationId: string, channelSessionId: string, quando: Date) {
      await registrarEnvioNoLedger(admin, organizationId, channelSessionId, quando);
    },
  };
}
