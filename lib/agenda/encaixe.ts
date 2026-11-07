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
 * ─── A ordem da oferta ────────────────────────────────────────────────────
 *
 * `podeAvisar` vem ANTES de segurar: quem está fora da janela do canal ou sem
 * conversa não recebe vaga presa por uma mensagem que não vai sair. O aviso
 * passa pelo caminho de saída que já existe, e quando ele não sai a vaga é
 * solta na hora e a fila segue.
 */
import type {
  ConfigDaListaDeEspera,
  InscricaoNaEspera,
  ServicoDaEspera,
  VagaAberta,
} from "./lista-de-espera";
import { candidatosAoEncaixe, prazoDaOferta, textoDaOferta } from "./lista-de-espera";

/** A oferta que está de pé: quem está com a vaga segurada e até quando. */
export interface OfertaCorrente {
  esperaId: string;
  contatoId: string;
  compromissoId: string;
  /** A situação do compromisso segurado: a recusa e a varredura leem antes de soltar. */
  compromissoStatus: string;
  contatoDisponivel: boolean;
  expiraEm: Date;
  /** O fim do BURACO que abriu, que é o que passa ao próximo da fila. */
  vagaFim: Date;
  startsAt: Date;
  endsAt: Date;
  ownerUserId: string | null;
  timeZone: string;
}

export interface PedidoDeOferta {
  organizationId: string;
  esperaId: string;
  inicio: Date;
  fim: Date;
  fuso: string;
  ownerUserId: string | null;
  vagaFim: Date;
  expiraEm: Date;
}

export type DesfechoDaOferta =
  | { ok: true; compromissoId: string }
  | {
      ok: false;
      motivo: "inscricao_mudou" | "contato_indisponivel" | "servico_indisponivel" | "vaga_ja_ocupada";
    };

/**
 * A porta do banco. Uma interface só com o que a decisão precisa, porque o fluxo
 * (oferecer → aceitar/recusar/vencer → próximo) é o que se quer provar passo a
 * passo; a atomicidade e a concorrência são provadas em Postgres, nos invariantes.
 */
export interface PortaDoEncaixe {
  /** Os prazos da organização. `null` = recurso desligado ou sem prazos escolhidos. */
  config(organizationId: string): Promise<ConfigDaListaDeEspera | null>;
  /** A vaga, se ela ainda está liberada. `null` = ocupada, apagada ou não cancelada. */
  vaga(organizationId: string, appointmentId: string): Promise<VagaAberta | null>;
  /** Só quem está `waiting`, com contato que pode ser chamado. */
  fila(organizationId: string): Promise<InscricaoNaEspera[]>;
  servico(organizationId: string, eventTypeId: string): Promise<ServicoDaEspera | null>;
  /** Antes de segurar: dá para mandar a mensagem agora? */
  podeAvisar(organizationId: string, contatoId: string): Promise<boolean>;
  /** Segura a vaga e marca a inscrição numa transação só (`fn_lista_de_espera_ofertar`). */
  ofertar(pedido: PedidoDeOferta): Promise<DesfechoDaOferta>;
  /** `false` = a mensagem não saiu. */
  avisar(organizationId: string, contatoId: string, texto: string): Promise<boolean>;
  oferta(organizationId: string, esperaId: string): Promise<OfertaCorrente | null>;
  ofertasVencidas(organizationId: string, agora: Date): Promise<OfertaCorrente[]>;
  /** Cancela o compromisso segurado, devolvendo o horário. */
  soltar(organizationId: string, compromissoId: string, motivo: string): Promise<void>;
  /** `vagaRecusada` = o início da vaga que esta pessoa não quis, para não voltar a ela. */
  situar(
    organizationId: string,
    esperaId: string,
    situacao: "waiting" | "booked" | "cancelled",
    vagaRecusada?: Date,
  ): Promise<void>;
}

export type ResultadoDaOferta =
  | {
      ofertada: true;
      esperaId: string;
      contatoId: string;
      compromissoId: string;
      expiraEm: Date;
      texto: string;
    }
  | {
      ofertada: false;
      motivo: "desligada" | "vaga_indisponivel" | "sem_candidato" | "vaga_perto_demais" | "vaga_ja_ocupada";
    };

