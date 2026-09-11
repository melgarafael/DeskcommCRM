import { formatClassEnd, weekdays } from "./schedule";

export type PeriodoAcademia = "manha" | "tarde" | "noite";

export interface ItemNomeAcademia {
  id: string;
  name: string;
}

export interface ItemModalidadeAcademia extends ItemNomeAcademia {
  aliases: string[];
}

export type ResolucaoModalidade =
  | { tipo: "encontrada"; id: string; nome: string }
  | { tipo: "ambigua"; nomes: string[] }
  | { tipo: "nao_encontrada" };

export interface AulaSemanalParaConsulta {
  id: string;
  weekday: number;
  start_time: string;
  duration_minutes: number;
}

export interface VinculosPublicosDaAula {
  modalidade: string;
  publico: string;
  professor: string;
  ambiente: string;
}

/** Texto comparável sem escolher uma modalidade aproximada em silêncio. */
export function normalizarTermoAcademia(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** O período pertence ao início da aula, não ao horário em que ela termina. */
export function periodoDoInicio(inicio: string): PeriodoAcademia {
  const minutos = Number(inicio.slice(0, 2)) * 60 + Number(inicio.slice(3, 5));
  return minutos < 12 * 60 ? "manha" : minutos < 18 * 60 ? "tarde" : "noite";
}

export function resolverModalidade(
  itens: readonly ItemModalidadeAcademia[],
  termo: string,
): ResolucaoModalidade {
  const alvo = normalizarTermoAcademia(termo);
  const peloNome = itens.filter((item) => normalizarTermoAcademia(item.name) === alvo);
  const encontrados =
    peloNome.length > 0
      ? peloNome
      : itens.filter((item) =>
          item.aliases.some((alias) => normalizarTermoAcademia(alias) === alvo),
        );

  if (encontrados.length === 0) return { tipo: "nao_encontrada" };
  if (encontrados.length > 1) {
    return {
      tipo: "ambigua",
      nomes: encontrados.map((item) => item.name).sort((a, b) => a.localeCompare(b, "pt-BR")),
    };
  }
  return { tipo: "encontrada", id: encontrados[0]!.id, nome: encontrados[0]!.name };
}

export function resolverPublico(
  itens: readonly ItemNomeAcademia[],
  termo: string,
): ItemNomeAcademia | null {
  const alvo = normalizarTermoAcademia(termo);
  return itens.find((item) => normalizarTermoAcademia(item.name) === alvo) ?? null;
}

const TERMOS_DE_GRADE =
  /\b(grade|aula|aulas|modalidade|turma|treino|cross ?fit|spinning|ciclismo|pilates|yoga|musculacao|professor|professora|box)\b/i;

const TERMOS_DE_PEDIDO_COMERCIAL =
  /\b(vaga|vagas|disponibilidade|reservar|reserva|matricula|aula experimental)\b/i;

/**
 * O gate usa somente uma janela curta. Assim ele acompanha “Cross fit → manhã →
 * segunda” sem transformar uma conversa antiga sobre aula num veto permanente.
 */
export function sinalDeConversaSobreGrade(
  mensagens: readonly { direction: string; body: string }[],
): boolean {
  const janela = mensagens.slice(-6).map((mensagem) => mensagem.body).join(" ");
  return TERMOS_DE_GRADE.test(normalizarTermoAcademia(janela));
}

/** Separa uma consulta informativa de um pedido explícito de próximo passo. */
export function sinalDePedidoComercialDaAcademia(texto: string): boolean {
  return TERMOS_DE_PEDIDO_COMERCIAL.test(normalizarTermoAcademia(texto));
}

export function projetarAulaSemanal(
  aula: AulaSemanalParaConsulta,
  vinculos: VinculosPublicosDaAula,
) {
  const inicio = aula.start_time.slice(0, 5);
  const professorPendente = normalizarTermoAcademia(vinculos.professor) === "a definir";
  return {
    dia_semana: aula.weekday,
    dia: weekdays.find((item) => item.value === aula.weekday)!.label,
    inicio,
    fim: formatClassEnd(inicio, aula.duration_minutes),
    duracao_minutos: aula.duration_minutes,
    publico: vinculos.publico,
    professor: vinculos.professor,
    ambiente: vinculos.ambiente,
    ...(professorPendente ? { pendencias: ["professor"] } : {}),
  };
}

export type AulaSemanalProjetada = ReturnType<typeof projetarAulaSemanal>;

/**
 * Linha determinística e completa para o modelo não resumir justamente o dado
 * que a pessoa pediu. Continua sendo só apresentação da consulta estruturada.
 */
export function resumirAulasParaResposta(
  aulas: readonly AulaSemanalProjetada[],
): string {
  return aulas
    .map(
      (aula) =>
        `${aula.dia}, ${aula.inicio}-${aula.fim} (${aula.duracao_minutos} minutos), ` +
        `público ${aula.publico}, professor ${aula.professor}, ambiente ${aula.ambiente}.`,
    )
    .join("\n");
}
