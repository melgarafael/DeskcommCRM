/**
 * Os dois gatilhos por TEMPO (issue #1540): "N dias sem mensagem" e "N dias na
 * mesma etapa".
 *
 * ═══ POR QUE ESTES DOIS NÃO PARECEM COM OS OUTROS GATILHOS ═══
 *
 * Todos os gatilhos event-driven nascem de uma linha no `event_log`: a mensagem
 * chega, a etapa muda, a tag é posta. Silêncio e etapa parada são o contrário —
 * são AUSÊNCIA de coisa por um período, e ausência não gera evento. Quem os
 * transforma em acontecimento é o relógio: a varredura
 * `app/api/v1/cron/lead-time-triggers`, no mesmo modelo da
 * `lead-date-field-due` (regras primeiro, organização depois, trava no
 * `event_log`).
 *
 * ═══ A ÂNCORA É O QUE FAZ O REARME EXISTIR ═══
 *
 * A trava de disparo é `regra:negócio:ÂNCORA`, e não `regra:negócio` — é a
 * diferença entre "dispara uma vez para sempre" (o defeito corrigido do
 * `lead.date_field_due`) e "dispara uma vez POR EPISÓDIO":
 *
 *   - silêncio: a âncora é o instante da última mensagem da direção escolhida
 *     (`conversations.last_*_at`), ou o nascimento do negócio quando nunca houve
 *     mensagem. Chegou mensagem nova, a âncora mudou, a trava não casa mais — e
 *     o relógio só volta a zerar N dias depois.
 *   - etapa parada: a âncora é `crm_leads.stage_changed_at` (migration 0071 —
 *     carimbada por trigger, preenchida com `created_at` no backfill). Card
 *     arrastado, âncora mudou, mesma regra reavaliada do zero.
 *
 * A mesma chave no `event_log` é também o que impede a segunda tarefa: a
 * varredura roda de hora em hora, o silêncio continua valendo por dias, e sem a
 * âncora na chave a regra emitiria um evento por rodada.
 *
 * Este módulo é PURO de propósito — não importa cliente de banco, env nem fuso.
 * O schema da API, o editor de regras (que roda no NAVEGADOR) e a varredura
 * leem a mesma configuração daqui.
 */

/** O nome do gatilho de silêncio no `event_log`, na regra e no rótulo da tela. */
export const GATILHO_SILENCIO = "lead.silent_for";

/** O nome do gatilho de etapa parada no `event_log`, na regra e no rótulo. */
export const GATILHO_ETAPA_PARADA = "lead.stage_stale";

/**
 * As três direções do silêncio, na pergunta que o operador faz: silêncio de
 * QUEM?
 *
 * `da_equipe` = a equipe não manda mensagem (última saída velha);
 * `do_cliente` = o cliente não responde (última entrada velha);
 * `qualquer` = ninguém falou (última mensagem de qualquer lado velha).
 */
export const DIRECOES_DO_SILENCIO = ["da_equipe", "do_cliente", "qualquer"] as const;
export type DirecaoDoSilencio = (typeof DIRECOES_DO_SILENCIO)[number];

/** Dez anos de silêncio é dedo no teclado, não regra. Abaixo de 1 dia é flood. */
export const DIAS_MIN = 1;
export const DIAS_MAX = 3650;

/** O que a regra guarda em `automation_rules.trigger_config` — silêncio. */
export interface ConfigDoSilencio {
  /** Dias sem mensagem na direção escolhida. */
  dias: number;
  direcao: DirecaoDoSilencio;
  /** Recorte de funil. `null` = todos os funis da organização. */
  pipeline_id: string | null;
  /**
   * Lead com compromisso futuro não gera lembrete (mesma proteção que as ações
   * de mensagem já aplicam — `lib/agenda/protecao-followup.ts`).
   */
  proteger_pela_agenda: boolean;
}

/** O que a regra guarda em `automation_rules.trigger_config` — etapa parada. */
export interface ConfigDaEtapaParada {
  /** Dias na MESMA etapa. */
  dias: number;
  pipeline_id: string | null;
  /** Recorte de etapa. `null` = qualquer etapa. */
  stage_id: string | null;
  proteger_pela_agenda: boolean;
}

