import { z } from "zod";

/**
 * O COLD CALL: uma fila de ligações sobre um funil comum do CRM.
 *
 * Nada de tabela nova. O funil de cold call é um funil como os outros, marcado em
 * `crm_pipelines.settings.cold_call`, e é lá que mora o roteiro. Cada resultado vira
 * uma mudança de etapa (ou um encerramento) e uma linha na timeline do lead. Assim o
 * quadro, as métricas e a importação de planilha continuam valendo sem nada a mais.
 *
 * A ligação sai pelo canal de voz do CRM quando ele está pareado, e pelo discador do aparelho
 * (`tel:`) quando não está (`caminhoDaLigacao`). Nos DOIS caminhos vale a regra da rota de voz
 * (`app/api/v1/voice/calls/route.ts`): quem pediu para não ser incomodado, o contato pessoal e o
 * anonimizado não recebem ligação (`motivoParaNaoLigar`).
 *
 * É módulo opcional da instalação, desligado por padrão (`cold_call` em `lib/instalacao/modulos.ts`).
 */
export const ETAPAS_DO_COLD_CALL = [
  { slug: "na-fila", name: "Na fila", is_won: false, is_lost: false },
  { slug: "nao-atendeu", name: "Não atendeu", is_won: false, is_lost: false },
  { slug: "caixa-postal", name: "Caixa postal", is_won: false, is_lost: false },
  { slug: "follow-up", name: "Follow-up", is_won: false, is_lost: false },
  { slug: "reuniao-pedida", name: "Reunião pedida", is_won: false, is_lost: false },
  { slug: "ganho", name: "Ganho", is_won: true, is_lost: false },
  { slug: "perdido", name: "Perdido", is_won: false, is_lost: true },
] as const;

/** Etapas que voltam a tocar: quem não atendeu continua na fila, depois de quem nunca foi tentado. */
export const ETAPAS_DA_FILA: readonly string[] = ["na-fila", "nao-atendeu", "caixa-postal"];

export const RESULTADOS = {
  nao_atendeu: { rotulo: "Não atendeu", etapa: "nao-atendeu" },
  caixa_postal: { rotulo: "Caixa postal", etapa: "caixa-postal" },
  follow_up: { rotulo: "Follow-up", etapa: "follow-up" },
  reuniao: { rotulo: "Pediu reunião", etapa: "reuniao-pedida" },
  sem_interesse: { rotulo: "Não tem interesse", perde: true },
  numero_errado: { rotulo: "Número errado", perde: true },
  removido: { rotulo: "Tirado da fila", perde: true },
} as const;

export type ResultadoDaLigacao = keyof typeof RESULTADOS;

/**
 * O rótulo de cada resultado que encerra o lead é o motivo da perda gravado. O banco só aceita
 * motivo canônico ou listado em `settings.lost_reasons` do funil
 * (`fn_validate_lost_reason_required`), então o funil precisa listar estes.
 */
export const MOTIVOS_DE_PERDA_DO_COLD_CALL: readonly string[] = Object.values(RESULTADOS).flatMap((r) =>
  "perde" in r ? [r.rotulo] : [],
);

/**
 * `settings` com os motivos do Cold Call que faltam acrescentados ao fim de `lost_reasons`, ou
 * `null` se nenhum falta. O que já está na lista fica como está, texto ou `{ label }`.
 */
export function comMotivosDoColdCall(settings: unknown): Record<string, unknown> | null {
  const base =
    settings && typeof settings === "object" && !Array.isArray(settings) ? (settings as Record<string, unknown>) : {};
  const atuais: unknown[] = Array.isArray(base.lost_reasons) ? base.lost_reasons : [];
  const rotulos = new Set(atuais.map((e) => (typeof e === "string" ? e : (e as { label?: unknown } | null)?.label)));
  const faltam = MOTIVOS_DE_PERDA_DO_COLD_CALL.filter((m) => !rotulos.has(m));
  return faltam.length ? { ...base, lost_reasons: [...atuais, ...faltam] } : null;
}

/** O que aparece como botão depois da ligação. "Tirado da fila" é gesto da lista, não resultado de ligação. */
export const RESULTADOS_DA_LIGACAO: readonly ResultadoDaLigacao[] = [
  "nao_atendeu",
  "caixa_postal",
  "follow_up",
  "reuniao",
  "sem_interesse",
  "numero_errado",
];

export const resultadoSchema = z.object({
  lead_id: z.string().uuid(),
  resultado: z.enum(Object.keys(RESULTADOS) as [ResultadoDaLigacao, ...ResultadoDaLigacao[]]),
  nota: z.string().trim().max(1000).optional(),
});

export const roteiroSchema = z.object({ roteiro: z.string().trim().min(1).max(10_000) });

const configSchema = z.object({ ativo: z.literal(true), roteiro: z.string().default("") });

/** A leitura de `settings.cold_call`, num lugar só. Funil sem a marca devolve `null`. */
export function configDoFunil(settings: unknown): { roteiro: string } | null {
  const bruto = (settings as { cold_call?: unknown } | null)?.cold_call;
  const lido = configSchema.safeParse(bruto);
  return lido.success ? { roteiro: lido.data.roteiro } : null;
}

