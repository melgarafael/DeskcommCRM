/**
 * O ENVIO RÁPIDO DE UMA CAMPANHA: a rodada manda em RAJADA (migration 0711).
 *
 * ═══ O que muda em relação ao gradual ═══
 *
 * O gradual manda UMA mensagem por número a cada rodada do cron — uma por
 * minuto. Na velocidade rápida, a mesma rodada manda o quanto couber no prazo
 * dela, várias por segundo, em lotes. Cada envio continua sendo o envio de
 * sempre (`rodarUmaCampanha` com o destinatário escolhido): os vetos por pessoa,
 * a lista de exclusão, a janela e os tetos da campanha, a reserva em
 * compare-and-set, o texto na conversa e o ack valem um por um.
 *
 * ═══ Por que estes números ═══
 *
 * O limite que manda é o do PROVEDOR, não o da plataforma: o parceiro aceita
 * 600 requisições por minuto por equipe (janela deslizante), e a plataforma
 * aceita ~80 mensagens por segundo por número. Seis inícios por segundo são 360
 * por minuto — 60% do teto do parceiro, deixando o resto para o agente
 * responder quem já está conversando e para a sincronização dos modelos. Quatro
 * envios em voo bastam: cada envio leva perto de um segundo (banco + provedor).
 *
 * O prazo é o da rodada: o agendador corta a chamada em 45 s, e a rajada para
 * de COMEÇAR envios aos 38 s — os que estão em voo terminam. O resto sai na
 * rodada seguinte, um minuto depois: 500 pessoas levam duas ou três rodadas.
 *
 * ═══ Quando a rajada para antes ═══
 *
 * No primeiro desfecho que vale para todos os envios seguintes: a campanha
 * pausou por falha da plataforma (`pausada:`), a janela fechou ou o teto da
 * campanha chegou (`ritmo:`), o número saiu do ar (`canal:`), o provedor pediu
 * para desacelerar (`limite:` — o destinatário volta para a fila) ou a reserva
 * deu erro de banco, ou a organização parou. Insistir nesses casos só repetiria o veto a cada envio.
 * Também para quando alguém pausa ou cancela a campanha pela tela: a pergunta é
 * refeita antes de cada lote.
 *
 * Os lotes são fechados (busca → envia todos → busca de novo) de propósito: um
 * destinatário só entra num lote depois de o anterior terminar, e nenhum é
 * escolhido duas vezes.
 */

export const RAJADA = {
  /** Envios em voo ao mesmo tempo. */
  concorrencia: 4,
  /** Intervalo mínimo entre INÍCIOS de envio: 6 por segundo, 360 por minuto. */
  intervaloEntreIniciosMs: 167,
  /** Destinatários buscados por vez. */
  tamanhoDoLote: 24,
  /** A rajada para de começar envios depois disto (o agendador corta em 45 s). */
  prazoMs: 38_000,
} as const;

export interface DesfechoDeUm {
  enviadas: number;
  pulados: number;
  concluidas: number;
  detalhe: string;
  /** Por onde o envio saiu, quando chegou a sair (o rodízio pode não usar o principal). */
  numero?: string;
}

/** O desfecho da rajada inteira: a soma dos envios e todos os números por onde ela falou. */
export interface DesfechoDaRajada extends DesfechoDeUm {
  numeros: string[];
}

export interface DependenciasDaRajada<T> {
  /** Os próximos pendentes, na ordem da fila. Vazio = não há mais ninguém agora. */
  buscarLote: (quantos: number) => Promise<T[]>;
  /** O envio de sempre, para este destinatário. */
  enviarUm: (alvo: T) => Promise<DesfechoDeUm>;
  /** A campanha continua `running`? Pausa e cancelamento pela tela param a rajada. */
  aindaEmAndamento: () => Promise<boolean>;
  /** Sem pendentes: a rodada de sempre decide se conclui ou espera os em voo. */
  concluirSeAcabou: () => Promise<DesfechoDeUm>;
  agora: () => number;
  esperar: (ms: number) => Promise<void>;
}