/**
 * A vaga abriu: chama a primeira pessoa da fila que cabe e pode ser avisada.
 *
 * `fimDaVaga` é o fim do buraco original. Numa vaga que passa de mão em mão, o
 * compromisso solto tem só a duração do serviço do anterior, e ler o fim dele
 * encolheria a vaga a cada recusa.
 */
export async function oferecerVagaQueAbriu(
  porta: PortaDoEncaixe,
  entrada: { organizationId: string; appointmentId: string; agora: Date; fimDaVaga?: Date },
): Promise<ResultadoDaOferta> {
  const { organizationId, agora } = entrada;
  const config = await porta.config(organizationId);
  if (!config) return { ofertada: false, motivo: "desligada" };

  const aberta = await porta.vaga(organizationId, entrada.appointmentId);
  if (!aberta) return { ofertada: false, motivo: "vaga_indisponivel" };
  const vaga = { ...aberta, endsAt: entrada.fimDaVaga ?? aberta.endsAt };

  const expiraEm = prazoDaOferta(vaga, agora, config);
  if (!expiraEm) return { ofertada: false, motivo: "vaga_perto_demais" };

  const fila = await porta.fila(organizationId);
  if (fila.length === 0) return { ofertada: false, motivo: "sem_candidato" };

  const servicos = new Map<string, ServicoDaEspera | null>();
  for (const tipo of new Set(fila.map((i) => i.eventTypeId))) {
    servicos.set(tipo, await porta.servico(organizationId, tipo));
  }
  const servicoDe = (tipo: string) => servicos.get(tipo) ?? null;

  for (const { inscricao, servico } of candidatosAoEncaixe(vaga, fila, servicoDe, agora)) {
    if (!(await porta.podeAvisar(organizationId, inscricao.contactId))) continue;

    const desfecho = await porta.ofertar({
      organizationId,
      esperaId: inscricao.id,
      inicio: vaga.startsAt,
      fim: new Date(vaga.startsAt.getTime() + servico.duracaoMinutos * 60_000),
      fuso: vaga.timeZone,
      ownerUserId: vaga.ownerUserId,
      vagaFim: vaga.endsAt,
      expiraEm,
    });
    if (!desfecho.ok) {
      if (desfecho.motivo === "vaga_ja_ocupada") return { ofertada: false, motivo: "vaga_ja_ocupada" };
      continue;
    }

    const texto = textoDaOferta(vaga, servico, expiraEm);
    if (await porta.avisar(organizationId, inscricao.contactId, texto)) {
      return {
        ofertada: true,
        esperaId: inscricao.id,
        contatoId: inscricao.contactId,
        compromissoId: desfecho.compromissoId,
        expiraEm,
        texto,
      };
    }
    // Vaga segurada para quem não foi avisado é vaga presa: solta e segue a fila.
    await porta.soltar(organizationId, desfecho.compromissoId, "O aviso da vaga não saiu.");
    await porta.situar(organizationId, inscricao.id, "waiting");
  }
  return { ofertada: false, motivo: "sem_candidato" };
}

export type ResultadoDaAceitacao =
  | { aceito: true; compromissoId: string }
  | {
      aceito: false;
      motivo: "sem_oferta" | "oferta_vencida" | "contato_indisponivel" | "vaga_perdida";
    };

/**
 * A pessoa disse SIM.
 *
 * `confirmar` é a porta de alteração da agenda, a mesma do `crm_confirm_appointment`
 * e da tela: é ela que serializa a corrida com o cancelamento, pela revisão do
 * compromisso, e é ela que cobra a aprovação humana do serviço que a exige. Devolve
 * `false` quando o compromisso já não pode ser confirmado.
 *
 * ⚠️ OFERTA VENCIDA NÃO É ACEITA, mesmo com o SIM na mão. Entre o vencimento e a
 * resposta, a varredura pode já ter soltado o horário e chamado o próximo.
 */