/**
 * O roteiro com que o funil nasce. Neutro de propósito: vai para toda instalação, de qualquer
 * nicho, então não vende produto nenhum. As lacunas entre colchetes são preenchidas na ligação
 * (`linhasDoRoteiro`); `[o que você oferece]` fica para quem edita o roteiro.
 */
const ROTEIROS_PADRAO: Record<"pt" | "es" | "en", string> = {
  pt: `# Abertura
- Olá, falo com alguém da [nome do lead]?
- Meu nome é [seu nome], da [sua empresa]. Sei que a ligação não estava marcada. Posso usar 30 segundos para contar o motivo, e aí você decide se seguimos?

# Se a pessoa deixar
- [Resposta positiva] Eu ligo porque trabalhamos com [o que você oferece]. Hoje, como vocês resolvem isso aí?
- [Interesse] Faz sentido marcarmos uma conversa rápida para eu explicar com calma? Qual dia fica bom?
- [Agendou] Confirmar nome, e-mail e horário para mandar o convite.

# Se a pessoa travar
- [Sem tempo] Sem problema. Qual o melhor horário para eu ligar de novo?
- [Já tenho] Entendi. O que faria vocês olharem outra opção?
- [Manda por mensagem] Mando, sim. Este número é o melhor para isso?
- [Não é o responsável] Quem cuida disso aí? Pode me passar o nome e o melhor horário?`,
  es: `# Apertura
- Hola, ¿hablo con alguien de [nombre del lead]?
- Mi nombre es [tu nombre], de [tu empresa]. Sé que la llamada no estaba agendada. ¿Me das 30 segundos para contarte el motivo y luego decides si seguimos?

# Si la persona lo permite
- [Respuesta positiva] Te llamo porque trabajamos con [lo que ofreces]. Hoy, ¿cómo lo resuelven ustedes?
- [Interés] ¿Tiene sentido agendar una conversación corta para explicarlo con calma? ¿Qué día te queda bien?
- [Agendó] Confirmar nombre, correo y horario para enviar la invitación.

# Si la persona se traba
- [Sin tiempo] No hay problema. ¿Cuál es el mejor horario para volver a llamarte?
- [Ya tengo] Entiendo. ¿Qué haría que miren otra opción?
- [Mándalo por mensaje] Sí, te lo mando. ¿Este número es el mejor para eso?
- [No es el responsable] ¿Quién se encarga de eso? ¿Me pasas el nombre y el mejor horario?`,
  en: `# Opening
- Hi, am I speaking with someone from [lead name]?
- My name is [your name], from [your company]. I know this call wasn't scheduled. Can I take 30 seconds to tell you why I'm calling, and then you decide if we go on?

# If they let you continue
- [Positive answer] I'm calling because we work with [what you offer]. How do you handle that today?
- [Interested] Would it make sense to book a short call so I can walk you through it? Which day works for you?
- [Booked] Confirm name, email and time to send the invite.

# If they push back
- [No time] No problem. When is a better time to call you back?
- [Already have one] Got it. What would make you look at another option?
- [Send it by message] Sure, I'll send it. Is this number the best one for that?
- [Not the decision maker] Who takes care of that? Could you give me their name and the best time to reach them?`,
};

/**
 * O roteiro inicial no idioma de quem cria o funil; o que não for espanhol nem inglês sai em
 * português. `string`, e não `Idioma`: o inglês ainda está em construção e não entra no tipo,
 * mas o roteiro dele já fica pronto para quando entrar.
 */
export function roteiroPadrao(idioma: string): string {
  return idioma === "es" ? ROTEIROS_PADRAO.es : idioma === "en" ? ROTEIROS_PADRAO.en : ROTEIROS_PADRAO.pt;
}

export type LinhaDoRoteiro =
  | { tipo: "titulo"; texto: string }
  | { tipo: "fala"; marca: string | null; texto: string };

