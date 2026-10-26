/**
 * O ENCAIXE EM FILA — A VAGA QUE ABRIU VAI PARA UMA PESSOA POR VEZ.
 *
 * ─── Por que em fila, e não "manda para todos e quem responder primeiro leva"
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Dois respondem SIM e um ouve "já foi". Segurando a vaga para UM por vez, o
 * produto nunca promete o que não pode cumprir — e o mecanismo de "solta no
 * prazo" já existe nesta base (`pending_expires_after_minutes`, a varredura de
 * `agenda-expira-pendentes`). O que este arquivo acrescenta é a ORDEM e a
 * passagem para o próximo.
 *
 * ─── A vaga segurada é um compromisso `pending` DE VERDADE ────────────────
 *
 * Não é um estado paralelo: `pending` já ocupa o horário (some da lista de
 * livres e recusa uma segunda marcação no mesmo instante) e já tem prazo. Um
 * segundo mecanismo de reserva divergiria do primeiro no primeiro conserto, e o
 * sintoma seria o agente oferecendo um horário que a tela mostra ocupado.
 *
 * ─── Este arquivo não fala com o cliente ──────────────────────────────────
 *
 * Ele devolve o TEXTO da oferta (`textoDaOferta`) e o prazo. Quem manda é o
 * caminho de saída que já existe — janela de envio, espaçamento do número,
 * opt-out e limite diário são regras que não podem ter uma segunda versão
 * (CLAUDE.md § Saída). Criar um envio paralelo aqui seria a primeira automação
 * a furar o anti-banimento.
 */
import type {
  InscricaoNaEspera,
  ServicoDaEspera,
  VagaAberta,
} from "./lista-de-espera";
import {
  escolherCandidato,
  prazoDaOferta,
  textoDaOferta,
} from "./lista-de-espera";

/** A oferta que está de pé: quem está com a vaga segurada e até quando. */
export interface OfertaCorrente {
  esperaId: string;
  contatoId: string;
  compromissoId: string;
  expiraEm: Date;
  /** `startsAt` da vaga segurada — o texto da oferta precisa dele. */
  startsAt: Date;
  endsAt: Date;
  ownerUserId: string | null;
  timeZone: string;
}

export interface SeguroDaVaga {
  organizationId: string;
  contatoId: string;
  servico: ServicoDaEspera;
  inicio: Date;
  fim: Date;
  fuso: string;
  ownerUserId: string | null;
  /** O compromisso que abriu a vaga — vira `rescheduled_from_id`? NÃO: é só rastro. */
  vagaAbertaPorId: string;
}

/**
 * A porta do banco. Uma interface só com o que a decisão precisa, porque o fluxo
 * (oferecer → aceitar/recusar/vencer → próximo) é o que se quer provar, e provar
 * isso contra um Postgres de verdade custaria o teste inteiro.
 */
export interface PortaDoEncaixe {
  /** A vaga, se ela ainda está liberada. `null` = ocupada, apagada ou não cancelada. */
  vaga(organizationId: string, appointmentId: string): Promise<VagaAberta | null>;
  /** Só quem está `waiting` — quem já está com oferta na mão não entra na fila. */
  fila(organizationId: string): Promise<InscricaoNaEspera[]>;
  servico(organizationId: string, eventTypeId: string): Promise<ServicoDaEspera | null>;
  /** Segura a vaga num compromisso `pending`. `null` = outra coisa pegou o instante. */
  segurar(entrada: SeguroDaVaga): Promise<string | null>;
  /** `false` = a inscrição mudou de estado na corrida e não aceita mais oferta. */
  marcarOfertada(entrada: {
    esperaId: string;
    compromissoId: string;
    expiraEm: Date;
  }): Promise<boolean>;
  oferta(organizationId: string, esperaId: string): Promise<OfertaCorrente | null>;
  ofertasVencidas(organizationId: string, agora: Date): Promise<OfertaCorrente[]>;
  confirmar(organizationId: string, compromissoId: string): Promise<void>;
  /** Cancela o compromisso segurado, devolvendo o horário. */
  soltar(organizationId: string, compromissoId: string, motivo: string): Promise<void>;
  situar(organizationId: string, esperaId: string, situacao: "waiting" | "booked" | "cancelled"): Promise<void>;
}