function textoOuNulo(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function booleano(v: unknown, padrao = false): boolean {
  return typeof v === "boolean" ? v : padrao;
}

/**
 * Lê a configuração do gatilho como ela veio do banco (jsonb) ou da tela.
 *
 * Devolve `null` para linha malformada em vez de estourar: a varredura roda
 * para todas as organizações, e uma regra torta não pode derrubar as irmãs —
 * ela simplesmente não casa. É também o que o schema da API usa para recusar,
 * na criação, o que o operador mandaria errado.
 */
export function configDoSilencio(bruto: unknown): ConfigDoSilencio | null {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return null;
  const { dias, direcao, pipeline_id: pipelineId, proteger_pela_agenda: proteger } =
    bruto as Record<string, unknown>;
  if (!Number.isInteger(dias)) return null;
  const n = dias as number;
  if (n < DIAS_MIN || n > DIAS_MAX) return null;
  if (typeof direcao !== "string" || !(DIRECOES_DO_SILENCIO as readonly string[]).includes(direcao)) {
    return null;
  }
  return {
    dias: n,
    direcao: direcao as DirecaoDoSilencio,
    pipeline_id: textoOuNulo(pipelineId),
    proteger_pela_agenda: booleano(proteger),
  };
}

export function configDaEtapaParada(bruto: unknown): ConfigDaEtapaParada | null {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return null;
  const { dias, pipeline_id: pipelineId, stage_id: stageId, proteger_pela_agenda: proteger } =
    bruto as Record<string, unknown>;
  if (!Number.isInteger(dias)) return null;
  const n = dias as number;
  if (n < DIAS_MIN || n > DIAS_MAX) return null;
  return {
    dias: n,
    pipeline_id: textoOuNulo(pipelineId),
    stage_id: textoOuNulo(stageId),
    proteger_pela_agenda: booleano(proteger),
  };
}

/**
 * A coluna de `conversations` que responde pela direção escolhida.
 *
 * É a coluna, não um predicado: a varredura lê as três do mesmo jeito e o
 * recorte vira um nome de coluna no `select`, não uma consulta por direção.
 */
export function colunaDaDirecao(direcao: DirecaoDoSilencio): string {
  return direcao === "da_equipe"
    ? "last_outbound_at"
    : direcao === "do_cliente"
      ? "last_inbound_at"
      : "last_message_at";
}

/**
 * A âncora do silêncio, ou `null` quando ainda não se passaram N dias.
 *
 * `ultimaMensagem` é o maior `last_*_at` do contato nas conversas dele (pode
 * ser `null`: contato que nunca falou). `nascidoEm` é o nascimento do NEGÓCIO —
 * é a referência de um contato que nunca teve mensagem, senão uma regra de 7
 * dias dispararia para um lead criado ontem.
 *
 * Devolve o ISO da referência (a âncora da trava), porque é ela quem muda quando
 * a mensagem nova chega.
 */
export function ancoraDoSilencio(
  ultimaMensagem: string | null,
  nascidoEm: string,
  agora: Date,
  dias: number,
): string | null {
  const referencia = Date.parse(ultimaMensagem ?? "") || Date.parse(nascidoEm);
  if (Number.isNaN(referencia)) return null;
  if (agora.getTime() - referencia < dias * 86_400_000) return null;
  return new Date(referencia).toISOString();
}

/**
 * A âncora da etapa parada, ou `null` quando o negócio está na etapa há menos
 * de N dias. `stage_changed_at` nunca é nulo na prática (trigger da 0071 com
 * default e backfill), mas uma linha antiga sem carimbo não pode virar disparo
 * — devolve `null` e a regra espera o próximo carimbo.
 */
export function ancoraDaEtapa(
  stageChangedAt: string | null,
  agora: Date,
  dias: number,
): string | null {
  if (!stageChangedAt) return null;
  const entrada = Date.parse(stageChangedAt);
  if (Number.isNaN(entrada)) return null;
  if (agora.getTime() - entrada < dias * 86_400_000) return null;
  return new Date(entrada).toISOString();
}

/**
 * A chave do "já disparei": regra + negócio + ÂNCORA.
 *
 * Sem a âncora a mesma regra valeria para sempre para o mesmo negócio (o defeito
 * do `lead.date_field_due`); com ela, cada episódio de silêncio — e cada entrada
 * em etapa — é um disparo novo, e nenhum dos dois dispara duas vezes enquanto a
 * âncora não mudar.
 */
export function chaveDeDisparoTemporal(regraId: string, leadId: string, ancora: string): string {
  return `${regraId}:${leadId}:${ancora}`;
}

/**
 * Tira do lote quem já disparou ESTA regra com a MESMA âncora.
 *
 * Devolve os pares que ainda podem emitir, na ordem de entrada — quem já foi
 * emitido (mesma âncora) some; quem mudou de âncora volta a ser elegível.
 */
export function naoDisparadosTemporais(
  candidatos: ReadonlyArray<{ leadId: string; ancora: string }>,
  jaEmitidos: ReadonlySet<string>,
  regraId: string,
): Array<{ leadId: string; ancora: string }> {
  return candidatos.filter((c) => !jaEmitidos.has(chaveDeDisparoTemporal(regraId, c.leadId, c.ancora)));
}
