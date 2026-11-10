/**
 * A SÉRIE TEMPORAL DE GANHOS (issue #3024, fatia 1) — a conta, sem banco.
 *
 * A tela `/app/metrics` mostrava só número e tabela: dava para saber QUANTO, não
 * PARA ONDE ESTÁ INDO. Este módulo responde à segunda pergunta recortando os
 * ganhos já lidos em baldes de tempo — dia, semana ou mês.
 *
 * ## O que mora aqui, e o que fica na rota
 *
 * A rota (`app/api/v1/metrics/serie/route.ts`) lê os negócios ganhos da janela
 * com o client de sessão e entrega só o `closed_at` de cada um; a agregação por
 * balde é PURA e mora aqui. Nenhuma tabela nova, nenhuma migration, nenhuma
 * RPC: é a mesma doutrina de `funil/route.ts` e `lost/route.ts` — a série sai de
 * dados que já existem, não de um segundo lugar onde a verdade possa divergir.
 *
 * ## As três regras que a tela não pode furar
 *
 * 1. **A soma dos baldes é o total da janela.** A tendência é um RECORTE do
 *    mesmo conjunto, não um conjunto à parte: somar de novo em outro lugar é
 *    como a tela passa a ter duas versões da verdade.
 * 2. **Balde sem ganho aparece com ZERO, nunca some.** Um gráfico de linha que
 *    pula o dia parado liga dois pontos e inventa continuidade — o vale
 *    desaparece e a tendência fica mais bonita do que foi. Por isso a série
 *    nasce dos baldes da JANELA, e não dos dias em que houve ganho.
 * 3. **A ordem é a do tempo.** Linha de tempo fora de ordem não é linha de
 *    tempo.
 *
 * A janela é SEMIABERTA (`from <= closed_at < to`), a mesma régua das rotas
 * irmãs: balde é intervalo, e um ponto exatamente em `to` pertence à janela
 * seguinte.
 *
 * ## O balde é do calendário da ORGANIZAÇÃO, não do UTC
 *
 * O dia, a semana e o mês viram no fuso de `organizations.timezone`. Em UTC, o
 * ganho das 23h30 de São Paulo (02h30 UTC) cairia no dia SEGUINTE — quem fecha
 * negócio à noite veria a venda no dia errado. Por isso todo instante passa
 * primeiro por `partesNoFuso` e a conta segue sobre a data de parede.
 */
import { partesNoFuso } from "@/lib/agenda/fuso";


/** O recorte de tempo pedido pela tela: dia, semana ISO (segunda) ou mês. */
export type Granularidade = "dia" | "semana" | "mes";

/** A lista fechada — a rota valida por ela e a tela monta o seletor com ela. */
export const GRANULARIDADES: readonly Granularidade[] = ["dia", "semana", "mes"] as const;

/** Só o que a conta precisa do negócio ganho: quando ele fechou. */
export interface FechamentoDeGanho {
  /** O `crm_leads.closed_at` como a rota lê; `null` quando não veio. */
  closed_at: string | null;
}

/** A janela em ISO, semiaberta em `to` — a mesma das rotas irmãs de métricas. */
export interface Janela {
  from: string;
  to: string;
}

/** Um ponto da linha de tempo. */
export interface BaldeDeGanhos {
  /**
   * A chave do balde, estável e ordenável: `AAAA-MM-DD` para dia e para semana
   * (a SEGUNDA que abre a semana) e `AAAA-MM` para mês.
   */
  balde: string;
  /** Quantos negócios foram ganhos no balde — `0` quando não houve nenhum. */
  ganhos: number;
}

/**
 * Valida o que veio da query (`?granularidade=`), do tipo `unknown`, sem
 * confiar no `as`. Granularidade fora da lista é RECUSADA pela rota (422) —
 * tratar "trimestre" como "dia" em silêncio publicaria um número que ninguém
 * pediu.
 */
export function granularidadeValida(valor: unknown): valor is Granularidade {
  return valor === "dia" || valor === "semana" || valor === "mes";
}

/**
 * A data de parede do instante no fuso, como meia-noite UTC daquele dia do
 * calendário local. Daqui em diante a conta é só de calendário: os campos UTC
 * desta data SÃO o dia, o mês e o ano locais.
 */
function diaDoCalendario(instante: Date, fuso: string): Date {
  const p = partesNoFuso(instante, fuso);
  return new Date(Date.UTC(p.ano, p.mes - 1, p.dia));
}

