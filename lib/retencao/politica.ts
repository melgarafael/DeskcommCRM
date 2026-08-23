/**
 * A política de retenção — regra PURA, sem banco e sem env, para a poda da fila
 * e o expurgo da auditoria (issue #261).
 *
 * ─── Por que um módulo, e não `z.coerce.number()` em `lib/env.ts` ───────────
 *
 * `lib/env.ts` LANÇA quando o schema recusa, e no Next isso acontece na primeira
 * requisição — com healthcheck TCP puro, o contêiner fica `healthy` com 100% das
 * respostas em 500. É a mesma armadilha documentada em `AI_BUDGET_ENFORCEMENT`:
 * um `z.coerce.number().int().positive()` aqui transformaria
 * `JOB_QUEUE_RETENTION_DAYS=noventa` — digitado às 2h por quem está tentando
 * liberar espaço — no derrubador do produto inteiro. As duas chaves entram como
 * `z.string()` e são interpretadas AQUI, onde lixo resolve para o lado seguro.
 *
 * ─── O piso não é sugestão ──────────────────────────────────────────────────
 *
 * Este módulo devolve o número que o CHAMADOR pede ao banco; o piso de verdade
 * mora dentro de `fn_podar_fila_de_jobs` e `fn_expurgar_auditoria_vencida`
 * (`greatest(..., piso)`), porque só lá ele vale para QUALQUER chamador —
 * inclusive um `psql` na mão. Repeti-lo aqui serve para outra coisa: para o
 * operador ver no log que o valor dele foi elevado, em vez de descobrir pela
 * ausência de efeito. Os dois lados usam as mesmas constantes deste arquivo, e
 * `tests/invariants/retencao-poda-e-expurgo.test.ts` compara os dois.
 */

/** 90 dias. Longe o bastante do horizonte em que "1º outbound" ainda diz algo. */
export const RETENCAO_FILA_DIAS_PADRAO = 90;
/** Piso da fila: abaixo disso a cascata em `send_ledger` alcança lead vivo. */
export const RETENCAO_FILA_DIAS_PISO = 7;
/** 1825 dias = os 5 anos da regra L-10 (`docs/business-rules`, L-10). */
export const RETENCAO_AUDITORIA_DIAS_PADRAO = 1825;
/** Piso da auditoria: o knob nunca vira apagador de rastro recente. */
export const RETENCAO_AUDITORIA_DIAS_PISO = 90;
/**
 * `event_log` é o mesmo tipo de dado que `job_queue` — bus interno operacional,
 * não trilha legal/LGPD (isso é `api_audit_log`) — por isso herda os MESMOS
 * números, não os da auditoria. Knob próprio (não o de `job_queue`) porque as
 * duas tabelas crescem em ritmos diferentes: um clone com muito tráfego de
 * WhatsApp gera `event_log` (um evento por mensagem, `message.*`) muito mais
 * rápido que `job_queue` (um job por turno de conversa).
 */
export const RETENCAO_EVENT_LOG_DIAS_PADRAO = 90;
/**
 * Piso de 7 dias — mesmo horizonte da `job_queue` (migration 0167): o único
 * consumidor de `event_log` sem janela própria é `health/circuit.ts`, que já é
 * janelado (`windowMs`, default 6h — muito abaixo de 7 dias) e lê exatamente os
 * eventos `ai_agent.dispatch_requested` que este expurgo também alcança.
 */
export const RETENCAO_EVENT_LOG_DIAS_PISO = 7;

export interface RetencaoInterpretada {
  /** Dias a pedir ao banco. Nunca abaixo do piso, nunca `NaN`. */
  readonly dias: number;
  /**
   * Frase pronta em pt-BR quando o valor do operador NÃO foi usado como escrito.
   * `null` quando a chave está ausente (o caso normal) ou foi aceita inteira.
   * Nunca a frase tranquilizadora: se o número dele não valeu, o log diz.
   */
  readonly aviso: string | null;
}

/**
 * Interpreta o valor cru de uma variável de ambiente de retenção.
 *
 * Ausente ou vazio → o padrão, sem aviso (é o caminho de toda instalação que
 * nunca editou `.env`, e a doutrina de packaging exige que ele funcione).
 * Não-numérico, zero ou negativo → o padrão, COM aviso.
 * Abaixo do piso → o piso, COM aviso.
 */
export function interpretarRetencao(
  bruto: string | undefined,
  opcoes: { readonly chave: string; readonly padrao: number; readonly piso: number },
): RetencaoInterpretada {
  const texto = (bruto ?? "").trim();
  if (texto === "") return { dias: opcoes.padrao, aviso: null };

  // `Number()` e não `parseInt`: `parseInt("90dias")` devolve 90 em silêncio, e
  // aceitar sufixo faria `JOB_QUEUE_RETENTION_DAYS=90d` virar 90 sem o operador
  // saber que o `d` foi ignorado. Aqui ele é lixo, e lixo tem aviso.
  const numero = Number(texto);
  if (!Number.isFinite(numero) || !Number.isInteger(numero) || numero <= 0) {
    return {
      dias: opcoes.padrao,
      aviso:
        `${opcoes.chave}="${texto}" não é um número inteiro de dias — ` +
        `usando o padrão de ${opcoes.padrao} dias.`,
    };
  }

  if (numero < opcoes.piso) {
    return {
      dias: opcoes.piso,
      aviso:
        `${opcoes.chave}=${numero} está abaixo do piso de ${opcoes.piso} dias — ` +
        `usando ${opcoes.piso}. O piso também é aplicado dentro da função do banco.`,
    };
  }

  return { dias: numero, aviso: null };
}