// `org_nao_operante` devolve o destinatário a `pending`: sem parar aqui, o lote
// seguinte o escolheria de novo até o prazo acabar.
const PARA_A_RAJADA = /^(pausada:|ritmo:|canal:|limite:|erro_na_reserva|org_nao_operante)/;

/** O desfecho vale para os envios seguintes também — a rajada não insiste. */
export function desfechoParaARajada(detalhe: string): boolean {
  return PARA_A_RAJADA.test(detalhe);
}

export async function rodarEmRajada<T>(
  dep: DependenciasDaRajada<T>,
  config: {
    concorrencia: number;
    intervaloEntreIniciosMs: number;
    tamanhoDoLote: number;
    prazoMs: number;
  } = RAJADA,
): Promise<DesfechoDaRajada> {
  const inicio = dep.agora();
  const total: DesfechoDaRajada = { enviadas: 0, pulados: 0, concluidas: 0, detalhe: "", numeros: [] };
  const numeros = new Set<string>();
  const motivos = new Map<string, number>();
  let ultimoDetalhe: string | null = null;
  let parada: string | null = null;
  let ultimoInicio = -Infinity;
  const noPrazo = () => dep.agora() - inicio < config.prazoMs;

  const somar = (r: DesfechoDeUm) => {
    total.enviadas += r.enviadas;
    total.pulados += r.pulados;
    total.concluidas += r.concluidas;
    const chave = r.detalhe.split(":")[0] ?? r.detalhe;
    motivos.set(chave, (motivos.get(chave) ?? 0) + 1);
    ultimoDetalhe = r.detalhe;
    if (r.numero) numeros.add(r.numero);
  };

  // Uma vaga de início por vez, espaçadas: o teto é de INÍCIOS por segundo, e
  // vale para todas as filas juntas.
  let fila: Promise<void> = Promise.resolve();
  const vagaDeInicio = () => {
    const vez = fila.then(async () => {
      const espera = ultimoInicio + config.intervaloEntreIniciosMs - dep.agora();
      if (espera > 0) await dep.esperar(espera);
      ultimoInicio = dep.agora();
    });
    fila = vez;
    return vez;
  };

  while (parada === null && noPrazo()) {
    if (!(await dep.aindaEmAndamento())) {
      parada = "fora_de_andamento";
      break;
    }
    const lote = await dep.buscarLote(config.tamanhoDoLote);
    if (lote.length === 0) {
      somar(await dep.concluirSeAcabou());
      parada = "sem_pendentes";
      break;
    }

    let proximo = 0;
    const faixa = async () => {
      while (parada === null && proximo < lote.length) {
        // O destinatário é tomado ANTES da espera: esperar a vez para depois
        // achar o lote vazio desperdiçava um início por faixa a cada lote. Se
        // a rajada parar durante a espera, ele segue `pending` e o próximo lote
        // (ou a próxima rodada) o busca de novo.
        const alvo = lote[proximo++]!;
        await vagaDeInicio();
        // Rechecado DEPOIS da espera: outra faixa pode ter parado a rajada, e
        // o prazo pode ter vencido enquanto esta esperava a vez.
        if (parada !== null || !noPrazo()) return;
        const r = await dep.enviarUm(alvo);
        somar(r);
        if (desfechoParaARajada(r.detalhe)) parada = r.detalhe;
      }
    };
    await Promise.all(Array.from({ length: Math.min(config.concorrencia, lote.length) }, faixa));
  }

  // Nada saiu e ninguém foi pulado: a rajada não usou o número. O desfecho volta
  // CRU (`ritmo:*`, `aguardando`…), para a rodada decidir se o número fica ocupado
  // pela mesma régua da gradual (`ocupaONumero`, #3102) — embrulhado em
  // `rajada:0:…`, a campanha rápida parada no próprio teto seguraria a vez das
  // outras do mesmo número.
  total.numeros = [...numeros];
  if (total.enviadas === 0 && total.pulados === 0 && ultimoDetalhe !== null) {
    total.detalhe = ultimoDetalhe;
    return total;
  }

  const resumo = [...motivos].map(([k, n]) => `${k}×${n}`).join(",");
  total.detalhe = `rajada:${total.enviadas}${resumo ? `(${resumo})` : ""}${parada ? `:${parada}` : ":prazo"}`;
  return total;
}
