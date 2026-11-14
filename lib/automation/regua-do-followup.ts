/**
 * A RÉGUA DA TELA PASSA A SER OBEDECIDA PELO MOTOR (#3603, fatia 4).
 *
 * A tela Configurações → Entrada e follow-up grava, por ETAPA,
 * `organizations.settings.followup_por_etapa[stage_id] = { ativa, prazo_horas,
 * mensagem }` (contrato em `lib/schemas/settings.ts`). Até esta fatia a chave era
 * escrita, exibida e ignorada: quem decidia follow-up de etapa parada era só
 * `automation_rules.trigger_config.dias`, e a régua da tela promete HORAS. Este
 * módulo é a única tradução entre os dois — puro de propósito, para a varredura
 * e o teste lerem a MESMA coisa.
 *
 * ─── PRECEDÊNCIA (a regra escrita no PR) ────────────────────────────────────
 *
 *   1. régua ATIVA na etapa do negócio → `prazo_horas` SUBSTITUI os `dias` da
 *      regra. Para menos (6 h em vez de 7 dias) e para MAIS (30 dias numa regra
 *      de 1 dia) — é prazo, não é encurtamento. A `mensagem`, quando houver,
 *      viaja no payload do evento;
 *   2. régua INATIVA → `null`, e a varredura cai na regra como hoje;
 *   3. etapa SEM régua → `null`, comportamento de hoje byte a byte;
 *   4. `ativa: true` com `prazo_horas: null` é configuração INCOMPLETA (a action
 *      já a recusa na gravação, mas o jsonb é escrito por fora) → `null` com o
 *      motivo `prazo_incompleto`, para o motor cair na regra e o motivo aparecer
 *      em `pulados` em vez de a varredura inteira calar.
 *
 * ─── POR QUE A LEITURA NÃO TEM UMA SEGUNDA RÉGUA DE TOLERÂNCIA ──────────────
 *
 * `followupPorEtapaDeclarado` é o contrato que a TELA usa. Ler o mesmo jsonb por
 * outro caminho criaria duas verdades sobre o mesmo dado: um `prazo_horas`
 * gravado como texto viraria número aqui e `null` na tela (ou o contrário), e o
 * motor obedeceria um prazo que ninguém vê. O schema tem `.catch` por campo e
 * por objeto — nunca lança —, e é por isso que ele é a leitura daqui também.
 *
 * ⚠️ A chave é `stage_id`, que já identifica o funil (uma etapa pertence a UM
 * funil). O `pipelineId` entra no RETORNO porque é ele que o payload do evento
 * carrega junto: sem o funil, quem lê o `event_log` depois não sabe de que funil
 * era a etapa que governou o prazo.
 */
import { followupPorEtapaDeclarado, type FollowupDaEtapa } from "@/lib/schemas/settings";

/** Onde o negócio está AGORA — é a etapa dele que responde pela régua. */
export interface EtapaDoNegocio {
  pipelineId: string | null;
  stageId: string | null;
}

/** A régua que vale para uma etapa: o prazo em HORAS e o texto, se houver. */
export interface ReguaDoFollowup {
  prazoHoras: number;
  mensagem: string | null;
  /** A etapa que governou — volta para o payload do evento. */
  stageId: string;
  /** O funil daquela etapa, para o `event_log` dizer onde o prazo nasceu. */
  pipelineId: string | null;
}

/** Por que NÃO há régua. `prazo_incompleto` é o único que o motor conta. */
export type MotivoSemRegua = "sem_etapa" | "etapa_sem_regua" | "regua_inativa" | "prazo_incompleto";

export type LeituraDaRegua =
  | { regua: ReguaDoFollowup; motivo: null }
  | { regua: null; motivo: MotivoSemRegua };

function textoOuNulo(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** O mapa da chave, sem nunca lançar: jsonb torto vira mapa vazio. */
function mapaDaRegua(settings: unknown): Record<string, FollowupDaEtapa> {
  try {
    return followupPorEtapaDeclarado(settings);
  } catch {
    // `followupPorEtapaDeclarado` já tem `.catch` em todos os níveis; esta rede
    // existe porque a varredura roda para TODAS as organizações e uma exceção
    // aqui pararia as irmãs — o modo de falha mais caro desta rota.
    return {};
  }
}

/**
 * A régua da etapa do negócio, ou `null` com o motivo.
 *
 * `Object.hasOwn` e não `mapa[stageId]`: o mapa é jsonb de terceiros e um
 * `stage_id` chamado `constructor` (ou `__proto__`) não é etapa.
 */
export function reguaDoFollowup(settings: unknown, etapa: EtapaDoNegocio): LeituraDaRegua {
  const stageId = textoOuNulo(etapa.stageId);
  if (!stageId) return { regua: null, motivo: "sem_etapa" };

  const mapa = mapaDaRegua(settings);
  const declarada = Object.hasOwn(mapa, stageId) ? mapa[stageId] : undefined;
  if (!declarada) return { regua: null, motivo: "etapa_sem_regua" };
  if (!declarada.ativa) return { regua: null, motivo: "regua_inativa" };
  // O schema já devolve `null` para prazo fora de 1..720 — "ligada sem prazo" é
  // exatamente o estado que a action recusa e que o jsonb externo pode criar.
  if (declarada.prazo_horas === null) return { regua: null, motivo: "prazo_incompleto" };

  return {
    regua: {
      prazoHoras: declarada.prazo_horas,
      mensagem: textoOuNulo(declarada.mensagem),
      stageId,
      pipelineId: textoOuNulo(etapa.pipelineId),
    },
    motivo: null,
  };
}

/**
 * As réguas ATIVAS da organização, com prazo — para a varredura não cortar no
 * SQL antes de a régua mais curta vencer.
 *
 * O corte da etapa parada é `stage_changed_at <= agora - N` e precisa de um N
 * ÚNICO para a página inteira. Se o corte fosse só `dias`, um card com régua de
 * 6 h ficaria de fora por 7 dias (o SQL não o traria e nenhuma decisão em
 * memória o salvaria). O menor prazo ativo é o corte seguro: ele nunca perde
 * candidato, e quem decide por etapa continua sendo `reguaDoFollowup`.
 */
export function prazosAtivosDasEtapas(
  settings: unknown,
): Array<{ stageId: string; prazoHoras: number }> {
  const mapa = mapaDaRegua(settings);
  const prazos: Array<{ stageId: string; prazoHoras: number }> = [];
  for (const [stageId, entrada] of Object.entries(mapa)) {
    if (!entrada.ativa || entrada.prazo_horas === null) continue;
    prazos.push({ stageId, prazoHoras: entrada.prazo_horas });
  }
  return prazos;
}
