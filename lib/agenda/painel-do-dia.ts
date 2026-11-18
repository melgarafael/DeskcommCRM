/**
 * O PAINEL DO DIA — reservas por turma, pessoas esperadas e % de confirmadas.
 *
 * Issue #4029, saída 3. SÓ LEITURA: não há escrita, não há tabela nova, e
 * nenhuma capacidade é recalculada aqui — capacidade é dado da turma, lido como
 * está (`calendar_appointments.service_capacity_limit`).
 *
 * ─── O DIA É O DA ORGANIZAÇÃO ───────────────────────────────────────────────
 *
 * `dia` é um dia CIVIL no fuso da organização (`organizations.timezone`), e o
 * recorte é o intervalo UTC equivalente — `[início do dia, início do seguinte)`,
 * calculado no MESMO fuso, e não `+24h` (o dia do horário de verão tem 23 ou 25
 * horas). Um compromisso às 23h de Brasília é do dia 8, não do dia 9: quem
 * agrupa por `starts_at` em UTC erraria isso em três horas por dia, todo dia.
 *
 * A função é PURA e recebe as reservas já lidas; quem lê é `lerPainelDoDia`,
 * que reusa `listaAgendamentos` (`lib/agenda/consulta.ts`) — a MESMA consulta
 * que a grade e o agente usam. Uma segunda query com outra régua daria dois
 * números para o mesmo dia, que é o defeito que o painel existe para fechar.
 *
 * ─── A RÉGUA DE "PESSOAS ESPERADAS" (declarada, não inferida) ───────────────
 *
 * **Pessoas esperadas = soma de `service_party_size` das reservas VIVAS**
 * (`pending` + `confirmed`). A coluna é `not null default 1`, então uma reserva
 * sem grupo declarado conta 1 pessoa. Cancelada e `no_show` ficam FORA: não são
 * gente esperada, e contá-las inflaria o painel que a recepção usa para montar o
 * dia.
 *
 * A capacidade da turma (`capacity_limit`) NÃO entra nessa soma. Ela é a lotação
 * — quantas pessoas cabem —, e é publicada ao lado, por turma, como referência.
 * Somar capacidade e chamar de "pessoas esperadas" diria que uma turma de 10
 * vagas espera 10 pacientes mesmo com zero reservas.
 *
 * ─── ZERO RESERVAS NÃO DIVIDE POR ZERO ──────────────────────────────────────
 *
 * `percentual` é `null` quando não há reserva viva no recorte — e `null` NÃO é
 * `0`: zero por cento significa "há reservas, nenhuma confirmada"; `null`
 * significa "não há o que dividir". A tela mostra "—" para o segundo caso.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { janelaDoDiaNoFuso, listaAgendamentos } from "./consulta";

/** As situações que contam como reserva do dia. Ver a régua no cabeçalho. */
const SITUACOES_VIVAS = new Set(["pending", "confirmed"]);

/** Uma reserva, no mínimo que o painel precisa. Nada de nome de paciente aqui. */
export interface ReservaDoPainel {
  id: string;
  /** Instante ISO do início — é ele que decide o dia, no fuso da organização. */
  inicio: string;
  fim: string;
  situacao: string;
  /** `service_occurrence_id`: a turma é a unidade de agrupamento do painel. */
  turmaId: string | null;
  /** Rótulo da turma (nome do tipo de atendimento, quando houver). */
  turma: string | null;
  /** Lotação da turma (`capacity_limit`); `null` = sem limite automático. */
  capacidade: number | null;
  /** Pessoas desta reserva (`service_party_size`, default 1 no banco). */
  pessoas: number;
}

export interface LinhaDoPainelDoDia {
  turmaId: string;
  turma: string | null;
  /** Início da primeira reserva viva da turma, em instante ISO. */
  inicio: string;
  fim: string;
  capacidade: number | null;
  reservas: number;
  pessoasEsperadas: number;
  confirmadas: number;
  /** 0-100 arredondado; `null` quando a turma não tem reserva viva. */
  percentual: number | null;
}

export interface TotaisDoPainelDoDia {
  turmas: number;
  reservas: number;
  pessoasEsperadas: number;
  confirmadas: number;
  /** Soma das capacidades das turmas que declaram limite. */
  capacidade: number;
  percentual: number | null;
}

export interface PainelDoDia {
  /** O dia civil pedido, `YYYY-MM-DD`, no fuso da organização. */
  dia: string;
  fuso: string;
  linhas: LinhaDoPainelDoDia[];
  totais: TotaisDoPainelDoDia;
  /** Dia sem reserva viva: estrutura vazia, nunca `null`. */
  vazio: boolean;
  /** A leitura bateu no teto da consulta — os totais não são o dia inteiro. */
  truncado: boolean;
}

function percentualDe(confirmadas: number, reservas: number): number | null {
  if (reservas <= 0) return null;
  return Math.round((confirmadas * 100) / reservas);
}

