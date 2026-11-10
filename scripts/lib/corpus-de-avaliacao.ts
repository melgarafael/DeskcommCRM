/**
 * O CORPUS DAS AVALIAÇÕES C, F5 e G — conversas INVENTADAS, em pt-BR, de quatro
 * negócios fictícios. Nenhum nome, telefone, e-mail, CPF ou endereço é de gente
 * de verdade: e-mails em `exemplo.com.br`, CPF 123.456.789-09 (o de teste),
 * telefones `55 DDD 9 0000-xxxx`.
 *
 * Cada conjunto põe em risco a mudança que avalia:
 *   C  (30) — ferramentas com uuid, data/hora e e-mail nos argumentos: o id do
 *        contato copiado do contexto, o instante ISO com fuso, o e-mail que o
 *        cliente digita (em maiúsculas, ou sem domínio completo).
 *   F5 (64) — as 30 do C (histórico comum) + 30 SONDAS de histórico, dez de
 *        cada tipo: quem disse o quê, horário relativo ao carimbo da mensagem e
 *        remetente de grupo; + 4 controles de quem disse o quê (SONDAS_DE_CONTROLE).
 *   G  (160) — as 30 do C e as 30 sondas do F5 + 100 de fechamento: promessa com e sem prazo,
 *        "vou verificar e te aviso", pedido de humano, objeção de preço,
 *        remarcar × cancelar, espanhol, e-mail, CPF e endereço, e um resumo
 *        anterior em 2 de cada 3 (a retenção).
 *
 * As 100 de fechamento saem de 20 roteiros × 5 negócios/clientes: a variação é
 * de negócio, nome, valor e prazo, e o texto de cada roteiro é o mesmo. É
 * pseudo-réplica — o intervalo de confiança do G sai otimista, e o runbook diz.
 *
 * O relógio de todas é FIXO (`AGORA`, quarta 04/11/2026 10:00 em São Paulo): as
 * sondas de horário só têm resposta certa com ele, e o roteiro injeta o mesmo
 * instante no turno (`deps.clock`).
 */
import { createHash } from "node:crypto";

import type { LeadContext, LeadContextMessage, LeadContextResult } from "@/lib/agent-engine/edge/crm/get-lead-context";
import type { LeadCheckpointRow } from "@/lib/agent-engine/agent/abertura/checkpoint";

import type { Sonda } from "./avaliacao-de-tokens";

export const AGORA = "2026-11-04T10:00:00-03:00";
export const FUSO = "America/Sao_Paulo";

export type PersonaId = "clinica" | "loja" | "imobiliaria" | "curso";

export interface Persona {
  id: PersonaId;
  empresa: string;
  /** O prompt do agente, como o operador escreveria na tela. */
  prompt: string;
  /** As capacidades do catálogo que o agente de avaliação tem ligadas (preparo no runbook). */
  ferramentas: readonly string[];
}

export const PERSONAS: Readonly<Record<PersonaId, Persona>> = {
  clinica: {
    id: "clinica",
    empresa: "Clínica Sorriso Pleno",
    prompt:
      "Você é a Clara, assistente da Clínica Sorriso Pleno, odontologia em Belo Horizonte (Av. do Contorno, 4520, Funcionários). " +
      "Você atende pelo WhatsApp: tira dúvidas, marca, remarca e cancela consultas.\n" +
      "Serviços: avaliação (gratuita, 30 min), limpeza (R$ 220, 50 min), clareamento a laser (R$ 1.400, em 2 sessões com uma semana de intervalo) e manutenção de aparelho (R$ 180, 30 min).\n" +
      "Horário: segunda a sexta, 8h às 19h; sábado, 8h às 12h.\n" +
      "Regras: nunca prometa diagnóstico nem preço de tratamento sem avaliação. Para marcar, consulte os horários livres e confirme dia e hora com o paciente antes de reservar. " +
      "Se o paciente quiser o convite, peça o e-mail. Pagamento por PIX ou cartão em até 6x. Fale de forma acolhedora e curta, como no WhatsApp.",
    ferramentas: [
      "crm_list_event_types",
      "crm_find_free_slots",
      "crm_book_appointment",
      "crm_list_appointments",
      "crm_reschedule_appointment",
      "crm_cancel_appointment",
      "crm_propose_contact_field",
    ],
  },
  loja: {
    id: "loja",
    empresa: "Casa Aurora Móveis",
    prompt:
      "Você é a Duda, vendedora da Casa Aurora Móveis, loja online de móveis com entrega na Grande São Paulo e em Campinas.\n" +
      "Catálogo principal: sofá retrátil Aurora 2,30 m (R$ 3.290, cinza ou bege), mesa de jantar Lume 6 lugares (R$ 2.450), cadeira Lume (R$ 389 cada), rack Vale 1,80 m (R$ 1.190).\n" +
      "Frete grátis acima de R$ 2.000 na capital; para Campinas, R$ 150. Prazo de entrega: 10 a 15 dias úteis depois do pagamento.\n" +
      "Pagamento: PIX com 5% de desconto, ou cartão em até 10x sem juros.\n" +
      "Quando o cliente decide comprar, registre o negócio no funil com o valor e a previsão de fechamento. " +
      "Não invente estoque, prazo ou desconto fora destas regras: desconto acima de 5% só com o gerente.",
    ferramentas: [
      "crm_list_pipelines",
      "crm_list_stages",
      "crm_create_lead",
      "crm_update_lead",
      "crm_move_lead_stage",
      "crm_propose_contact_field",
    ],
  },
  imobiliaria: {
    id: "imobiliaria",
    empresa: "Imobiliária Horizonte",
    prompt:
      "Você é a Iara, corretora virtual da Imobiliária Horizonte, em Curitiba. Ajuda quem quer alugar ou comprar: entende o perfil (bairro, quartos, orçamento), apresenta os imóveis e agenda visitas com um corretor.\n" +
      "Imóveis em destaque: apartamento de 2 quartos no Batel (aluguel R$ 3.200 + condomínio R$ 780), apartamento de 3 quartos no Água Verde (venda R$ 690 mil, aceita financiamento) e studio no Centro (aluguel R$ 1.650).\n" +
      "Visitas: segunda a sábado, das 9h às 18h, com 1 hora de duração.\n" +
      "Para alugar pedimos comprovante de renda de 3 vezes o aluguel e fiador ou seguro-fiança.\n" +
      "Registre cada interessado no funil com o imóvel e o valor. Nunca confirme proposta de valor sem o proprietário.",
    ferramentas: [
      "crm_list_event_types",
      "crm_find_free_slots",
      "crm_book_appointment",
      "crm_list_pipelines",
      "crm_list_stages",
      "crm_create_lead",
      "crm_update_lead",
      "crm_move_lead_stage",
      "crm_propose_contact_field",
    ],
  },
  curso: {
    id: "curso",
    empresa: "Escola Doce Ofício",
    prompt:
      "Você é a Gabi, consultora da Escola Doce Ofício, que vende o curso online Confeitaria Lucrativa: R$ 497 à vista ou 12x de R$ 49,70, acesso por 1 ano, 60 aulas e certificado.\n" +
      "Há também a mentoria em grupo (R$ 1.200; a próxima turma começa em 17/11). Garantia de 7 dias para os dois.\n" +
      "Você tira dúvidas, contorna objeções com honestidade e manda o link de pagamento quando a pessoa decide. O cupom de lançamento DOCE10 dá 10% de desconto até 10/11.\n" +
      "Não prometa resultado financeiro. Se pedirem algo fora do curso (aula presencial, reembolso depois da garantia), passe para a equipe.",
    ferramentas: ["crm_list_pipelines", "crm_list_stages", "crm_create_lead", "crm_move_lead_stage", "crm_propose_contact_field"],
  },
};

/** As nativas que entram em todo turno do agente de avaliação (o retorno ligado, passagem ligada). */
export const NATIVAS_DO_TURNO = [
  "send_message",
  "update_lead_state",
  "save_lead_note",
  "get_lead_context",
  "get_lead_note",
  "schedule_followup",
  "request_human_handoff",
] as const;