/** O texto vira linhas para a tela, com o nome do lead no lugar da lacuna. Nunca vira HTML. */
export function linhasDoRoteiro(roteiro: string, dados: { negocio: string; quemLiga: string; suaEmpresa?: string }): LinhaDoRoteiro[] {
  const preenchido = roteiro
    .replace(/\[(?:sua empresa|tu empresa|your company)\]/gi, () => dados.suaEmpresa ?? "")
    // `$` no nome do lead é texto: a função impede o `replace` de ler como padrão.
    .replace(/\[(?:nome d[ao] )?(?:neg[oó]cio|empresa|lead|cliente)\]/gi, () => dados.negocio)
    .replace(/\[(?:nombre del? )?(?:negocio|empresa|lead|cliente)\]/gi, () => dados.negocio)
    .replace(/\[(?:lead|client|business|company)(?: name)?\]/gi, () => dados.negocio)
    .replace(/\[(?:seu nome|meu nome|nome de quem liga|tu nombre|mi nombre|your name|my name)\]/gi, () => dados.quemLiga)
    // O negrito colado de outro lugar: a tela mostra texto puro, e os asteriscos sobravam.
    .replace(/\*\*(.+?)\*\*/g, "$1");
  const linhas: LinhaDoRoteiro[] = [];
  for (const crua of preenchido.split("\n")) {
    const linha = crua.trim();
    if (!linha) continue;
    if (linha.startsWith("#")) {
      linhas.push({ tipo: "titulo", texto: linha.replace(/^#+\s*/, "") });
      continue;
    }
    const semMarcador = linha.replace(/^[-•]\s*/, "");
    const marca = semMarcador.match(/^\[([^\]]+)\]\s*/);
    linhas.push({
      tipo: "fala",
      marca: marca ? marca[1]! : null,
      texto: marca ? semMarcador.slice(marca[0].length) : semMarcador,
    });
  }
  return linhas;
}

export interface LeadDaFila {
  id: string;
  etapa: string;
  tentativas: number;
  ultima_tentativa_em: string | null;
  criado_em: string;
}

/**
 * Quem liga primeiro: quem nunca foi tentado, por ordem de chegada; depois quem foi
 * tentado há mais tempo. Etapas fora da fila (follow-up, reunião) não entram.
 */
export function ordenarFila<T extends LeadDaFila>(leads: readonly T[]): T[] {
  return leads
    .filter((l) => ETAPAS_DA_FILA.includes(l.etapa))
    .sort((a, b) => {
      if (a.tentativas !== b.tentativas) return a.tentativas - b.tentativas;
      const quando = (l: T) => l.ultima_tentativa_em ?? l.criado_em;
      return quando(a).localeCompare(quando(b));
    });
}

/** Motivos que, numa ligação não atendida, querem dizer que o outro lado barrou a chamada. */
const MOTIVOS_DE_RECUSA: readonly string[] = ["user_ended", "declined", "rejected", "busy", "do_not_disturb"];

export type ComoTerminou = "recusada" | "sem_resposta" | "encerrada";

/**
 * Como a ligação terminou, para o som e o aviso. Medido em produção: quando o lead recusa, o
 * WhatsApp avisa `user_ended`, o mesmo motivo de quando se desliga daqui. O que separa os dois
 * é quem encerrou e se chegou a ser atendida.
 */
export function comoTerminou(fim: { end_reason: string | null; atendida: boolean; porMim: boolean }): ComoTerminou {
  if (fim.porMim || fim.atendida) return "encerrada";
  if (fim.end_reason === "timeout") return "sem_resposta";
  return MOTIVOS_DE_RECUSA.includes(fim.end_reason ?? "") ? "recusada" : "encerrada";
}

/**
 * Por onde a ligação sai. O discador do aparelho é só para quando se SABE que não há canal de
 * voz: status que não voltou é `indefinido`, e tratá-lo como "sem voz" abria o discador do
 * computador com o chip conectado.
 */
export function caminhoDaLigacao(
  voz: { configured: boolean; paired: boolean } | null | undefined,
  contatoId: string | null | undefined,
  naoLigar: MotivoParaNaoLigar | null = null,
): "crm" | "discador" | "indefinido" | "nao-ligar" {
  // Antes de qualquer canal: o discador do aparelho não passa pela rota de voz, e é aqui que
  // ele aprende a mesma recusa que ela dá.
  if (naoLigar) return "nao-ligar";
  if (!voz) return "indefinido";
  return voz.configured && voz.paired && contatoId ? "crm" : "discador";
}

/**
 * Por que este contato NÃO recebe ligação — a regra de `app/api/v1/voice/calls/route.ts`
 * (403 para bloqueado e pessoal, 422 para anonimizado), num lugar que a fila, o botão Ligar,
 * o discador `tel:` e a rota de resultado leem igual. `null` = pode ligar.
 */
export type MotivoParaNaoLigar = "bloqueado" | "pessoal" | "anonimizado";

export function motivoParaNaoLigar(
  contato: { is_blocked?: boolean | null; is_personal?: boolean | null; is_anonymized?: boolean | null } | null | undefined,
): MotivoParaNaoLigar | null {
  if (contato?.is_blocked) return "bloqueado";
  if (contato?.is_personal) return "pessoal";
  if (contato?.is_anonymized) return "anonimizado";
  return null;
}

/**
 * Resultado de LIGAÇÃO só existe para quem pode receber ligação. A rota de resultado e a tela
 * (seletor, atalhos e Salvar) leem esta mesma resposta. "Tirado da fila" não é resultado de
 * ligação e não passa por aqui.
 */
export function aceitaResultadoDaLigacao(naoLigar: MotivoParaNaoLigar | null | undefined): boolean {
  return !naoLigar;
}

/** O motivo como a tela o escreve (chave de `t()`). */
export const ROTULO_DE_NAO_LIGAR: Record<MotivoParaNaoLigar, string> = {
  bloqueado: "Pediu para não ser incomodado",
  pessoal: "Contato pessoal",
  anonimizado: "Contato anonimizado",
};