/**
 * O resumo PURO. Recebe TODAS as reservas candidatas e recorta o dia no fuso.
 *
 * Recortar aqui, e não só na query, é o que torna o recorte de fuso testável
 * sem banco — e é defesa em profundidade: quem chamar com uma janela mais larga
 * (a semana, por exemplo) continua recebendo o dia certo.
 */
export function resumirPainelDoDia(
  dia: string,
  fuso: string,
  reservas: readonly ReservaDoPainel[],
): PainelDoDia {
  // Sem janela (dia malformado ou fuso inválido) o recorte degrada para o dia
  // em UTC — o mesmo comportamento antigo da listagem, e nunca uma exceção numa
  // tela de leitura.
  const janela = janelaDoDiaNoFuso(dia, fuso) ?? {
    de: `${dia}T00:00:00.000Z`,
    ate: `${dia}T23:59:59.999Z`,
  };
  const de = Date.parse(janela.de);
  const ate = Date.parse(janela.ate);

  const porTurma = new Map<string, LinhaDoPainelDoDia>();

  for (const reserva of reservas) {
    if (!reserva.turmaId) continue;
    if (!SITUACOES_VIVAS.has(reserva.situacao)) continue;
    const inicio = Date.parse(reserva.inicio);
    if (Number.isNaN(inicio) || inicio < de || inicio >= ate) continue;

    const atual = porTurma.get(reserva.turmaId) ?? {
      turmaId: reserva.turmaId,
      turma: reserva.turma,
      inicio: reserva.inicio,
      fim: reserva.fim,
      capacidade: reserva.capacidade,
      reservas: 0,
      pessoasEsperadas: 0,
      confirmadas: 0,
      percentual: null,
    };

    atual.reservas += 1;
    atual.pessoasEsperadas += Math.max(1, Math.trunc(reserva.pessoas));
    if (reserva.situacao === "confirmed") atual.confirmadas += 1;
    if (Date.parse(reserva.inicio) < Date.parse(atual.inicio)) {
      atual.inicio = reserva.inicio;
      atual.fim = reserva.fim;
    }
    porTurma.set(reserva.turmaId, atual);
  }

  const linhas = [...porTurma.values()]
    .map((linha) => ({ ...linha, percentual: percentualDe(linha.confirmadas, linha.reservas) }))
    .sort((a, b) => Date.parse(a.inicio) - Date.parse(b.inicio) || a.turmaId.localeCompare(b.turmaId));

  const totais = linhas.reduce<TotaisDoPainelDoDia>(
    (acc, linha) => ({
      turmas: acc.turmas + 1,
      reservas: acc.reservas + linha.reservas,
      pessoasEsperadas: acc.pessoasEsperadas + linha.pessoasEsperadas,
      confirmadas: acc.confirmadas + linha.confirmadas,
      capacidade: acc.capacidade + (linha.capacidade ?? 0),
      percentual: null,
    }),
    { turmas: 0, reservas: 0, pessoasEsperadas: 0, confirmadas: 0, capacidade: 0, percentual: null },
  );

  return {
    dia,
    fuso,
    linhas,
    totais: { ...totais, percentual: percentualDe(totais.confirmadas, totais.reservas) },
    vazio: linhas.length === 0,
    truncado: false,
  };
}

/**
 * A leitura do dia. Reusa `listaAgendamentos` — a consulta que a grade e o
 * agente já usam — com o recorte de INSTANTES da janela do dia no fuso da
 * organização. Nada de query nova: outra régua aqui daria dois números para o
 * mesmo dia.
 *
 * O teto é o da listagem (500). Se o dia passar disso, `truncado` diz na tela
 * em vez de fingir que os totais são do dia inteiro.
 */
export async function lerPainelDoDia(
  supabase: SupabaseClient,
  organizationId: string,
  dia: string,
  fuso: string,
): Promise<PainelDoDia> {
  const janela = janelaDoDiaNoFuso(dia, fuso);
  if (!janela) return resumirPainelDoDia(dia, fuso, []);

  const resultado = await listaAgendamentos(supabase, organizationId, {
    de: janela.de,
    ate: janela.ate,
    limite: 500,
  });
  if (!resultado.ok) throw new Error(resultado.motivoParaOperador);

  const reservas: ReservaDoPainel[] = [];
  for (const agendamento of resultado.agendamentos) {
    if (!agendamento.servico) continue;
    reservas.push({
      id: agendamento.id,
      inicio: agendamento.iniciaEm,
      fim: agendamento.terminaEm,
      situacao: agendamento.situacao,
      turmaId: agendamento.servico.occurrence_id,
      turma: agendamento.tipo?.nome ?? agendamento.titulo,
      capacidade: agendamento.servico.capacity_limit,
      pessoas: agendamento.servico.pessoas,
    });
  }

  return { ...resumirPainelDoDia(dia, fuso, reservas), truncado: Boolean(resultado.proximo) };
}