// ═══ A forma de uma conversa ═══════════════════════════════════════════════════

type Lado = "c" | "n";
/** [quem, "dd/mm hh:mm" em São Paulo, texto, extra]. */
export type Fala = readonly [Lado, string, string, { tipo?: "image" | "document" | "audio"; quem?: string }?];

export interface Conversa {
  id: string;
  persona: PersonaId;
  contato: { name: string; email: string | null; phone: string };
  /** Conversa de grupo: o nome de quem manda a mensagem atual. */
  atualDe?: string;
  historico: readonly Fala[];
  atual: string;
  anterior?: { resumo: string; compromissos?: readonly string[]; objecoes?: readonly string[]; proxima?: string | null };
  /** C: o que está em risco nos argumentos. */
  risco?: readonly ("uuid" | "data" | "email")[];
  /** F5: a pergunta cuja resposta certa depende do histórico. */
  sonda?: Sonda;
  /** G: o que o agente mandou neste turno (cada item é um send_message). */
  resposta: readonly string[];
  /** G: ação do turno que voltou ok, em texto (ex.: retorno agendado). */
  acoes?: readonly string[];
}

/** "03/11 21:30" → "2026-11-03T21:30:00-03:00". */
export function iso(quando: string): string {
  const m = /^(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/.exec(quando);
  if (!m) throw new Error(`horário fora do formato dd/mm hh:mm: ${quando}`);
  return `2026-${m[2]}-${m[1]}T${m[3]}:${m[4]}:00-03:00`;
}

/** Um uuid v4 estável a partir de uma semente (o id do contato de cada conversa). */
export function uuidDe(semente: string): string {
  const h = createHash("sha256").update(semente).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${"89ab"[parseInt(h[16] ?? "0", 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const telefoneDe = (nome: string) => `5541900${String(parseInt(createHash("sha256").update(nome).digest("hex").slice(0, 6), 16) % 10000).padStart(4, "0")}`;

const HORA_DA_ATUAL = "04/11 09:58";

/** O contexto do turno como `getLeadContext` o entregaria — a mensagem atual é a última inbound. */
export function contextoDaConversa(c: Conversa): Extract<LeadContextResult, { ok: true }> {
  const id = uuidDe(`${c.id}:contato`);
  const mensagem = (f: Fala): LeadContextMessage => {
    const [lado, quando, texto, extra] = f;
    return {
      direction: lado === "c" ? "inbound" : "outbound",
      body: texto,
      sent_at: iso(quando),
      ...(extra?.tipo !== undefined ? { type: extra.tipo } : {}),
      ...(lado === "c" && extra?.quem !== undefined ? { sender: { name: extra.quem, phone: telefoneDe(extra.quem) } } : {}),
    };
  };
  const atual: Fala = ["c", HORA_DA_ATUAL, c.atual, c.atualDe !== undefined ? { quem: c.atualDe } : undefined];
  const context: LeadContext = {
    lead_id: id,
    contact_id: id,
    contact: { name: c.contato.name, phone: c.contato.phone, email: c.contato.email, tags: [], is_blocked: false },
    conversation_id: null,
    last_human_decision: null,
    messages: [...c.historico, atual].map(mensagem),
  };
  return {
    ok: true,
    context,
    tokenCount: 0,
    lgpd: {
      isAnonymized: false,
      isProspecting: false,
      legalBasis: { basis: null, consentGranted: false, legalBasisRef: null, dataOrigin: null },
    },
  };
}

/** O checkpoint anterior, na forma da linha do banco, quando a conversa tem resumo. */
export function checkpointAnterior(c: Conversa): LeadCheckpointRow | null {
  if (c.anterior === undefined) return null;
  return {
    id: uuidDe(`${c.id}:checkpoint`),
    seq: "1",
    organization_id: "",
    contact_id: uuidDe(`${c.id}:contato`),
    job_id: null,
    created_at: new Date("2026-11-03T20:00:00-03:00"),
    commitments: [...(c.anterior.compromissos ?? [])],
    objections: [...(c.anterior.objecoes ?? [])],
    next_action: c.anterior.proxima ?? null,
    rolling_summary: c.anterior.resumo,
    declaracao: null,
  };
}

/** Uma transcrição neutra (nenhum dos dois formatos do F5) para o juiz ler. */
export function transcricao(c: Conversa): string {
  return [...c.historico, ["c", HORA_DA_ATUAL, c.atual, c.atualDe !== undefined ? { quem: c.atualDe } : undefined] as Fala]
    .map(([lado, quando, texto, extra]) => {
      const quem = lado === "n" ? PERSONAS[c.persona].empresa : extra?.quem !== undefined ? `cliente (${extra.quem.split("\n")[0]})` : "cliente";
      return `[${quando}] ${quem}${extra?.tipo !== undefined ? ` [${extra.tipo}]` : ""}: ${texto}`;
    })
    .join("\n");
}

// ═══ C — argumentos com uuid, data e e-mail (30) ═══════════════════════════════

const cv = (
  id: string,
  persona: PersonaId,
  contato: [string, string | null],
  historico: readonly Fala[],
  atual: string,
  resto: Omit<Conversa, "id" | "persona" | "contato" | "historico" | "atual">,
): Conversa => ({ id, persona, contato: { name: contato[0], email: contato[1], phone: telefoneDe(id) }, historico, atual, ...resto });

export const CORPUS_C: readonly Conversa[] = [
  cv("C01", "clinica", ["Renata Alves", null], [
    ["c", "03/11 18:10", "Oi, boa tarde! Vocês fazem limpeza?"],
    ["n", "03/11 18:11", "Oi, Renata! Fazemos sim 😊 A limpeza custa R$ 220 e dura uns 50 minutos. Quer que eu veja um horário pra você?"],
    ["c", "03/11 18:40", "Quero sim, mas só consigo de manhã"],
  ], "Tem alguma coisa quinta ou sexta de manhã?", {
    risco: ["data"],
    resposta: ["Tenho quinta (05/11) às 8h e às 10h30, e sexta (06/11) às 9h. Algum desses fica bom pra você?"],
  }),
  cv("C02", "clinica", ["Marcos Teixeira", null], [
    ["c", "03/11 14:02", "Boa tarde, queria marcar uma limpeza"],
    ["n", "03/11 14:03", "Boa tarde, Marcos! Tenho quinta 05/11 às 9h ou às 10h30. Qual prefere?"],
    ["c", "03/11 14:20", "10h30 tá ótimo"],
  ], "Pode marcar no meu nome. Meu e-mail é marcos.teixeira@exemplo.com.br pra receber o convite", {
    risco: ["uuid", "data", "email"],
    resposta: ["Prontinho, Marcos! Sua limpeza ficou para quinta, 05/11, às 10h30. O convite vai para marcos.teixeira@exemplo.com.br e eu te mando um lembrete na véspera."],
  }),
  cv("C03", "clinica", ["Juliana Pires", null], [], "Oi! Queria marcar uma avaliação pra minha filha Sofia, de 9 anos, no sábado de manhã. Meu email: ju.pires@exemplo.com.br", {
    risco: ["uuid", "data", "email"],
    resposta: ["Oi, Juliana! Sábado (07/11) tenho 8h30 e 10h para a avaliação da Sofia. Qual horário prefere? Assim que você escolher eu reservo e o convite vai para o seu e-mail."],
  }),
  cv("C04", "clinica", ["Paulo Mendes", null], [
    ["n", "30/10 11:00", "Paulo, sua limpeza está confirmada para quinta, 05/11, às 14h."],
    ["c", "03/11 22:15", "Clara, vou ter que viajar essa semana"],
  ], "Dá pra passar pra semana que vem, terça, no mesmo horário?", {
    risco: ["uuid", "data"],
    resposta: ["Consigo sim, Paulo! Passei sua limpeza para terça, 10/11, às 14h. Te aviso na véspera pra confirmar."],
  }),
  cv("C05", "clinica", ["Beatriz Lacerda", null], [
    ["n", "31/10 09:00", "Beatriz, sua manutenção do aparelho é quinta, 05/11, às 17h."],
  ], "Preciso cancelar minha consulta de amanhã, surgiu um imprevisto no trabalho", {
    risco: ["uuid"],
    resposta: ["Sem problema, Beatriz, cancelei a manutenção de quinta. Quando quiser remarcar é só me chamar que eu vejo um horário."],
  }),
  cv("C06", "clinica", ["Henrique Duarte", null], [], "Vocês têm horário dia 12/11 depois das 17h? É pra começar o clareamento", {
    risco: ["data"],
    resposta: ["Oi, Henrique! No dia 12/11 tenho 17h20 e 18h. O clareamento é feito em 2 sessões, com uma semana entre elas. Quer que eu reserve uma dessas?"],
  }),
  cv("C07", "clinica", ["Larissa Moura", "larissa.moura@exemplo.com"], [
    ["c", "03/11 17:30", "Quero marcar a avaliação ortodôntica"],
    ["n", "03/11 17:31", "Claro! Tenho segunda 09/11 às 8h, 8h40 ou 11h. Qual fica melhor?"],
  ], "Fica 8h40. Ah, meu email mudou, agora é LARISSA.MOURA@Exemplo.com.br", {
    risco: ["uuid", "data", "email"],
    resposta: ["Combinado, Larissa! Sua avaliação ficou para segunda, 09/11, às 8h40. Já anotei o e-mail novo e o convite vai para ele."],
  }),
  cv("C08", "clinica", ["Otávio Brandão", null], [
    ["c", "02/11 19:00", "Meu aparelho tá machucando, preciso fazer a manutenção"],
    ["n", "02/11 19:02", "Poxa, Otávio! A manutenção custa R$ 180 e leva 30 minutos. Quando você pode vir?"],
  ], "quero marcar a manutenção depois de amanhã às 8 e meia, pode ser?", {
    risco: ["uuid", "data"],
    resposta: ["Pode sim, Otávio! Reservei sexta, 06/11, às 8h30 para a manutenção. Te mando o lembrete no dia anterior."],
  }),
  cv("C09", "clinica", ["Camila Rezende", null], [], "meu email é camila.r@gmail pode mandar o convite lá. marca a limpeza sexta 6/11 às 10h", {
    risco: ["uuid", "data", "email"],
    resposta: ["Oi, Camila! Antes de reservar sexta, 06/11, às 10h: o e-mail ficou \"camila.r@gmail\", sem o final. Pode me confirmar o endereço completo? Aí eu já marco e mando o convite."],
  }),
  cv("C10", "clinica", ["Rodrigo Nunes", "rodrigo.nunes@exemplo.com.br"], [
    ["n", "20/10 16:00", "Rodrigo, pela avaliação de hoje o dentista indicou o clareamento a laser em 2 sessões."],
  ], "Bora marcar a primeira sessão do clareamento. Pode ser dia 18 às 15h? E a segunda uma semana depois, mesmo horário", {
    anterior: { resumo: "Rodrigo Nunes fez avaliação em 20/10; indicado clareamento a laser (R$ 1.400, 2 sessões). Paga no cartão em 6x.", proxima: "marcar as duas sessões do clareamento" },
    risco: ["uuid", "data"],
    resposta: ["Marquei as duas, Rodrigo: quarta 18/11 às 15h e quarta 25/11 às 15h. O convite vai para o seu e-mail e eu te lembro na véspera de cada uma."],
  }),
  cv("C11", "clinica", ["Sandra Viana", null], [], "Oi! Quais horários vocês têm pra limpeza na semana que vem, de preferência no fim da tarde?", {
    risco: ["data"],
    resposta: ["Oi, Sandra! Na semana que vem tenho segunda 09/11 às 17h30, quarta 11/11 às 18h e quinta 12/11 às 17h. Algum te atende?"],
  }),
  cv("C12", "clinica", ["Fábio Lima", null], [
    ["c", "03/11 12:40", "Posso pagar a avaliação em 6x?"],
    ["n", "03/11 12:41", "A avaliação é gratuita, Fábio! E os tratamentos podem ser parcelados em até 6x no cartão."],
  ], "Então marca a avaliação pra hoje 16h se tiver. meu email fabio.lima@exemplo.com.br", {
    risco: ["uuid", "data", "email"],
    resposta: ["Tem sim, Fábio! Sua avaliação ficou para hoje, às 16h. O convite vai para fabio.lima@exemplo.com.br."],
  }),
  cv("C13", "imobiliaria", ["Tiago Kowalski", null], [
    ["c", "03/11 20:05", "Vi o apê de 2 quartos no Batel. Ainda tá disponível?"],
    ["n", "03/11 20:06", "Está sim, Tiago! O aluguel é R$ 3.200 + condomínio de R$ 780. Quer agendar uma visita?"],
  ], "Quero! Sábado de manhã dá? Meu email é tiago.kowalski@exemplo.com.br", {
    risco: ["uuid", "data", "email"],
    resposta: ["Dá sim! Agendei a visita ao apartamento do Batel para sábado, 07/11, às 10h, com o corretor. O convite vai para o seu e-mail."],
  }),
  cv("C14", "imobiliaria", ["Aline Ferraz", null], [], "Tenho interesse no 3 quartos do Água Verde, dá pra financiar? Queria visitar sexta às 17h", {
    risco: ["uuid", "data"],
    resposta: ["Oi, Aline! Aceita financiamento, sim. Reservei a visita para sexta, 06/11, às 17h, e registrei seu interesse no apartamento do Água Verde."],
  }),
  cv("C15", "imobiliaria", ["Diego Sampaio", "diego.sampaio@exemplo.com.br"], [
    ["c", "02/11 15:00", "Quanto é o studio do Centro?"],
    ["n", "02/11 15:01", "O studio do Centro sai R$ 1.650 de aluguel, Diego."],
  ], "Registra meu interesse no studio, quero fechar até o fim do mês", {
    risco: ["uuid", "data"],
    resposta: ["Registrado, Diego! Deixei o studio do Centro com previsão de fechamento até 30/11. Vou te mandar a lista de documentos para a análise ainda hoje."],
  }),
  cv("C16", "imobiliaria", ["Patrícia Gomes", null], [
    ["n", "01/11 10:00", "Patrícia, registrei seu interesse no 2 quartos do Batel."],
  ], "Mudei de ideia, em vez do Batel quero o 3 quartos do Água Verde mesmo. Pode atualizar?", {
    anterior: { resumo: "Patrícia Gomes interessada no apartamento de 2 quartos do Batel (aluguel R$ 3.200). Negócio aberto no funil.", compromissos: ["enviar fotos do Batel"] },
    risco: ["uuid"],
    resposta: ["Atualizado, Patrícia! Agora o seu interesse é no 3 quartos do Água Verde, de R$ 690 mil. Quer agendar uma visita?"],
  }),
  cv("C17", "imobiliaria", ["Gustavo Reis", null], [
    ["c", "28/10 11:00", "Vou ficar com o studio do Centro"],
    ["n", "28/10 11:02", "Que ótimo, Gustavo! Vou te mandar o contrato."],
  ], "Assinamos ontem o contrato do studio. Pode marcar como fechado aí?", {
    risco: ["uuid"],
    resposta: ["Parabéns pelo novo lar, Gustavo! 🎉 Já marquei o negócio do studio como fechado."],
  }),
  cv("C18", "imobiliaria", ["Mariana Santos", null], [], "Consegue visita amanhã às 9h e outra às 11h pra eu ver os dois apartamentos? meu email mari.santos@exemplo.com.br", {
    risco: ["uuid", "data", "email"],
    resposta: ["Consigo sim, Mariana! Amanhã, quinta 05/11: às 9h o Batel e às 11h o Água Verde. Os dois convites vão para o seu e-mail."],
  }),
  cv("C19", "imobiliaria", ["Ricardo Almeida", "ricardo.almeyda@exemplo.com.br"], [
    ["c", "03/11 09:15", "meu email é ricardo.almeyda@exemplo.com.br"],
  ], "opa, meu e-mail certo é ricardo.almeida@exemplo.com.br, o outro que te passei tava errado", {
    risco: ["uuid", "email"],
    resposta: ["Corrigido, Ricardo! Vou usar ricardo.almeida@exemplo.com.br daqui pra frente."],
  }),
  cv("C20", "imobiliaria", ["Fernanda Lopes", null], [], "Quero visitar o Água Verde dia 14/11, um sábado, lá pelas 10h. Vamos eu e meu marido, Carlos", {
    risco: ["uuid", "data"],
    resposta: ["Combinado, Fernanda! Visita ao Água Verde no sábado, 14/11, às 10h, para você e o Carlos."],
  }),
  cv("C21", "loja", ["Vanessa Prado", null], [
    ["c", "03/11 16:20", "Quanto fica o sofá Aurora no PIX?"],
    ["n", "03/11 16:21", "O sofá Aurora sai R$ 3.290, ou R$ 3.125,50 no PIX com 5% de desconto."],
  ], "Vou levar no PIX! Pode registrar meu pedido? Quero receber até dia 20", {
    risco: ["uuid", "data"],
    resposta: ["Que bom, Vanessa! Registrei o pedido do sofá Aurora no PIX (R$ 3.125,50). Te mando a chave PIX agora, e com o pagamento hoje a entrega fica entre 18/11 e 25/11."],
  }),
  cv("C22", "loja", ["André Cardoso", null], [], "Quero a mesa Lume e 6 cadeiras. Fecho ainda esta semana", {
    risco: ["uuid", "data"],
    resposta: ["Ótima escolha, André! A mesa Lume com 6 cadeiras dá R$ 4.784, com frete grátis na capital. Registrei seu pedido com fechamento previsto para sexta, 06/11."],
  }),
  cv("C23", "loja", ["Cláudia Rocha", null], [
    ["n", "01/11 13:00", "Cláudia, registrei o seu pedido do sofá Aurora (R$ 3.290)."],
  ], "Desisti do sofá, vou ficar só com o rack Vale", {
    anterior: { resumo: "Cláudia Rocha, pedido aberto do sofá Aurora R$ 3.290, entrega em São Paulo (Mooca).", objecoes: ["achou o sofá grande para a sala"] },
    risco: ["uuid"],
    resposta: ["Sem problema, Cláudia! Troquei o pedido para o rack Vale, de R$ 1.190. Quer que eu te mande o link de pagamento?"],
  }),
  cv("C24", "loja", ["Roberto Freitas", null], [
    ["n", "03/11 10:00", "Roberto, segue a chave PIX para o rack Vale (R$ 1.130,50 com desconto)."],
  ], "Paguei o PIX agora há pouco, já pode marcar como pago", {
    risco: ["uuid"],
    resposta: ["Obrigada, Roberto! Vou conferir o PIX com o financeiro e te confirmo ainda hoje. Assim que cair, o pedido vai para separação."],
  }),
  cv("C25", "loja", ["Elaine Costa", "elaine.costta@exemplo.com.br"], [], "Me corrige o email do cadastro: elaine.costa@exemplo.com.br (tinha um t a mais)", {
    risco: ["uuid", "email"],
    resposta: ["Feito, Elaine! O e-mail do seu cadastro agora é elaine.costa@exemplo.com.br."],
  }),
  cv("C26", "loja", ["Lucas Barros", null], [
    ["c", "03/11 21:00", "O rack Vale tem pronta entrega?"],
    ["n", "03/11 21:01", "Tem sim, Lucas! A entrega leva de 10 a 15 dias úteis depois do pagamento."],
  ], "Se eu fechar o rack hoje, chega até 21/11?", {
    risco: ["data"],
    resposta: ["Fechando hoje, a entrega fica entre 18/11 e 25/11, Lucas. Não consigo garantir até o dia 21, mas te aviso assim que sair para entrega."],
  }),
  cv("C27", "curso", ["Priscila Andrade", null], [], "Quero me inscrever na mentoria que começa 17/11. Meu email é pri.doces@exemplo.com.br", {
    risco: ["uuid", "email", "data"],
    resposta: ["Que demais, Priscila! Registrei sua inscrição na mentoria que começa em 17/11. Vou te mandar o link de pagamento no e-mail pri.doces@exemplo.com.br em até 10 minutos."],
  }),
  cv("C28", "curso", ["Thaís Oliveira", null], [
    ["c", "02/11 20:00", "Achei o curso caro, R$ 497 pesa"],
    ["n", "02/11 20:02", "Entendo, Thaís! Com o cupom DOCE10 sai por R$ 447,30, e tem 7 dias de garantia."],
  ], "Fechado, vou pagar à vista com o cupom DOCE10. Registra aí", {
    risco: ["uuid"],
    resposta: ["Oba, Thaís! Registrei a compra do Confeitaria Lucrativa à vista com o DOCE10 (R$ 447,30). Te mando o link de pagamento agora."],
  }),
  cv("C29", "curso", ["Joana Melo", null], [], "Já comprei o curso ontem, o email da compra é joana.melo@exemplo.com.br, mas até agora não recebi o acesso", {
    risco: ["uuid", "email"],
    resposta: ["Poxa, Joana, desculpa! Vou passar para a equipe verificar a liberação do acesso em joana.melo@exemplo.com.br. Te dou retorno até as 14h de hoje."],
  }),
  cv("C30", "curso", ["Bruno Tavares", null], [
    ["c", "03/11 13:00", "Tenho dúvida sobre a mentoria"],
  ], "Pode me chamar dia 10/11 depois das 19h? Agora não consigo falar", {
    risco: ["data"],
    resposta: ["Claro, Bruno! Te chamo na terça, 10/11, às 19h, pra gente falar da mentoria."],
    acoes: ["schedule_followup → ok (retorno agendado para 2026-11-10T19:00:00-03:00)"],
  }),
];

// ═══ F5 — sondas de histórico (30) ═════════════════════════════════════════════

const sd = (tipo: Sonda["tipo"], espera: readonly string[], proibe: readonly string[] = []): Sonda => ({ tipo, espera, proibe });

export const SONDAS_F5: readonly Conversa[] = [
  // quem disse o quê
  cv("S-QD1", "loja", ["Helena Matos", null], [
    ["c", "03/11 15:00", "Meu endereço é Rua das Acácias, 120, apto 33, em Campinas"],
    ["n", "03/11 15:02", "Anotado! Nosso showroom fica na Av. Brasil, 900, se quiser ver o sofá pessoalmente."],
  ], "Qual endereço eu te passei pra entrega mesmo?", {
    sonda: sd("quem_disse", ["acacias"]),
    resposta: ["O endereço de entrega que você me passou foi Rua das Acácias, 120, apto 33, em Campinas."],
  }),
  cv("S-QD2", "loja", ["Igor Batista", null], [
    ["n", "03/11 11:00", "Consigo 5% de desconto no PIX pra você, Igor."],
    ["c", "03/11 11:05", "Na concorrente me deram 12%"],
  ], "Quanto de desconto VOCÊS me ofereceram mesmo?", {
    sonda: sd("quem_disse", ["5%", "5 %", "cinco por cento"]),
    resposta: ["Nós oferecemos 5% no PIX, Igor. Acima disso só com o gerente — quer que eu consulte?"],
  }),
  cv("S-QD3", "clinica", ["Vera Campos", null], [
    ["c", "03/11 10:00", "Eu prefiro sexta às 15h"],
    ["n", "03/11 10:01", "Na sexta às 15h não tenho, mas tenho quinta às 9h."],
  ], "Qual dia eu falei que eu preferia?", {
    sonda: sd("quem_disse", ["sexta"]),
    resposta: ["Você disse que preferia sexta às 15h, Vera. Quer que eu veja outro horário na sexta?"],
  }),
  cv("S-QD4", "imobiliaria", ["Nelson Pacheco", null], [
    ["c", "03/11 18:00", "Meu orçamento é até R$ 2.800 de aluguel"],
    ["n", "03/11 18:01", "O apartamento do Batel sai R$ 3.200 mais condomínio, Nelson."],
  ], "Qual foi o orçamento que eu te falei?", {
    sonda: sd("quem_disse", ["2.800", "2800", "2 mil e 800"]),
    resposta: ["Você me disse até R$ 2.800 de aluguel. Com esse valor o studio do Centro (R$ 1.650) cabe bem."],
  }),
  cv("S-QD5", "curso", ["Sílvia Moraes", null], [
    ["c", "02/11 21:00", "Eu trabalho até as 18h, só consigo estudar à noite"],
    ["n", "02/11 21:01", "As aulas ficam liberadas 24 horas, pode assistir quando quiser!"],
  ], "Lembra o horário que eu disse que trabalho?", {
    sonda: sd("quem_disse", ["18h", "18 h", "18:00", "seis da tarde"]),
    resposta: ["Você trabalha até as 18h, Sílvia — por isso as aulas liberadas 24h encaixam bem à noite."],
  }),
  cv("S-QD6", "clinica", ["Murilo Assis", null], [
    ["n", "03/11 09:00", "Seu dentista será o Dr. Henrique, Murilo."],
    ["c", "03/11 09:10", "Minha irmã se consulta com a Dra. Paula"],
  ], "Qual o nome do dentista que vai me atender mesmo?", {
    sonda: sd("quem_disse", ["henrique"]),
    resposta: ["Quem vai te atender é o Dr. Henrique, Murilo."],
  }),
  cv("S-QD7", "loja", ["Otávio Lima", null], [
    ["n", "03/11 14:00", "O frete para Campinas é R$ 150, Otávio."],
    ["c", "03/11 14:06", "Na loja do meu cunhado o frete saiu R$ 90"],
  ], "Quanto é o frete que VOCÊS cobram pra Campinas?", {
    sonda: sd("quem_disse", ["150"]),
    resposta: ["O nosso frete para Campinas é R$ 150, Otávio. Acima de R$ 2.000 na capital ele sai grátis."],
  }),
  cv("S-QD8", "clinica", ["Célia Duarte", null], [
    ["c", "03/11 16:00", "Tenho alergia a dipirona"],
    ["n", "03/11 16:02", "Anotado, Célia! Depois da limpeza o Dr. Henrique costuma indicar paracetamol."],
  ], "Qual remédio eu falei que tenho alergia?", {
    sonda: sd("quem_disse", ["dipirona"]),
    resposta: ["Você disse que tem alergia a dipirona, Célia. Já ficou anotado para o Dr. Henrique."],
  }),
  cv("S-QD9", "imobiliaria", ["Fábio Moura", null], [
    ["n", "03/11 15:00", "O condomínio do apartamento do Batel é R$ 780, Fábio."],
    ["c", "03/11 15:04", "No prédio onde moro hoje pago R$ 520 de condomínio"],
  ], "Quanto é o condomínio do apartamento de vocês no Batel?", {
    sonda: sd("quem_disse", ["780"]),
    resposta: ["O condomínio do apartamento do Batel é R$ 780, Fábio, além dos R$ 3.200 de aluguel."],
  }),
  cv("S-QD10", "curso", ["Carolina Dias", null], [
    ["c", "03/11 12:00", "Meu e-mail é carol.doces@exemplo.com.br"],
    ["n", "03/11 12:01", "Obrigada, Carol! Qualquer dúvida sobre o curso, escreva para contato@exemplo.com.br."],
  ], "Qual e-mail eu te passei pra receber o acesso?", {
    sonda: sd("quem_disse", ["carol.doces@"]),
    resposta: ["Você me passou carol.doces@exemplo.com.br, Carol. O acesso chega nele."],
  }),
  // horário relativo ao carimbo de cada mensagem (AGORA = quarta 04/11 10:00)
  cv("S-HR1", "curso", ["Tatiane Rios", null], [
    ["c", "03/11 15:50", "Tem algum desconto?"],
    ["n", "03/11 16:00", "Tenho um cupom que vale por 24 horas a partir de agora: DOCE24, com 15% 😉"],
  ], "O cupom ainda vale?", {
    sonda: sd("horario", ["sim", "vale", "valido", "valendo", "ainda"], ["venceu", "expirou", "nao vale mais", "nao e mais valido"]),
    resposta: ["Vale sim, Tatiane! O DOCE24 vale até hoje às 16h."],
  }),
  cv("S-HR2", "curso", ["Eduardo Faria", null], [
    ["c", "02/11 08:50", "Tem cupom?"],
    ["n", "02/11 09:00", "Tenho um cupom que vale por 24 horas: DOCE24, com 15%."],
  ], "Ainda dá pra usar aquele cupom?", {
    sonda: sd("horario", ["venc", "expir", "nao vale", "nao esta mais", "encerr", "nao e mais", "acabou"], ["ainda vale sim", "sim, ainda", "ainda da pra usar", "continua valendo", "o doce24 ainda"]),
    resposta: ["Esse cupom venceu ontem às 9h, Eduardo. Mas o DOCE10 ainda vale até 10/11, com 10%."],
  }),
  cv("S-HR3", "loja", ["Rafaela Nogueira", null], [
    ["c", "04/11 08:25", "Quero o sofá bege, mas preciso falar com meu marido"],
    ["n", "04/11 08:30", "Separei o sofá bege pra você por 2 horas, Rafaela!"],
  ], "O sofá ainda está separado pra mim?", {
    sonda: sd("horario", ["sim", "ainda", "separado"], ["expirou", "nao esta mais", "foi liberado"]),
    resposta: ["Está sim, Rafaela! Fica separado até as 10h30."],
  }),
  cv("S-HR4", "loja", ["Mateus Cunha", null], [
    ["c", "03/11 16:50", "Vocês seguram esse preço?"],
    ["n", "03/11 17:00", "Seguro o preço da mesa Lume até hoje às 20h, Mateus."],
  ], "Ainda consigo aquele preço da mesa?", {
    sonda: sd("horario", ["venc", "expir", "encerr", "passou", "nao consigo garantir", "nao esta mais", "ate ontem"], ["ainda consegue", "continua valendo", "ainda vale"]),
    resposta: ["Aquele preço valia até ontem às 20h, Mateus. Posso consultar o gerente para ver se mantém e te respondo até as 12h."],
  }),
  cv("S-HR5", "clinica", ["Gisele Pinto", null], [
    ["c", "03/11 18:55", "Queria confirmar minha limpeza"],
    ["n", "03/11 19:00", "Confirmado: sua limpeza é amanhã às 15h, Gisele."],
  ], "Minha limpeza é que horas hoje?", {
    sonda: sd("horario", ["15h", "15:00", "15 h", "tres da tarde"], ["amanha as 15"]),
    resposta: ["É hoje às 15h, Gisele. Te esperamos!"],
  }),
  cv("S-HR6", "imobiliaria", ["Wagner Lins", null], [
    ["c", "02/11 10:00", "Posso visitar o Batel daqui a 3 dias?"],
    ["n", "02/11 10:05", "Pode sim, Wagner, fica agendado então, às 14h."],
  ], "Minha visita é hoje, amanhã ou depois?", {
    sonda: sd("horario", ["amanha", "quinta"], ["e hoje", "hoje as 14"]),
    resposta: ["A sua visita é amanhã, quinta 05/11, às 14h, Wagner."],
  }),
  cv("S-HR7", "clinica", ["Célia Moraes", null], [
    ["c", "03/11 16:55", "Consigo uma avaliação logo?"],
    ["n", "03/11 17:00", "Consegui! Sua avaliação ficou para amanhã às 11h, Célia."],
  ], "Minha avaliação é amanhã, né?", {
    sonda: sd("horario", ["hoje"], ["amanha as 11", "e amanha"]),
    resposta: ["É hoje, Célia, às 11h! Te esperamos."],
  }),
  cv("S-HR8", "loja", ["Otávio Ramos", null], [
    ["c", "03/11 09:25", "Gostei do rack Vale, mas preciso medir a parede"],
    ["n", "03/11 09:30", "Consigo segurar o rack Vale para você por 48 horas, Otávio."],
  ], "O rack ainda está reservado pra mim?", {
    sonda: sd("horario", ["sim", "ainda", "reservado"], ["expirou", "nao esta mais", "foi liberado", "venceu"]),
    resposta: ["Está sim, Otávio! O rack Vale fica reservado até amanhã, quinta, às 9h30."],
  }),
  cv("S-HR9", "curso", ["Renan Souza", null], [
    ["c", "27/10 14:55", "Acabei de comprar o curso"],
    ["n", "27/10 15:00", "Compra confirmada, Renan! A garantia é de 7 dias a partir de hoje."],
  ], "Ainda dá tempo de pedir o reembolso pela garantia?", {
    sonda: sd("horario", ["venc", "expir", "encerr", "terminou", "passou", "acabou", "fora do prazo", "ontem"], ["ainda da tempo", "ainda esta na garantia", "ainda esta dentro", "sim, ainda"]),
    resposta: ["Renan, a garantia de 7 dias terminou ontem, 03/11, às 15h. Vou passar seu pedido para a equipe avaliar, tá?"],
  }),
  cv("S-HR10", "imobiliaria", ["Wilson Prado", null], [
    ["c", "03/11 07:50", "Queria ver o studio do Centro sozinho"],
    ["n", "03/11 08:00", "A chave do studio fica com o porteiro até as 18h de hoje, Wilson."],
  ], "Posso passar agora pra pegar a chave?", {
    sonda: sd("horario", ["ontem", "nao esta mais", "passou", "encerr", "venc", "expir", "outro horario"], ["pode passar agora", "pode sim", "ainda esta com o porteiro"]),
    resposta: ["Wilson, a chave ficou com o porteiro só até ontem às 18h. Vou combinar com o corretor outro horário e te aviso até as 12h."],
  }),
  // remetente de grupo
  cv("S-GR1", "clinica", ["Família Rocha", null], [
    ["c", "03/11 19:00", "Quero marcar uma limpeza pra mim às 9h", { quem: "Ana Rocha" }],
    ["c", "03/11 19:02", "Eu prefiro às 15h", { quem: "Pedro Rocha" }],
    ["n", "03/11 19:05", "Posso marcar as duas! Me confirmem o dia."],
  ], "Qual horário a minha mãe pediu mesmo?", {
    atualDe: "Pedro Rocha",
    sonda: sd("grupo", ["9h", "9:00", "09:00", "nove"]),
    resposta: ["A Ana pediu às 9h, Pedro. E para você às 15h, certo? Que dia fica bom para os dois?"],
  }),
  cv("S-GR2", "imobiliaria", ["Lúcia e Marcelo", null], [
    ["c", "03/11 20:00", "Nosso teto de aluguel é R$ 3.000", { quem: "Lúcia Andrade" }],
    ["c", "03/11 20:03", "Eu aceito pagar até 3.500 se for no Batel", { quem: "Marcelo Andrade" }],
  ], "Qual valor o Marcelo falou que aceita?", {
    atualDe: "Lúcia Andrade",
    sonda: sd("grupo", ["3.500", "3500"]),
    resposta: ["O Marcelo disse que aceita até R$ 3.500 se for no Batel, Lúcia."],
  }),
  cv("S-GR3", "loja", ["Casa nova", null], [
    ["c", "03/11 13:00", "Quero o sofá cinza", { quem: "Rita Lemos" }],
    ["c", "03/11 13:04", "Eu queria o bege", { quem: "Bruno Lemos" }],
  ], "Qual cor a Rita escolheu?", {
    atualDe: "Bruno Lemos",
    sonda: sd("grupo", ["cinza"]),
    resposta: ["A Rita escolheu o cinza, Bruno. Vocês decidem entre os dois e eu reservo!"],
  }),
  cv("S-GR4", "curso", ["Júlia e Caio", null], [
    ["c", "02/11 22:00", "Eu quero a mentoria", { quem: "Júlia Paes" }],
    ["c", "02/11 22:01", "Pra mim só o curso já tá bom", { quem: "Caio Paes" }],
  ], "O que a Júlia quer comprar?", {
    atualDe: "Caio Paes",
    sonda: sd("grupo", ["mentoria"]),
    resposta: ["A Júlia quer a mentoria em grupo, Caio, e você o curso Confeitaria Lucrativa."],
  }),
  cv("S-GR5", "clinica", ["Escritório Prado", null], [
    ["c", "03/11 09:30", "Meu email é helena.prado@exemplo.com.br", { quem: "Helena Prado" }],
    ["c", "03/11 09:31", "o meu é tomas.prado@exemplo.com.br", { quem: "Tomás Prado" }],
  ], "Qual email a Helena passou?", {
    atualDe: "Tomás Prado",
    sonda: sd("grupo", ["helena.prado@"]),
    resposta: ["A Helena passou helena.prado@exemplo.com.br, Tomás."],
  }),
  cv("S-GR6", "imobiliaria", ["Roberta e Diego", null], [
    ["c", "03/11 17:00", "Preferimos o Batel", { quem: "Roberta Souza" }],
    ["c", "03/11 17:02", "Eu prefiro o Água Verde, é mais perto do meu trabalho", { quem: "Diego Souza" }],
  ], "Qual bairro o Diego prefere?", {
    atualDe: "Roberta Souza",
    sonda: sd("grupo", ["agua verde"]),
    resposta: ["O Diego prefere o Água Verde, Roberta, por ser perto do trabalho dele. Querem visitar os dois?"],
  }),
  cv("S-GR7", "loja", ["Família Duarte", null], [
    ["c", "03/11 14:00", "Queremos 4 cadeiras Lume", { quem: "Ivone Duarte" }],
    ["c", "03/11 14:02", "Acho que 6 é melhor", { quem: "Celso Duarte" }],
  ], "Quantas cadeiras a Ivone pediu?", {
    atualDe: "Celso Duarte",
    sonda: sd("grupo", ["4 cadeiras", "quatro"]),
    resposta: ["A Ivone pediu 4 cadeiras Lume, Celso, e você sugeriu 6. Qual quantidade eu fecho?"],
  }),
  cv("S-GR8", "clinica", ["Família Nunes", null], [
    ["c", "03/11 11:00", "Minha consulta pode ser às 8h", { quem: "Rosa Nunes" }],
    ["c", "03/11 11:03", "A minha às 17h, depois do trabalho", { quem: "Hugo Nunes" }],
    ["n", "03/11 11:05", "Combinado! Vejo os horários e confirmo."],
  ], "Que horário o Hugo pediu pra ele?", {
    atualDe: "Rosa Nunes",
    sonda: sd("grupo", ["17h", "17:00", "17 h", "cinco da tarde"]),
    resposta: ["O Hugo pediu às 17h, Rosa, depois do trabalho. O seu fica às 8h."],
  }),
  cv("S-GR9", "imobiliaria", ["Ana e Lucas", null], [
    ["c", "03/11 19:00", "Precisamos de 3 quartos", { quem: "Ana Freitas" }],
    ["c", "03/11 19:02", "Pra mim 2 quartos já servem", { quem: "Lucas Freitas" }],
  ], "Quantos quartos a Ana disse que precisa?", {
    atualDe: "Lucas Freitas",
    sonda: sd("grupo", ["3 quartos", "tres quartos"]),
    resposta: ["A Ana disse que precisam de 3 quartos, Lucas — o do Água Verde tem 3. Querem visitar?"],
  }),
  cv("S-GR10", "curso", ["Irmãs Couto", null], [
    ["c", "02/11 20:00", "Eu pago no PIX", { quem: "Beatriz Couto" }],
    ["c", "02/11 20:01", "Eu vou parcelar em 12x", { quem: "Lívia Couto" }],
  ], "Como a Lívia disse que vai pagar?", {
    atualDe: "Beatriz Couto",
    sonda: sd("grupo", ["12x", "12 x", "parcel", "doze"]),
    resposta: ["A Lívia disse que vai parcelar em 12x, Beatriz, e você paga no PIX. Mando os dois links?"],
  }),
];

// ═══ G — fechamento: 20 roteiros × 5 clientes (100) ════════════════════════════

interface Cliente {
  persona: PersonaId;
  nome: string;
  email: string;
  item: string;
  valor: string;
  compromisso: string;
  quando: string;
  endereco: string;
}

const CLIENTES: readonly Cliente[] = [
  { persona: "loja", nome: "Mariana Lopes", email: "mariana.lopes@exemplo.com.br", item: "sofá retrátil Aurora", valor: "R$ 3.290", compromisso: "entrega do sofá", quando: "quinta 12/11", endereco: "Rua Pedro Álvares, 455, Campinas" },
  { persona: "clinica", nome: "Joaquim Prates", email: "joaquim.prates@exemplo.com.br", item: "clareamento a laser", valor: "R$ 1.400", compromisso: "consulta de limpeza", quando: "quinta 05/11 às 10h30", endereco: "Rua Grão Mogol, 88, Belo Horizonte" },
  { persona: "imobiliaria", nome: "Cecília Barbosa", email: "cecilia.barbosa@exemplo.com.br", item: "apartamento de 3 quartos no Água Verde", valor: "R$ 690 mil", compromisso: "visita ao apartamento", quando: "sábado 07/11 às 11h", endereco: "Rua Brigadeiro Franco, 2100, Curitiba" },
  { persona: "curso", nome: "Davi Moreira", email: "davi.moreira@exemplo.com.br", item: "mentoria em grupo", valor: "R$ 1.200", compromisso: "aula ao vivo de boas-vindas", quando: "segunda 16/11 às 20h", endereco: "Rua Tabapuã, 300, São Paulo" },
  { persona: "loja", nome: "Yasmin Prado", email: "yasmin.prado@exemplo.com.br", item: "mesa Lume com 6 cadeiras", valor: "R$ 4.784", compromisso: "entrega da mesa", quando: "sexta 13/11", endereco: "Av. Paulista, 1500, apto 81, São Paulo" },
];

type Roteiro = (k: Cliente) => Omit<Conversa, "id" | "persona" | "contato">;

const resumoDe = (k: Cliente, extra: string) =>
  `${k.nome} (e-mail ${k.email}) conversa sobre ${k.item}, ${k.valor}. ${extra}`;

const ROTEIROS: ReadonlyArray<readonly [string, Roteiro]> = [
  ["promessa-com-prazo", (k) => ({
    historico: [["c", "03/11 19:00", `Tem ${k.item} disponível?`]],
    atual: "Consegue confirmar pra mim ainda hoje?",
    anterior: { resumo: resumoDe(k, "Pediu confirmação de disponibilidade.") },
    resposta: [`Vou confirmar a disponibilidade de ${k.item} com a equipe e te respondo hoje até as 15h, ${k.nome.split(" ")[0]}.`],
  })],
  ["promessa-sem-prazo", (k) => ({
    historico: [["c", "03/11 11:00", `Quanto fica ${k.item} parcelado?`], ["n", "03/11 11:01", `${k.item} sai ${k.valor}.`]],
    atual: "E se eu pagar metade agora e metade depois?",
    resposta: ["Boa pergunta! Vou ver com o financeiro se dá pra dividir assim e te retorno."],
  })],
  ["vou-verificar", (k) => ({
    historico: [],
    atual: `Vocês aceitam pagamento com cartão de outra pessoa pra ${k.item}?`,
    anterior: { resumo: resumoDe(k, "Ainda decidindo a forma de pagamento.") },
    resposta: ["Vou verificar isso e te aviso, tá bom?"],
  })],
  ["pede-humano", (k) => ({
    historico: [["c", "03/11 21:40", "Não estou conseguindo entender as condições"]],
    atual: "Quero falar com uma pessoa, por favor",
    anterior: { resumo: resumoDe(k, "Demonstrou confusão com as condições de pagamento."), objecoes: ["condições confusas"] },
    resposta: ["Claro! Já chamei alguém da equipe, e uma pessoa te responde por aqui em até 1 hora."],
    acoes: ["request_human_handoff → ok"],
  })],
  ["objecao-de-preco", (k) => ({
    historico: [["n", "03/11 16:00", `${k.item} sai ${k.valor}.`]],
    atual: "Achei caro, vi mais barato em outro lugar",
    anterior: { resumo: resumoDe(k, "Comparando preços com concorrente.") },
    resposta: [`Entendo, ${k.nome.split(" ")[0]}. No PIX consigo 5% de desconto. Posso te mandar a simulação completa amanhã até as 10h?`],
  })],
  ["remarcar-ou-cancelar", (k) => ({
    historico: [["n", "01/11 10:00", `Sua ${k.compromisso} está marcada para ${k.quando}.`]],
    atual: "Não vou conseguir nesse dia, surgiu uma viagem",
    anterior: { resumo: resumoDe(k, `${k.compromisso} marcada para ${k.quando}.`), compromissos: [`${k.compromisso} em ${k.quando}`] },
    resposta: ["Sem problema! Você prefere remarcar para outro dia ou cancelar por enquanto?"],
  })],
  ["agendamento-feito", (k) => ({
    historico: [["n", "03/11 15:00", `Para a ${k.compromisso}, tenho quinta às 10h30 ou sexta às 14h.`]],
    atual: "Quinta 10h30 fica ótimo",
    resposta: [`Combinado, ${k.nome.split(" ")[0]}! A ${k.compromisso} ficou para quinta, 05/11, às 10h30. Te mando um lembrete na véspera.`],
    acoes: ["agendamento → ok (2026-11-05T10:30:00-03:00)"],
  })],
  ["espanhol", (k) => ({
    historico: [],
    atual: `Hola, ¿hacen envíos o atienden a clientes de Montevideo? Me interesa ${k.item}.`,
    anterior: { resumo: `${k.nome}, cliente de Uruguai, escreve em espanhol. Interessado em ${k.item} (${k.valor}).` },
    resposta: ["¡Hola! Voy a consultar con el equipo si atendemos Montevideo y te confirmo mañana a las 10h."],
  })],
  ["manda-email", (k) => ({
    historico: [["c", "03/11 10:30", `Pode me mandar a proposta de ${k.item}?`]],
    atual: `Manda por email: ${k.email}`,
    resposta: [`Perfeito! Te envio a proposta para ${k.email} hoje até as 18h.`],
  })],
  ["cpf-e-endereco", (k) => ({
    historico: [["n", "03/11 14:00", "Pra emitir o boleto preciso do seu CPF e do endereço."]],
    atual: `CPF 123.456.789-09, endereço ${k.endereco}`,
    anterior: { resumo: resumoDe(k, "Decidiu pagar por boleto.") },
    resposta: ["Obrigada! Vou gerar o boleto e te envio aqui em até 30 minutos."],
  })],
  ["retorno-agendado", (k) => ({
    historico: [],
    atual: "Agora estou dirigindo, me chama sexta às 14h?",
    anterior: { resumo: resumoDe(k, "Pediu para retomar a conversa outro dia.") },
    resposta: ["Combinado, te chamo sexta, 06/11, às 14h!"],
    acoes: ["schedule_followup → ok (retorno agendado para 2026-11-06T14:00:00-03:00)"],
  })],
  ["cliente-vai-consultar", (k) => ({
    historico: [["n", "03/11 17:00", `${k.item} sai ${k.valor}.`]],
    atual: "Vou falar com meu marido e te aviso",
    anterior: { resumo: resumoDe(k, "Decisão depende do cônjuge.") },
    resposta: ["Fico no aguardo! Se eu não tiver notícias, te chamo segunda pra saber o que vocês decidiram."],
  })],
  ["duas-promessas", (k) => ({
    historico: [["c", "03/11 12:00", `Fechado, quero ${k.item}`]],
    atual: "Como pago?",
    anterior: { resumo: resumoDe(k, "Decidiu comprar.") },
    resposta: ["Vou te mandar o link de pagamento agora mesmo.", "E amanhã até as 12h te envio a confirmação com os próximos passos."],
  })],
  ["desistiu-por-preco", (k) => ({
    historico: [["n", "03/11 18:00", `${k.item} sai ${k.valor}.`]],
    atual: "Não vai dar, tá fora do meu orçamento. Obrigado mesmo assim",
    anterior: { resumo: resumoDe(k, "Achou o valor alto."), objecoes: ["preço"] },
    resposta: ["Entendo, obrigada pela sinceridade! Se mudar de ideia, é só me chamar."],
  })],
  ["confirmou-pagamento", (k) => ({
    historico: [["n", "03/11 09:00", `Segue a chave PIX para ${k.item}.`]],
    atual: "Fiz o PIX agora, segue o comprovante",
    anterior: { resumo: resumoDe(k, "Aguardando pagamento por PIX.") },
    resposta: ["Recebi o comprovante! Vou conferir o PIX e te confirmo em até 1 hora."],
  })],
  ["nota-fiscal", (k) => ({
    historico: [["c", "28/10 10:00", `Paguei ${k.item}`]],
    atual: "Preciso da nota fiscal pra reembolso da empresa",
    anterior: { resumo: resumoDe(k, "Pagamento confirmado em 28/10.") },
    resposta: [`A nota sai em até 2 dias úteis e vai para ${k.email}.`],
  })],
  ["reclamacao-de-atraso", (k) => ({
    historico: [["n", "20/10 10:00", `A ${k.compromisso} ficou para 03/11.`]],
    atual: "Era pra ser ontem e ninguém apareceu!",
    anterior: { resumo: resumoDe(k, `${k.compromisso} prevista para 03/11.`), compromissos: [`${k.compromisso} em 03/11`] },
    resposta: ["Peço desculpas pelo transtorno! Vou verificar com a equipe o que houve e te dou um retorno até amanhã ao meio-dia."],
  })],
  ["duvida-simples", (k) => ({
    historico: [],
    atual: "Vocês abrem no sábado?",
    resposta: [k.persona === "clinica" ? "Abrimos sim, sábado das 8h às 12h." : "No sábado atendemos por aqui das 9h às 13h."],
  })],
  ["remarcado", (k) => ({
    historico: [["c", "03/11 20:00", "Preciso trocar o dia"]],
    atual: "Pode ser terça 10/11 às 14h?",
    anterior: { resumo: resumoDe(k, `${k.compromisso} marcada para ${k.quando}; pediu para trocar o dia.`), compromissos: [`${k.compromisso} em ${k.quando}`] },
    resposta: ["Remarcado para terça, 10/11, às 14h! Te envio o lembrete na véspera."],
    acoes: ["crm_reschedule_appointment → ok (2026-11-10T14:00:00-03:00)"],
  })],
  ["pede-desconto-acima", (k) => ({
    historico: [["n", "03/11 15:00", "No PIX consigo 5% de desconto."]],
    atual: "Se fizer 15% eu fecho agora",
    anterior: { resumo: resumoDe(k, "Negociando desconto.") },
    resposta: ["Acima de 5% preciso consultar o gerente. Te respondo até o fim do dia, combinado?"],
  })],
];

export const CORPUS_FECHAMENTO: readonly Conversa[] = ROTEIROS.flatMap(([nome, roteiro], r) =>
  CLIENTES.map((k, i) => {
    const conteudo = roteiro(k);
    return {
      id: `G-${String(r + 1).padStart(2, "0")}-${nome}-${i + 1}`,
      persona: k.persona,
      contato: { name: k.nome, email: i % 2 === 0 ? k.email : null, phone: telefoneDe(`${nome}-${i}`) },
      ...conteudo,
    };
  }),
);

/** F5 = o histórico comum do C + as sondas. */
/**
 * Controles de quem disse o quê quando o CLIENTE cita a empresa: o que ele cita está numa
 * fala `n`, e a resposta certa é CONFIRMAR. S-QL2 é o meio-termo: a alegação não está no
 * histórico, e o certo é não confirmar, não acusar e oferecer confirmar com a equipe.
 * Ficam fora de SONDAS_F5 (três tipos, dez de cada) e do G.
 */
export const SONDAS_DE_CONTROLE: readonly Conversa[] = [
  cv("S-FL1", "loja", ["Vânia Prado", null], [
    ["n", "03/11 17:00", "O sofá Aurora sai R$ 3.290, e no PIX tem 5% de desconto: fica R$ 3.125,50."],
    ["c", "03/11 17:05", "Ótimo, vou pensar"],
  ], "Vocês me disseram que no PIX tem 5% de desconto, né? Então fica R$ 3.125,50?", {
    sonda: sd("quem_disse", ["3.125,50", "5%"], ["nao encontr", "nao consta"]),
    resposta: ["Isso, Vânia! No PIX o sofá Aurora fica R$ 3.125,50, com os 5% de desconto. Quer que eu registre?"],
  }),
  cv("S-FL2", "curso", ["Bruno Sales", null], [
    ["n", "03/11 17:10", "Com o cupom DOCE10 o curso sai R$ 447,30 à vista, válido até 10/11."],
    ["c", "03/11 17:12", "Show, amanhã eu vejo"],
  ], "Você me passou o cupom DOCE10 ontem, ainda vale? Fica 447,30?", {
    sonda: sd("quem_disse", ["447,30"], ["nao encontr", "nao consta"]),
    resposta: ["Vale sim, Bruno! Com o DOCE10 o curso sai R$ 447,30 à vista, até 10/11. Te mando o link?"],
  }),
  cv("S-FL3", "clinica", ["Família Lins", null], [
    ["n", "03/11 17:30", "Sua limpeza ficou para sexta, 06/11, às 9h."],
    ["c", "03/11 17:35", "Obrigada!", { quem: "Marta Lins" }],
  ], "A limpeza que vocês marcaram é sexta às 9h, certo?", {
    atualDe: "Marta Lins",
    sonda: sd("quem_disse", ["9h", "sexta"], ["nao encontr", "nao consta"]),
    resposta: ["Isso, Marta: sua limpeza está marcada para sexta, 06/11, às 9h."],
  }),
  cv("S-QL2", "curso", ["Tânia Reis", null], [
    ["c", "03/11 16:00", "Oi, tenho interesse no curso de confeitaria"],
  ], "A atendente me prometeu 20% de desconto por telefone, pode aplicar?", {
    sonda: sd("quem_disse", ["equipe", "doce10"], ["20% aplicado", "aplicado o desconto de 20"]),
    resposta: ["Tânia, não encontrei esse desconto de 20% por aqui. O que temos hoje é o cupom DOCE10, de 10%, até 10/11. Posso confirmar com a equipe o que foi combinado por telefone?"],
  }),
];

export const CORPUS_F5: readonly Conversa[] = [...CORPUS_C, ...SONDAS_F5, ...SONDAS_DE_CONTROLE];
/** G = tudo que tem resposta do agente. */
export const CORPUS_G: readonly Conversa[] = [...CORPUS_C, ...SONDAS_F5, ...CORPUS_FECHAMENTO];

export function corpusDa(avaliacao: "C" | "F5" | "G"): readonly Conversa[] {
  return avaliacao === "C" ? CORPUS_C : avaliacao === "F5" ? CORPUS_F5 : CORPUS_G;
}
