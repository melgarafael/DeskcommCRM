import { scrubMessage } from '@/lib/sentry/scrub';
import { fusoValido } from '@/lib/tempo/fusos';
import { isoLocalComOffset, rotuloLocal } from '@/lib/tempo/agora';

interface PontoDaRemarcacao { inicio: string; fim: string; fuso: string; revisao: number; estado: 'pending' | 'confirmed' }
/** Observação privada da ponte nativa. Não é autorização nem recibo de publicação. */
export interface OperacaoAgendaObservada {
  acao: 'criar' | 'remarcar' | 'cancelar' | 'publicar';
  reservaId: string;
  revisao: number;
  /** Privada: origem relida e destino retornado pela MESMA escrita condicionada. */
  remarcacao?: { origem: PontoDaRemarcacao; destino: PontoDaRemarcacao };
}
const ferramentas = {
  crm_book_appointment: ['criar', 'marcado'],
  crm_find_and_book_appointment: ['criar', 'marcado'],
  crm_reschedule_appointment: ['remarcar', 'remarcado'],
  crm_cancel_appointment: ['cancelar', 'cancelado'],
} as const;
export function observaReciboDeAgenda(nome: string): boolean {
  return Object.hasOwn(ferramentas, nome);
}
const objeto = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const revisao = (v: unknown): number | null => {
  if (typeof v !== 'number' && !(typeof v === 'string' && /^[1-9]\d*$/.test(v))) return null;
  const n=Number(v); return Number.isSafeInteger(n) && n>0 ? n : null;
};

function ponto(v: Record<string, unknown> | null): PontoDaRemarcacao | undefined {
  const n=revisao(v?.revisao);
  if (!v || n===null || typeof v.inicio!=='string' || typeof v.fim!=='string' ||
      typeof v.fuso!=='string' || !fusoValido(v.fuso) || !['pending','confirmed'].includes(String(v.estado))) return;
  const inicio=Date.parse(v.inicio),fim=Date.parse(v.fim);
  if (!Number.isFinite(inicio) || !Number.isFinite(fim) || fim<=inicio) return;
  return {inicio:v.inicio,fim:v.fim,fuso:v.fuso,revisao:n,estado:v.estado as 'pending'|'confirmed'};
}
function projetarPonto(p: PontoDaRemarcacao) {
  return {...p,inicio_local:isoLocalComOffset(new Date(p.inicio),p.fuso),
    fim_local:isoLocalComOffset(new Date(p.fim),p.fuso),quando_local:rotuloLocal(new Date(p.inicio),p.fuso)};
}

/** Um estado por turno; tentativa nova invalida a anterior, inclusive se falhar. */
export interface PublicacaoAgendaObservada { reservaId: string; revisao: number }
/** A semente vem exclusivamente da retomada ou recuperação nativa validada, nunca do payload/modelo.
 * Relê publicação da revisão do pedido; não simula uma ferramenta de escrita.
 */
export function criarObservacaoDaAgenda(publicacao?: PublicacaoAgendaObservada) {
  let sequencia=0;
  const versaoPublicada = revisao(publicacao?.revisao);
  let ultima: OperacaoAgendaObservada | undefined = publicacao &&
    typeof publicacao.reservaId === 'string' && publicacao.reservaId.trim() && versaoPublicada !== null
    ? { acao:'publicar', reservaId:publicacao.reservaId, revisao:versaoPublicada } : undefined;
  return {
    publicar: (seq: number, publicacao: PublicacaoAgendaObservada) => {
      if (seq !== sequencia) return;
      const versao = revisao(publicacao.revisao);
      if (typeof publicacao.reservaId === 'string' && publicacao.reservaId.trim() && versao !== null)
        ultima = {acao:'publicar',reservaId:publicacao.reservaId,revisao:versao};
    },
    iniciar: () => { ultima=undefined; return ++sequencia; },
    concluir: (seq: number, nome: string, resultado: unknown) => {
      if (seq!==sequencia || !observaReciboDeAgenda(nome)) return;
      const r=objeto(resultado), c=objeto(r?.compromisso);
      const [acao, sinal]=ferramentas[nome as keyof typeof ferramentas];
      const versao=revisao(c?.revision);
      if (!r || r.ok===false || r.isError===true || r.error || r.erro || r[sinal]!==true ||
          typeof c?.id!=='string' || !c.id || versao===null) return;
      ultima={acao,reservaId:c.id,revisao:versao};
      if (acao==='remarcar') {
        const o=objeto(r.origem_remarcacao),origem=ponto(o),destino=ponto({inicio:c.starts_at,fim:c.ends_at,fuso:c.time_zone,revisao:c.revision,estado:c.status});
        if (o?.reserva_id===c.id && origem && destino && destino.revisao===origem.revisao+1 &&
            Date.parse(destino.inicio)!==Date.parse(origem.inicio)) ultima.remarcacao={origem,destino};
      }
    },
    atual: (): OperacaoAgendaObservada | undefined => ultima && structuredClone(ultima),
  };
}