export async function aceitarEncaixe(
  porta: PortaDoEncaixe,
  entrada: { organizationId: string; esperaId: string; agora: Date },
  confirmar: (compromissoId: string) => Promise<boolean>,
): Promise<ResultadoDaAceitacao> {
  const oferta = await porta.oferta(entrada.organizationId, entrada.esperaId);
  if (!oferta) return { aceito: false, motivo: "sem_oferta" };
  if (oferta.expiraEm.getTime() <= entrada.agora.getTime()) {
    return { aceito: false, motivo: "oferta_vencida" };
  }
  if (!oferta.contatoDisponivel) return { aceito: false, motivo: "contato_indisponivel" };

  if (!(await confirmar(oferta.compromissoId))) {
    await porta.situar(entrada.organizationId, entrada.esperaId, "waiting");
    return { aceito: false, motivo: "vaga_perdida" };
  }
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
 * pessoa seria escolhida de novo para a mesma vaga.
 *
 * `definitivo` é "não quero mais encaixe" (a inscrição vira `cancelled`); sem
 * ele, a pessoa volta para a fila e continua valendo para outras vagas.
 */
export async function recusarEncaixe(
  porta: PortaDoEncaixe,
  entrada: { organizationId: string; esperaId: string; definitivo: boolean; agora: Date },
): Promise<ResultadoDaRecusa> {
  const { organizationId, esperaId, definitivo } = entrada;
  const oferta = await porta.oferta(organizationId, esperaId);
  if (!oferta) {
    if (definitivo) await porta.situar(organizationId, esperaId, "cancelled");
    return { solta: false, proximo: null };
  }
  // A confirmação venceu a corrida: a pessoa tem o horário.
  if (oferta.compromissoStatus === "confirmed") {
    await porta.situar(organizationId, esperaId, "booked");
    return { solta: false, proximo: null };
  }

  await porta.soltar(
    organizationId,
    oferta.compromissoId,
    definitivo
      ? "Encaixe recusado: a pessoa não quer mais entrar na lista."
      : "Encaixe recusado: a pessoa não pôde neste horário.",
  );
  const proximo = await oferecerVagaQueAbriu(porta, {
    organizationId,
    appointmentId: oferta.compromissoId,
    agora: entrada.agora,
    fimDaVaga: oferta.vagaFim,
  });
  await porta.situar(organizationId, esperaId, definitivo ? "cancelled" : "waiting", oferta.startsAt);
  return { solta: true, proximo };
}

export interface ResultadoDaVarredura {
  vencidas: number;
  reoferecidas: number;
}

/**
 * O prazo venceu sem resposta: solta a vaga e chama o próximo.
 *
 * Uma vaga vencida que não acha próximo volta a ser horário livre, e isso é o
 * desfecho desejado: melhor vazia e disponível do que presa.
 */
export async function vencerOfertas(
  porta: PortaDoEncaixe,
  entrada: { organizationId: string; agora: Date },
): Promise<ResultadoDaVarredura> {
  const { organizationId, agora } = entrada;
  const vencidas = await porta.ofertasVencidas(organizationId, agora);
  let reoferecidas = 0;
  for (const oferta of vencidas) {
    // Confirmada pela agenda e o fecho da inscrição não aconteceu: recupera aqui.
    if (oferta.compromissoStatus === "confirmed") {
      await porta.situar(organizationId, oferta.esperaId, "booked");
      continue;
    }
    await porta.soltar(organizationId, oferta.compromissoId, "Oferta de encaixe venceu sem resposta.");
    const proximo = await oferecerVagaQueAbriu(porta, {
      organizationId,
      appointmentId: oferta.compromissoId,
      agora,
      fimDaVaga: oferta.vagaFim,
    });
    if (proximo.ofertada) reoferecidas += 1;
    // Quem não respondeu volta para a fila: a oferta venceu, a inscrição não.
    await porta.situar(organizationId, oferta.esperaId, "waiting", oferta.startsAt);
  }
  return { vencidas: vencidas.length, reoferecidas };
}