/** O dia de calendário que ABRE o balde a que `d` (já local) pertence. */
function truncar(d: Date, granularidade: Granularidade): Date {
  const ano = d.getUTCFullYear();
  const mes = d.getUTCMonth();
  const dia = d.getUTCDate();
  if (granularidade === "mes") return new Date(Date.UTC(ano, mes, 1));
  if (granularidade === "dia") return new Date(Date.UTC(ano, mes, dia));
  // Semana ISO: começa na segunda-feira (0 = segunda … 6 = domingo).
  const desdeSegunda = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(ano, mes, dia - desdeSegunda));
}

/** O balde seguinte — um dia, sete dias ou um mês depois, no calendário. */
function avancar(inicio: Date, granularidade: Granularidade): Date {
  const ano = inicio.getUTCFullYear();
  const mes = inicio.getUTCMonth();
  const dia = inicio.getUTCDate();
  if (granularidade === "mes") return new Date(Date.UTC(ano, mes + 1, 1));
  if (granularidade === "dia") return new Date(Date.UTC(ano, mes, dia + 1));
  return new Date(Date.UTC(ano, mes, dia + 7));
}

/** A chave textual de um balde — mês sem o dia, os outros com a data ISO. */
function chaveDoBalde(inicio: Date, granularidade: Granularidade): string {
  const iso = inicio.toISOString().slice(0, 10);
  return granularidade === "mes" ? iso.slice(0, 7) : iso;
}

/**
 * A série: TODOS os baldes que a janela cobre, com a contagem de cada um.
 *
 * Nasce dos baldes da janela (regra 2) e não dos dias com ganho; soma 1 por
 * negócio que caia em `from <= closed_at < to` (regra 1); devolve em ordem de
 * data (regra 3). Data ilegível é descartada — nunca vira balde inventado.
 *
 * Os baldes viram no calendário de `fuso` (IANA). Quem chama passa um fuso já
 * validado — a rota usa `fusoUtilizavel`; fuso que o `Intl` recusa LANÇA.
 *
 * Lança se a granularidade não estiver em `GRANULARIDADES`: o silêncio é o que
 * publicaria o número errado.
 */
export function agregarGanhos(
  ganhos: readonly FechamentoDeGanho[] | null | undefined,
  janela: Janela,
  granularidade: string,
  fuso: string,
): BaldeDeGanhos[] {
  if (!granularidadeValida(granularidade)) {
    throw new Error(`Granularidade inválida: ${String(granularidade)}`);
  }

  const inicio = new Date(janela.from);
  const fim = new Date(janela.to);
  if (!Number.isFinite(inicio.getTime()) || !Number.isFinite(fim.getTime())) return [];
  if (inicio.getTime() >= fim.getTime()) return [];

  // Os baldes da janela, na ordem do tempo, e o índice de cada chave para o
  // segundo passo não varrer a lista de novo.
  const baldes: BaldeDeGanhos[] = [];
  const indicePorChave = new Map<string, number>();
  // O último balde é o do último instante DENTRO da janela (`to` é aberto).
  let cursor = truncar(diaDoCalendario(inicio, fuso), granularidade);
  const ultimo = truncar(diaDoCalendario(new Date(fim.getTime() - 1), fuso), granularidade);
  while (cursor.getTime() <= ultimo.getTime()) {
    const chave = chaveDoBalde(cursor, granularidade);
    indicePorChave.set(chave, baldes.length);
    baldes.push({ balde: chave, ganhos: 0 });
    cursor = avancar(cursor, granularidade);
  }

  for (const ganho of ganhos ?? []) {
    if (!ganho || typeof ganho.closed_at !== "string") continue;
    const quando = new Date(ganho.closed_at);
    const instante = quando.getTime();
    if (!Number.isFinite(instante)) continue;
    if (instante < inicio.getTime() || instante >= fim.getTime()) continue;
    const indice = indicePorChave.get(
      chaveDoBalde(truncar(diaDoCalendario(quando, fuso), granularidade), granularidade),
    );
    if (indice === undefined) continue;
    const balde = baldes[indice];
    if (balde) balde.ganhos += 1;
  }

  return baldes;
}

/**
 * O total da janela: a SOMA dos baldes, e só.
 *
 * NÃO é o número da tabela por atendente: aquela (`fn_attendant_metrics`) conta
 * só negócio COM responsável e segue o filtro de atendente da tela; esta série
 * conta todo ganho que a RLS deixa ver, com ou sem dono.
 */
export function totalDeGanhos(baldes: readonly BaldeDeGanhos[]): number {
  return baldes.reduce((acc, b) => acc + b.ganhos, 0);
}
