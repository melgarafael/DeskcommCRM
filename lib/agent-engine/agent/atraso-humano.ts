/**
 * O TEMPO QUE UMA PESSOA LEVA PARA RESPONDER — e por que ele é feature.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * O agente responde no instante em que o modelo termina de gerar. Do lado do
 * cliente, no WhatsApp, isso é inconfundível: a resposta chega junto com o "✓✓"
 * da mensagem que ele acabou de mandar. Nenhum atendente humano lê, pensa e
 * digita um parágrafo em 200ms — e o cliente sabe disso. Reportado pelo dono de
 * um tenant real (sítio de eventos): "responde rápido demais, parece robô".
 *
 * O produto é um agente que ATENDE junto com humanos. Ser identificável como
 * máquina na primeira troca é perda de conversão, não detalhe estético.
 *
 * ─── A fórmula, e por que estes números ─────────────────────────────────────
 *
 *   alvo   = clamp(NOTAR + POR_CARACTERE × comprimento, MINIMO, MAXIMO)
 *   espera = max(0, alvo - tempo que o turno JÁ gastou processando)
 *
 * O desconto existe porque o alvo mede o que o CLIENTE espera, não o que o
 * processo dorme. Quando o turno levou mais tempo do que o alvo para pensar, o
 * silêncio humano já foi pago com folga — dormir de novo por cima é atraso
 * puro. O throttle ENTRE bolhas (anti-banimento) é outro mecanismo e segue
 * intocado: quem o aplica é a cadeia `before_send`, não esta função.
 *
 * `NOTAR` (900ms) é a parcela que NÃO depende do texto: ver a notificação,
 * abrir a conversa, ler o que o cliente escreveu. Ela existe separada do termo
 * proporcional porque mesmo um "Sim!" tem esse custo — sem ela, respostas
 * curtas voltariam a sair instantâneas, que é exatamente o defeito.
 *
 * `POR_CARACTERE` (22ms ≈ 45 caracteres/s) é digitação DELIBERADAMENTE mais
 * rápida que a real (um bom digitador faz ~8 c/s no celular). Não é erro de
 * calibração: em velocidade real, um parágrafo de 400 caracteres pediria 50
 * segundos, e um cliente esperando 50s conclui que ninguém vai responder.
 * O objetivo é "não é instantâneo", não "é indistinguível de humano" — a
 * segunda meta custa o atendimento.
 *
 * `MINIMO` (1200ms) é o piso do throttle anti-ban do canal (CLAUDE.md: 1 msg /
 * 1.2s). Um atraso "humano" menor que o piso que o anti-ban já impõe seria
 * decoração que não muda nada. `MAXIMO` (7500ms) é o teto: acima disso o
 * silêncio deixa de ler como "está digitando" e passa a ler como "caiu".
 *
 * ─── Onde ele NÃO entra ─────────────────────────────────────────────────────
 *
 * Este atraso é do TURNO, antes da PRIMEIRA bolha. O intervalo ENTRE bolhas
 * continua sendo o jitter anti-ban (1.2s + ≤800ms) que já existia — são coisas
 * diferentes com donos diferentes, e somá-las numa só apagaria o throttle que
 * protege o número de banimento.
 */
import type { Logger } from '../obs/logger';

/** Ver o cabeçalho: a parcela que não depende do tamanho do texto. */
export const ATRASO_NOTAR_MS = 900;

/** ≈45 caracteres/s — rápido de propósito; ver o cabeçalho. */
export const MS_POR_CARACTERE = 22;

/** Piso do throttle anti-ban do canal (CLAUDE.md). Abaixo dele o atraso não significa nada. */
export const ATRASO_MINIMO_MS = 1200;

/** Acima disto o silêncio lê como queda, não como digitação. */
export const ATRASO_MAXIMO_MS = 7500;

/**
 * Quanto esperar antes de mandar `texto`, em ms. Pura — é o que a torna
 * testável sem relógio e sem canal.
 */
export function calcularAtrasoHumano(texto: string): number {
  const comprimento = (texto ?? '').trim().length;
  const bruto = ATRASO_NOTAR_MS + MS_POR_CARACTERE * comprimento;
  return Math.min(ATRASO_MAXIMO_MS, Math.max(ATRASO_MINIMO_MS, bruto));
}

export interface EsperaHumanaArgs {
  /** O corpo que vai sair — é o tamanho DELE que dita a espera. */
  texto: string;
  /** Tempo já gasto neste turno. Não desconta o throttle ENTRE envios. */
  processamentoMs?: number;
  sleep: (ms: number) => Promise<void>;
  log: Logger;
  /**
   * Acende o "digitando…" no aparelho do cliente. OPCIONAL: canal que não sabe
   * sinalizar presença simplesmente espera, e o ganho principal (não responder
   * instantaneamente) continua valendo.
   */
  sinalizarDigitando?: () => Promise<void>;
}

/**
 * Acende o "digitando…" e espera. Devolve os ms esperados.
 *
 * ⚠️ A PRESENÇA FALHA MACIO, E ISSO NÃO É NEGOCIÁVEL. "digitando…" é decoração;
 * a mensagem é o produto. Transporte fora do ar, sessão que não está saudável ou
 * canal que não implementa presença viram uma linha de log e o envio segue — deixar
 * uma chamada decorativa derrubar entrega seria trocar o produto pelo enfeite.
 *
 * A ordem também é o produto: sinalizar DEPOIS de esperar entregaria ao cliente
 * os segundos de silêncio sem a explicação visual que os torna naturais.
 */
export async function esperarComoHumano(args: EsperaHumanaArgs): Promise<number> {
  const gasto = args.processamentoMs ?? 0;
  const ms = Math.max(
    0,
    calcularAtrasoHumano(args.texto) - (Number.isFinite(gasto) ? Math.max(0, gasto) : 0),
  );

  // O cliente já esperou o alvo: não acrescentar presença decorativa nem sleep.
  if (ms === 0) return 0;

  if (args.sinalizarDigitando !== undefined) {
    try {
      await args.sinalizarDigitando();
    } catch (err) {
      // Sem corpo de erro e sem texto da mensagem: `lib/logger.ts` proíbe
      // conteúdo de conversa no log, e a resposta do canal pode carregá-lo.
      args.log.warn('não consegui sinalizar "digitando" (segue o envio)', {
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  await args.sleep(ms);
  return ms;
}

/**
 * Acende o "digitando…" SEM esperar a resposta do canal — para o início do turno,
 * antes da chamada ao modelo.
 *
 * Por que existe além de `esperarComoHumano`: aquela desconta do alvo o tempo que
 * o turno já gastou, e o modelo quase sempre gasta mais que o alvo (medido numa
 * instalação real: 7s de LLM contra ~2s de alvo, `atraso_ms: 0`). Espera zero é
 * retorno antes da presença — e o indicador nunca acendia justamente nos segundos
 * em que o cliente está esperando. Acender aqui cobre esses segundos.
 *
 * Não espera o transporte: uma ida à rede a mais antes do modelo seria latência
 * paga pelo cliente por um enfeite. Falha vira warn, com a mesma disciplina de
 * `esperarComoHumano` (sem corpo de erro no log).
 */
export function acenderDigitando(sinalizarDigitando: () => Promise<void>, log: Logger): void {
  void sinalizarDigitando().catch((err: unknown) => {
    log.warn('não consegui sinalizar "digitando" (segue o turno)', {
      error: err instanceof Error ? err.name : 'unknown',
    });
  });
}
