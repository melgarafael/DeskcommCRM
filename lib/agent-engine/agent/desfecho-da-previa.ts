/**
 * DESFECHO DA PRÉVIA — por que a "Sugerir resposta" terminou sem candidato.
 *
 * ## O defeito (issue #3093)
 *
 * `avisarSemCandidato` (`inbound-turn.ts`) gravava o MESMO código,
 * `no_candidate`, para causas que não têm nada em comum: a DECISÃO de não
 * responder (a saudação automática do WhatsApp Business de quem foi abordado, o
 * caso do #3092) e a PARADA da geração no meio (saída cortada no teto de tokens,
 * texto escrito fora do `send_message`, teto de passos esgotado). O painel não
 * podia dizer ao atendente se o agente decidiu não responder ou se a geração
 * falhou — e uma decisão correta aparecia como defeito.
 *
 * ## O que decide, e com que nomes
 *
 * Os nomes espelham os do turno REAL, não um vocabulário paralelo:
 *
 * - `output_truncated` — o mesmo nome do log de `inbound-turn.ts` quando
 *   `finish_reason = 'length'`; em produção a falha é terminal visível
 *   (`output_truncated_recovered_failed`), aqui é o desfecho do rascunho.
 * - `max_steps_exhausted` — o teto de passos é a configuração `max_steps` do
 *   agente ("Ações por atendimento"): o modelo gastou o orçamento em consultas e
 *   parou no `tool-calls` do último passo, sem chegar a responder.
 * - `no_candidate` — o que sobra depois da separação, e agora significa uma
 *   coisa só: o agente DECIDIU não responder. É o desfecho do silêncio
 *   deliberado que o `CORRECAO_DO_TURNO_MUDO` autoriza (#2938) e o do caso 2 da
 *   issue (proposta registrada, nenhuma resposta) — a decisão de agir sem
 *   escrever.
 *
 * O TEXTO SOLTO não ganha código próprio: ele passa pela MESMA correção do turno
 * mudo que a produção já pede (uma segunda chamada com `CORRECAO_DO_TURNO_MUDO`),
 * também na prévia do rascunho. Se depois dela ainda não houver candidato, o que
 * resta é decisão — que é exatamente a doutrina do #2938.
 *
 * Vive fora do `inbound-turn.ts` porque é decisão PURA: entram sinais, sai um
 * código. O mesmo motivo de `sugestao-de-resposta.ts` — uma regra que só existe
 * dentro do closure de um turno de 5.800 linhas não tem como ser testada
 * sozinha, e foi assim que as causas se misturaram sem ninguém ver.
 */

/** O impedimento que a prévia grava — mesma forma dos demais (`preview.ts`). */
export interface ImpedimentoDaPrevia {
  readonly code: string;
  readonly message: string;
}

/** Os sinais que o fim da prévia precisa olhar, todos já medidos no turno. */
export interface SinaisDaPrevia {
  /** Quantas respostas foram ACEITAS pela cadeia neste turno. */
  readonly candidatos: number;
  /** Quantos impedimentos a cadeia já registrou (veto, mídia, ferramenta). */
  readonly impedimentos: number;
  /** `finish_reason = 'length'`: o modelo cortou no teto de tokens de saída. */
  readonly saidaTruncada: boolean;
  /** `max_steps` esgotado no laço de ferramentas, sem resposta proposta. */
  readonly tetoDePassosAtingido: boolean;
}

/**
 * O teto de passos foi o que parou o turno?
 *
 * O SDK para o laço por `stepCountIs(maxSteps)`; quando o orçamento acaba no
 * meio de um passo de ferramenta, o `finishReason` do resultado é `'tool-calls'`
 * — o modelo chamou uma ferramenta e nunca chegou a escrever. Um turno que usa
 * todos os passos e TERMINA em texto encerrou por decisão (`'stop'`) e não é
 * teto esgotado.
 */
export function tetoDePassosAtingido(p: {
  readonly passosUsados: number;
  readonly maxSteps: number;
  readonly finishReason: string | null | undefined;
}): boolean {
  return (
    p.maxSteps > 0 && p.passosUsados >= p.maxSteps && p.finishReason === 'tool-calls'
  );
}

/**
 * A prévia do RASCUNHO pede a correção do turno mudo?
 *
 * Mesma situação do turno real (`turno-mudo.ts`): o modelo escreveu TEXTO e
 * encerrou sem nenhum `send_message` — o que ele escreveu não chega a ninguém.
 * A condição é ESTREITA de propósito: só quando há texto solto a corrigir. O
 * silêncio sem texto nenhum é a decisão que o modelo já tomou, e pedir de novo
 * só pagaria uma chamada de modelo para ouvir a mesma coisa (#2938).
 */
export function previaPedeCorrecaoDoTurnoMudo(p: {
  readonly textoEscrito: string;
  readonly candidatos: number;
  readonly tentativasDeEnvio: number;
}): boolean {
  return (
    p.candidatos === 0 && p.tentativasDeEnvio === 0 && p.textoEscrito.trim() !== ''
  );
}

/**
 * Por que a prévia terminou sem candidato — `null` quando não terminou sem
 * candidato (há resposta aceita) ou quando já existe um impedimento que explica
 * o desfecho (um veto, mídia que não preparou, ferramenta desconhecida).
 *
 * A ordem não é estética: truncamento é a FALHA mais específica e vem primeiro;
 * o teto de passos vem em seguida; e `no_candidate` fica com o que sobra, que
 * agora é só a decisão de não responder.
 */
export function desfechoSemCandidato(s: SinaisDaPrevia): ImpedimentoDaPrevia | null {
  if (s.candidatos > 0 || s.impedimentos > 0) return null;
  if (s.saidaTruncada)
    return {
      code: 'output_truncated',
      message:
        'A geração da sugestão foi cortada no limite de tamanho da resposta e parou antes de propor ' +
        'algo. Nada foi enviado ao cliente. Gere de novo; se repetir, reduza o que o agente precisa ' +
        'escrever de uma vez ou aumente o teto de tokens de saída do provedor.',
    };
  if (s.tetoDePassosAtingido)
    return {
      code: 'max_steps_exhausted',
      message:
        'O agente gastou o teto de passos da configuração em consultas e terminou sem propor uma ' +
        'resposta. Nada foi enviado. Gere de novo; se repetir, aumente "Ações por atendimento" no ' +
        'agente ou reduza o que ele precisa consultar antes de responder.',
    };
  return {
    code: 'no_candidate',
    message:
      'O agente decidiu não responder: terminou sem propor uma resposta e sem nenhum impedimento no ' +
      'caminho.',
  };
}