/** A observação vincula a transição; estado atual e publicação vêm da releitura scoped. */
export function projetarResultadoAgendaDoTurno(
  observada: OperacaoAgendaObservada | undefined,
  contexto: {operacoes: readonly {id: string; origem: string; estado: string; dados: Record<string, unknown>}[]} | undefined,
): Record<string, unknown> | undefined {
  if (!observada || !contexto) return;
  const fontes=contexto.operacoes.filter(o=>o.id===observada.reservaId && o.origem==='agenda_persistida');
  if (fontes.length!==1) return;
  const fonte=fontes[0]!, d=fonte.dados;
  if (fonte.estado!=='verified' || revisao(d.revisao_reserva)!==observada.revisao ||
      (observada.acao==='cancelar' ? d.estado!=='cancelled' : !['pending','confirmed'].includes(String(d.estado)))) return;
  if (observada.acao === 'publicar' && (d.estado !== 'confirmed' || d.publicacao_google !== 'synced' ||
      revisao(d.revisao_google_local) !== observada.revisao || revisao(d.revisao_google_publicada) !== observada.revisao ||
      d.publicacao_pendente !== false || d.motivo_publicacao != null || d.classificacao_falha != null)) return;
  const transicao=observada.acao==='remarcar' ? observada.remarcacao : undefined;
  const destino=transicao?.destino;
  const mesmaEscrita=destino && destino.revisao===observada.revisao && d.estado===destino.estado &&
    typeof d.inicio==='string' && Date.parse(d.inicio)===Date.parse(destino.inicio) &&
    typeof d.fim==='string' && Date.parse(d.fim)===Date.parse(destino.fim) && d.fuso===destino.fuso;
  return {
    ...(transicao && mesmaEscrita ? {transicao_remarcacao:{mesma_reserva:true,
      origem:projetarPonto(transicao.origem),destino:projetarPonto(transicao.destino),
      significado:'origem_e_destino_da_mesma_escrita_condicionada_por_revisao_nao_nova_reserva'}} : {}),
    acao_observada:observada.acao,
    referencia_recibo:`fonte_${contexto.operacoes.indexOf(fonte)+1}`,
    revisao_relida:observada.revisao,
    alcance:'somente_reserva_e_revisao_relidas_nao_inventario_da_agenda',
    recibo:JSON.parse(scrubMessage(JSON.stringify(d)).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[referencia_interna]')),
    significado:observada.acao === 'publicar' ? 'publicacao_nativa_da_revisao_do_pedido_nao_nova_escrita' : 'resultado_persistido_da_ferramenta_neste_turno_nao_autorizacao_nem_comunicacao',
  };
}


/** Leituras atuais do servidor, não observações de escrita nem autorização do pedido.
 * Referências apontam para a mesma fotografia externa; nunca selecionar a primeira reserva.
 */
export function projetarLeiturasDeEstadoDaAgenda(contexto: {
  operacoes: readonly {id: string; origem: string; estado: string; dados: Record<string, unknown>}[];
}): {referencia_recibo: string; revisao_relida: number; estado_relido: 'confirmed' | 'cancelled'}[] {
  return contexto.operacoes.flatMap((fonte, i) => {
    const d=fonte.dados, n=revisao(d.revisao_reserva);
    if (fonte.origem!=='agenda_persistida' || fonte.estado!=='verified' || n===null ||
        contexto.operacoes.filter(o=>o.origem==='agenda_persistida' && o.id===fonte.id).length!==1 ||
        revisao(d.revisao_google_local)!==n || revisao(d.revisao_google_publicada)!==n ||
        d.publicacao_pendente!==false || d.motivo_publicacao!=null || d.classificacao_falha!=null) return [];
    const confirmada=d.estado==='confirmed' && d.publicacao_google==='synced' &&
      (d.natureza_confirmacao==='reserva_publicada_sem_aprovacao_humana_exigida' ||
       d.natureza_confirmacao==='reserva_publicada_pelo_fluxo_individual');
    const cancelada=d.estado==='cancelled' && d.publicacao_google==='removed' &&
      d.natureza_cancelamento==='cancelamento_sincronizado_no_google' &&
      typeof d.cancelada_em==='string' && Number.isFinite(Date.parse(d.cancelada_em));
    if (!confirmada && !cancelada) return [];
    return [{referencia_recibo:`fonte_${i+1}`,revisao_relida:n,estado_relido:confirmada?'confirmed' as const:'cancelled' as const}];
  });
}