export type ResultadoDaOferta =
  | {
      ofertada: true;
      esperaId: string;
      contatoId: string;
      compromissoId: string;
      expiraEm: Date;
      /** Texto pronto para o agente mandar. O envio NÃO acontece aqui. */
      texto: string;
    }
  | {
      ofertada: false;
      motivo: "vaga_indisponivel" | "sem_candidato" | "vaga_perto_demais" | "vaga_ja_ocupada";
    };

/**
 * A vaga abriu: escolhe a primeira pessoa da fila que cabe, segura o horário
 * para ela e devolve o prazo e o texto.
 *
 * A ORDEM DOS PASSOS É A GARANTIA. `segurar` vem antes de `marcarOfertada`
 * porque é o INSERT que perde a corrida quando duas desmarcações abrem o mesmo
 * instante ao mesmo tempo (o índice único parcial
 * `calendar_appointments_sem_duplicata_idx` recusa o segundo). Marcar a
 * inscrição como `offered` antes de ter o compromisso deixaria alguém
 * "esperando resposta" numa vaga que outra pessoa levou.
 */
export async function oferecerVagaQueAbriu(
  porta: PortaDoEncaixe,
  entrada: { organizationId: string; appointmentId: string; agora: Date },
): Promise<ResultadoDaOferta> {
  const vaga = await porta.vaga(entrada.organizationId, entrada.appointmentId);
  if (!vaga) return { ofertada: false, motivo: "vaga_indisponivel" };

  const expiraEm = prazoDaOferta(vaga, entrada.agora);
  if (!expiraEm) return { ofertada: false, motivo: "vaga_perto_demais" };

  const fila = await porta.fila(entrada.organizationId);
  if (fila.length === 0) return { ofertada: false, motivo: "sem_candidato" };

  const cache = new Map<string, ServicoDaEspera | null>();
  const servicoDe = (eventTypeId: string): ServicoDaEspera | null =>
    cache.get(eventTypeId) ?? null;
  // A fila é curta por construção (uma clínica tem dezenas de pedidos), e
  // carregar os moldes antes de decidir evita N idas ao banco dentro do laço.
  for (const tipo of new Set(fila.map((i) => i.eventTypeId)))
    cache.set(tipo, await porta.servico(entrada.organizationId, tipo));

  const candidato = escolherCandidato(vaga, fila, servicoDe, entrada.agora);
  if (!candidato) return { ofertada: false, motivo: "sem_candidato" };

  const compromissoId = await porta.segurar({
    organizationId: entrada.organizationId,
    contatoId: candidato.inscricao.contactId,
    servico: candidato.servico,
    inicio: vaga.startsAt,
    fim: new Date(vaga.startsAt.getTime() + candidato.servico.duracaoMinutos * 60_000),
    fuso: vaga.timeZone,
    ownerUserId: vaga.ownerUserId,
    vagaAbertaPorId: vaga.appointmentId,
  });
  if (!compromissoId) return { ofertada: false, motivo: "vaga_ja_ocupada" };

  const marcou = await porta.marcarOfertada({
    esperaId: candidato.inscricao.id,
    compromissoId,
    expiraEm,
  });
  if (!marcou) {
    // A inscrição saiu de `waiting` entre a leitura da fila e o UPDATE (a equipe
    // cancelou, outra vaga a pegou): a vaga segurada não tem dono, e deixá-la
    // presa seria o mesmo defeito que o prazo existe para evitar.
    await porta.soltar(entrada.organizationId, compromissoId, "Encaixe cancelado antes da oferta.");
    return { ofertada: false, motivo: "vaga_ja_ocupada" };
  }

  return {
    ofertada: true,
    esperaId: candidato.inscricao.id,
    contatoId: candidato.inscricao.contactId,
    compromissoId,
    expiraEm,
    texto: textoDaOferta(vaga, candidato.servico, expiraEm),
  };
}

export type ResultadoDaAceitacao =
  | { aceito: true; compromissoId: string }
  | { aceito: false; motivo: "sem_oferta" | "oferta_vencida" };

/**
 * A pessoa respondeu SIM.
 *
 * ⚠️ OFERTA VENCIDA NÃO É ACEITA, mesmo com o SIM na mão. Entre o vencimento e a
 * resposta, a varredura pode já ter soltado o horário e chamado o próximo —
 * confirmar aqui criaria dois compromissos para o mesmo instante, e o segundo
 * cliente ouviria "já foi" depois de ouvir SIM. Quem chama trata o
 * `oferta_vencida` como "ofereça outro horário".
 */
