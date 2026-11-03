import { z } from "zod";

/**
 * O COLD CALL: uma fila de ligações sobre um funil comum do CRM.
 *
 * Nada de tabela nova. O funil de cold call é um funil como os outros, marcado em
 * `crm_pipelines.settings.cold_call`, e é lá que mora o roteiro. Cada resultado vira
 * uma mudança de etapa (ou um encerramento) e uma linha na timeline do lead. Assim o
 * quadro, as métricas e a importação de planilha continuam valendo sem nada a mais.
 *
 * A ligação em si ainda não sai daqui: sem tronco SIP, a tela só abre o discador do aparelho.
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

export const ROTEIRO_PADRAO = `# Abertura
- É da [nome do negócio]?
- Meu nome é [seu nome], da [sua empresa]. Sei que liguei do nada. Me dá 30 segundos e aí você decide se continua?

# Se a pessoa deixar
- [Resposta positiva] A gente coloca um atendente de IA no WhatsApp da empresa, que responde na hora e agenda sozinho. Hoje, quando chega mensagem fora do horário, quem responde aí?
- [Resposta positiva] Faz sentido a gente marcar 30 minutinhos pelo Google Meet pra eu te mostrar funcionando? Qual dia fica bom pra você?
- [Agendou] Confirmar nome e e-mail para enviar o convite.

# Se a pessoa travar
- [Sem tempo] Sem problema. Qual o melhor horário pra eu te ligar de novo?
- [Já tenho] Boa. E ele responde de madrugada e no fim de semana?
- [Manda por WhatsApp] Mando sim. Esse número aqui é o seu WhatsApp?
- [Não é o responsável] Quem cuida disso aí? Pode me passar o nome e o melhor horário?`;

export type LinhaDoRoteiro =
  | { tipo: "titulo"; texto: string }
  | { tipo: "fala"; marca: string | null; texto: string };

/** O texto vira linhas para a tela, com o nome do lead no lugar da lacuna. Nunca vira HTML. */
export function linhasDoRoteiro(roteiro: string, dados: { negocio: string; quemLiga: string; suaEmpresa?: string }): LinhaDoRoteiro[] {
  const preenchido = roteiro
    .replace(/\[sua empresa\]/gi, () => dados.suaEmpresa ?? "")
    // `$` no nome do lead é texto: a função impede o `replace` de ler como padrão.
    .replace(/\[(?:nome d[ao] )?(?:neg[oó]cio|empresa|lead|cliente)\]/gi, () => dados.negocio)
    .replace(/\[(?:seu nome|meu nome|nome de quem liga)\]/gi, () => dados.quemLiga)
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
): "crm" | "discador" | "indefinido" {
  if (!voz) return "indefinido";
  return voz.configured && voz.paired && contatoId ? "crm" : "discador";
}
