/**
 * PARADA DO LAÇO DEPOIS DO ENVIO FINAL DECLARADO (knob AGENT_STOP_AFTER_FINAL_SEND).
 *
 * Hoje, depois do último `send_message`, o laço chama o modelo mais uma vez só
 * para ele dizer "terminei" — um passo inteiro (~21,6 mil tokens no turno medido
 * em outubro) que não produz fato nenhum. Com o knob em `on`, o `send_message`
 * do `inbound_turn` ganha o parâmetro `encerra_turno`, e o laço para depois do
 * passo em que TODAS as condições abaixo valem:
 *
 *   1. o passo teve só `send_message`;
 *   2. todos os envios voltaram aceitos (`enviada`/`aceita_aguardando_canal`),
 *      sem `aviso` — veto, recusa, bolha que falhou ou foto que faltou voltam
 *      ao modelo como sempre;
 *   3. o modelo marcou ao menos um deles com `encerra_turno: true`;
 *   4. A TRAVA: nenhum corpo enviado NO TURNO (qualquer passo, não só o
 *      último) anuncia uma ação que ainda falta. A marca é palpite do modelo;
 *      a trava não depende dela.
 *
 * A trava reaproveita os detectores da cadeia `before_send`, sem copiá-los —
 * afrouxar um deles afrouxa os dois lados, e é de propósito. A liberação segue a
 * regra do `casePromiseGate` (before-send.ts): promessa de HUMANO só é cumprida
 * por passagem com `ok` ou caso aberto; promessa de RETORNO, também por
 * follow-up agendado. Diferente do gate, ela vale com `cases_enabled=false`, que
 * é o padrão do clone — é nesse cenário que "vou chamar alguém da equipe" passa
 * pela cadeia, e a ordem que o produto prescreve é avisar ANTES e só então
 * chamar `request_human_handoff`.
 *
 * O sucesso da passagem é lido do RESULTADO em `steps`, não de
 * `passouParaAEquipe`: aquela flag liga antes do resultado e continua `true`
 * quando o payload é recusado. Caso aberto e follow-up chegam por leitor do
 * closure do turno porque as flags só ligam em sucesso.
 */
import type { StopCondition, ToolSet } from 'ai';
import { z } from 'zod';

import { anunciaVerificacaoDeAgenda } from '../guardrails/before-send';
import { detectHumanPromise } from '../guardrails/human-promise';
import { detectarPromessaDeRetornoDoAssistente } from '../guardrails/retorno-do-assistente';

/** `off` = hoje, byte a byte; `observe` = só expõe e registra a marca; `on` = para. */
export type ModoDaParada = 'off' | 'observe' | 'on';

/**
 * O campo acrescentado ao schema do `send_message` com o knob ≠ off, e só no
 * `inbound_turn` de produção. `AGENT_TOOL_DEFS` não muda: com `off` o prefixo é
 * o de sempre.
 */
export const CAMPO_ENCERRA_TURNO = {
  encerra_turno: z
    .boolean()
    .optional()
    .describe(
      'true SÓ se esta é sua última ação neste turno. Se depois dela você ainda vai chamar ' +
        'qualquer ferramenta (outra mensagem, passar para a equipe, agendar retorno, registrar ' +
        'nota, etiqueta ou estágio), não marque. Marcar não dispensa nenhuma dessas ações.',
    ),
};

/** `simulated` (prévia) fica fora: a prévia nunca para. */
const ENVIO_ACEITO: ReadonlySet<string> = new Set(['enviada', 'aceita_aguardando_canal']);

function campo(valor: unknown, chave: string): unknown {
  if (typeof valor !== 'object' || valor === null) return undefined;
  return (valor as Record<string, unknown>)[chave];
}

function texto(valor: unknown): string {
  return typeof valor === 'string' ? valor : '';
}

/**
 * True quando o corpo anuncia uma ação que ainda não aconteceu neste turno —
 * aí o laço NÃO para, qualquer que seja a marca. Agenda ("vou verificar os
 * horários e já te aviso") nunca é liberada: a ação anunciada é do próprio laço.
 */
export function envioAnunciaAcaoSeguinte(
  body: string,
  handoffKeywords: readonly string[],
  feito: { humanoAcionado: boolean; retornoGarantido: boolean },
): boolean {
  return (
    anunciaVerificacaoDeAgenda(body) ||
    (!feito.humanoAcionado && detectHumanPromise(body, handoffKeywords)) ||
    (!feito.retornoGarantido && detectarPromessaDeRetornoDoAssistente(body))
  );
}

export function criarParadaAposEnvioFinal(opcoes: {
  handoffKeywords: readonly string[];
  casoAbertoNesteTurno: () => boolean;
  retornoAgendadoNesteTurno: () => boolean;
}): StopCondition<ToolSet> {
  return ({ steps }) => {
    const passo = steps.at(-1);
    if (passo === undefined || passo.toolCalls.length === 0) return false;
    // Chamada que lançou ou com argumento inválido não tem resultado: não é envio aceito.
    if (passo.toolResults.length !== passo.toolCalls.length) return false;
    if (!passo.toolCalls.every((c) => c.toolName === 'send_message')) return false;
    const todosAceitos = passo.toolResults.every(
      (r) =>
        campo(r.output, 'ok') === true &&
        ENVIO_ACEITO.has(texto(campo(r.output, 'status'))) &&
        campo(r.output, 'aviso') === undefined,
    );
    if (!todosAceitos) return false;
    if (!passo.toolResults.some((r) => campo(r.input, 'encerra_turno') === true)) return false;

    const humanoAcionado =
      opcoes.casoAbertoNesteTurno() ||
      steps.some((s) =>
        s.toolResults.some(
          (r) => r.toolName === 'request_human_handoff' && campo(r.output, 'ok') === true,
        ),
      );
    const retornoGarantido = humanoAcionado || opcoes.retornoAgendadoNesteTurno();
    // A trava olha TODO envio que saiu no turno, não só o do último passo: o
    // modelo manda 2-4 mensagens seguidas, e a promessa feita no passo 1 sem
    // marca continua devendo a ação quando o passo 2 marca um corpo neutro.
    return !steps.some((s) =>
      s.toolResults.some(
        (r) =>
          r.toolName === 'send_message' &&
          campo(r.output, 'ok') === true &&
          envioAnunciaAcaoSeguinte(texto(campo(r.input, 'body')), opcoes.handoffKeywords, {
            humanoAcionado,
            retornoGarantido,
          }),
      ),
    );
  };
}
