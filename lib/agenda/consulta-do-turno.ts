import { fusoValido } from '@/lib/tempo/fusos';
import { isoLocalComOffset, rotuloLocal } from '@/lib/tempo/agora';

type Objeto = Record<string, unknown>;
const objeto = (v: unknown): Objeto | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Objeto : undefined;
const texto = (v: unknown): string | undefined => typeof v === 'string' && v.length <= 180 ? v : undefined;
const inteiro = (v: unknown): number | undefined => Number.isSafeInteger(v) && Number(v) >= 0 ? Number(v) : undefined;
const instante = (v: unknown): v is string => typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));

/** Só a ponte nativa cria esta fotografia. Não é recibo, autorização ou inventário. */
export interface ConsultaAgendaDoTurno {
  sequencia: number;
  consultada_em: string;
  consulta: { servico: string | null; dia?: string; dias_a_frente?: number; responsavel_especifico: boolean };
  cobertura: 'pending' | 'present' | 'unavailable' | 'stale' | 'excluded_by_limit';
  resultado?: {
    horarios: { inicio: string; fim: string; inicio_local: string; quando_local: string }[];
    fuso: string;
    publicou_horarios: boolean;
    fuso_suposto: boolean;
    total_de_horarios: number;
    ha_mais: boolean;
    fontes_defasadas: number;
    agenda_externa_nunca_lida: boolean;
    modo_servico?: string;
    revisao_servico?: number;
  };
}
export interface ConsultasAgendaDoTurno { consultas: ConsultaAgendaDoTurno[]; omitidas: number }

/** Allowlist do resultado REAL da tool, não uma seleção feita pelo modelo. */
function projetar(resultado: unknown): ConsultaAgendaDoTurno['resultado'] {
  const r = objeto(resultado);
  if (!r || r.ok === false || r.isError === true || r.error || r.erro || r.motivo ||
      !Array.isArray(r.horarios) || r.horarios.length > 50 ||
      typeof r.fuso_da_regra !== 'string' || !fusoValido(r.fuso_da_regra) ||
      typeof r.publicou_horarios !== 'boolean' || typeof r.fuso_suposto !== 'boolean' ||
      typeof r.ha_mais !== 'boolean' || typeof r.agenda_externa_nunca_lida !== 'boolean' ||
      !Array.isArray(r.fontes_defasadas) || inteiro(r.total_de_horarios) === undefined ||
      Number(r.total_de_horarios) < r.horarios.length ||
      r.ha_mais !== (Number(r.total_de_horarios) > r.horarios.length)) return;
  const fuso = r.fuso_da_regra;
  const horarios: NonNullable<ConsultaAgendaDoTurno['resultado']>['horarios'] = [];
  for (const item of r.horarios) {
    const h = objeto(item);
    if (!h || !instante(h.inicio) || !instante(h.fim) || Date.parse(h.fim) <= Date.parse(h.inicio)) return;
    horarios.push({ inicio: h.inicio, fim: h.fim,
      inicio_local: isoLocalComOffset(new Date(h.inicio), fuso), quando_local: rotuloLocal(new Date(h.inicio), fuso) });
  }
  const servico = objeto(r.servico);
  return { horarios, fuso, publicou_horarios: r.publicou_horarios, fuso_suposto: r.fuso_suposto,
    total_de_horarios: Number(r.total_de_horarios), ha_mais: r.ha_mais,
    fontes_defasadas: r.fontes_defasadas.length, agenda_externa_nunca_lida: r.agenda_externa_nunca_lida,
    ...(texto(servico?.modo) ? { modo_servico: texto(servico?.modo) } : {}),
    ...(inteiro(servico?.revisao) !== undefined ? { revisao_servico: inteiro(servico?.revisao) } : {}) };
}

/** Estado efêmero por job; falha substitui sucesso anterior, sem herdar outro turno. */
export function criarObservacaoDeConsultasDaAgenda(agora: () => Date = () => new Date()) {
  let sequencia = 0, omitidas = 0;
  const consultas: ConsultaAgendaDoTurno[] = [];
  return {
    iniciar(input: unknown): number {
      const p = objeto(input);
      const seq = ++sequencia;
      // A consulta anterior permanece visível com seu alcance; nunca vira a mais recente.
      if (consultas.length === 4) { consultas.shift(); omitidas++; }
      consultas.push({ sequencia: seq, consultada_em: agora().toISOString(), cobertura: 'pending',
        consulta: { servico: texto(p?.event_type_slug) ?? null,
          ...(texto(p?.dia) ? { dia: texto(p?.dia) } : {}),
          ...(inteiro(p?.dias_a_frente) !== undefined ? { dias_a_frente: inteiro(p?.dias_a_frente) } : {}),
          responsavel_especifico: typeof p?.owner_user_id === 'string' } });
      return seq;
    },
    concluir(seq: number, resultado: unknown): void {
      const c = consultas.find(c => c.sequencia === seq);
      if (!c || c.cobertura !== 'pending') return;
      const projecao = projetar(resultado);
      c.cobertura = projecao ? 'present' : 'unavailable';
      if (projecao) c.resultado = projecao;
    },
    falhar(seq: number): void {
      const c = consultas.find(c => c.sequencia === seq);
      if (c?.cobertura === 'pending') c.cobertura = 'unavailable';
    },
    invalidar(): void {
      for (const c of consultas) { c.cobertura = 'stale'; delete c.resultado; }
    },
    atual(): ConsultasAgendaDoTurno | undefined {
      if (!consultas.length) return;
      // O teto não transforma uma lista cortada em consulta exaustiva.
      let usados = 0;
      return { omitidas, consultas: consultas.map(c => {
        const copia = structuredClone(c);
        usados += copia.resultado?.horarios.length ?? 0;
        if (usados > 80) { copia.cobertura = 'excluded_by_limit'; delete copia.resultado; }
        return copia;
      }) };
    },
  };
}

export const INSTRUCAO_CONSULTA_AGENDA = `
consultas_disponibilidade_do_turno contém resultados reais da ferramenta crm_find_free_slots deste job,
com serviço consultado, instante, fuso, cobertura e paginação. É leitura de disponibilidade, NÃO reserva,
publicação Google, escolha do cliente ou autorização de executar. Não exigir recibo de reserva para
comunicar indisponibilidade fundamentada ou oferecer alternativas devolvidas pela consulta pertinente.
Confira a data local e o serviço das opções contra o resultado; consulta de outro dia/serviço não os comprova.
Considere a consulta mais recente pertinente, inclusive falha/pending/stale; não resgate sucesso anterior
para contornar falha ou alteração posterior. Cobertura incompleta/omitida não é agenda vazia.
ha_mais=true permite oferecer opções presentes, mas não negar um horário só por estar ausente da página.
publicou_horarios=false não significa lotação; fuso_suposto, fontes_defasadas e agenda_externa_nunca_lida
exigem conservar a ressalva da consulta. Não invente causa de indisponibilidade nem generalize o recorte.
Uma pergunta sobre outro horário e a oferta de alternativas não precisam de escolha prévia dessas alternativas.
Já confirmar/agendar/remarcar/cancelar continua exigindo pedido e prova operacional correspondentes;
esta consulta não substitui nenhum desses requisitos nem uma restrição humana pertinente.
Consulta stale após escrita não invalida o recibo posterior verificado daquela operação; ela apenas não
sustenta novas afirmações de disponibilidade. Preserve a prova operacional no seu alcance.
`;