export async function aceitarEncaixe(
  porta: PortaDoEncaixe,
  entrada: { organizationId: string; esperaId: string; agora: Date },
): Promise<ResultadoDaAceitacao> {
  const oferta = await porta.oferta(entrada.organizationId, entrada.esperaId);
  if (!oferta) return { aceito: false, motivo: "sem_oferta" };
  if (oferta.expiraEm.getTime() <= entrada.agora.getTime()) {
    return { aceito: false, motivo: "oferta_vencida" };
  }
  await porta.confirmar(entrada.organizationId, oferta.compromissoId);
  await porta.situar(entrada.organizationId, entrada.esperaId, "booked");
  return { aceito: true, compromissoId: oferta.compromissoId };
}

export interface ResultadoDaRecusa {
  /** A vaga segurada foi devolvida (mesmo que ninguém da fila a tenha pego). */
  solta: boolean;
  /** O que aconteceu com a PRÓXIMA pessoa da fila. */
  proximo: ResultadoDaOferta | null;
}

/**
 * A pessoa disse NÃO (ou a equipe tirou a oferta).
 *
 * A ordem aqui também é a garantia: **soltar → oferecer ao próximo → só então
 * devolver esta inscrição à fila**. Se a reativação viesse primeiro, a mesma
 * pessoa seria escolhida de novo para a mesma vaga — o laço mais fácil de
 * escrever e o mais difícil de perceber, porque só aparece quando alguém recusa.
 *
 * `definitivo` é "não quero mais encaixe" (a inscrição vira `cancelled`); sem
 * ele, a pessoa volta para a fila e continua valendo para outras vagas.
 */
export async function recusarEncaixe(
  porta: PortaDoEncaixe,
  entrada: { organizationId: string; esperaId: string; definitivo: boolean; agora: Date },
): Promise<ResultadoDaRecusa> {
  const oferta = await porta.oferta(entrada.organizationId, entrada.esperaId);
  if (!oferta) {
    if (entrada.definitivo) await porta.situar(entrada.organizationId, entrada.esperaId, "cancelled");
    return { solta: false, proximo: null };
  }

  await porta.soltar(
    entrada.organizationId,
    oferta.compromissoId,
    entrada.definitivo
      ? "Encaixe recusado: a pessoa não quer mais entrar na lista."
      : "Encaixe recusado: a pessoa não pôde neste horário.",
  );
  const proximo = await oferecerVagaQueAbriu(porta, {
    organizationId: entrada.organizationId,
    appointmentId: oferta.compromissoId,
    agora: entrada.agora,
  });
  await porta.situar(
    entrada.organizationId,
    entrada.esperaId,
    entrada.definitivo ? "cancelled" : "waiting",
  );
  return { solta: true, proximo };
}

export interface ResultadoDaVarredura {
  vencidas: number;
  reoferecidas: number;
}

/**
 * O prazo venceu sem resposta: solta a vaga e chama o próximo.
 *
 * É o outro lado da garantia "segurar a vaga para um por vez". Sem esta
 * varredura, a oferta sem resposta prenderia o horário — o mesmo defeito que a
 * `agenda-expira-pendentes` já corrigiu para o pedido que ninguém confirmou.
 *
 * Uma vaga vencida que não acha próximo volta a ser horário livre, e isso é o
 * desfecho desejado: melhor vazia e disponível do que presa.
 */
export async function vencerOfertas(
  porta: PortaDoEncaixe,
  entrada: { organizationId: string; agora: Date },
): Promise<ResultadoDaVarredura> {
  const vencidas = await porta.ofertasVencidas(entrada.organizationId, entrada.agora);
  let reoferecidas = 0;
  for (const oferta of vencidas) {
    await porta.soltar(
      entrada.organizationId,
      oferta.compromissoId,
      "Oferta de encaixe venceu sem resposta.",
    );
    const proximo = await oferecerVagaQueAbriu(porta, {
      organizationId: entrada.organizationId,
      appointmentId: oferta.compromissoId,
      agora: entrada.agora,
    });
    if (proximo.ofertada) reoferecidas += 1;
    // Quem não respondeu volta para a fila: a inscrição dela não venceu, a
    // oferta sim. `valido_ate` continua sendo quem tira alguém da lista.
    await porta.situar(entrada.organizationId, oferta.esperaId, "waiting");
  }
  return { vencidas: vencidas.length, reoferecidas };
}
