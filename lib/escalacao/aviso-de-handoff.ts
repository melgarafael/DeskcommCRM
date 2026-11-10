import type { EventRow, HandlerResult } from '@/lib/event-log/dispatcher';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AvisoDb, PacingDoAviso, TransporteDoAviso } from './aviso-ao-suporte';
import { avisoDeTransferenciaLigado } from '@/lib/schemas/settings';

/** Opt-in: usa somente o destinatário que o administrador já configurou. */
export const EVENTO_AVISO_HANDOFF = 'ai.handoff_aviso_solicitado';
export const HANDLER_AVISO_HANDOFF = 'escalacao-aviso-handoff.v1';
export const MARCA_EPISODIO_HANDOFF = 'aviso_handoff_episodio';
export const MARCA_SOLICITACAO_HANDOFF = 'aviso_handoff_solicitado';
export const MARCA_ENVIO_HANDOFF = 'aviso_handoff_envio';
export const VALIDADE_AVISO_HANDOFF_MS = 24 * 60 * 60 * 1000;
export const RESERVA_AVISO_HANDOFF_MS = 2 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ResultadoAvisoHandoff = 'enviado' | 'incerto' | 'cancelado';
export interface EstadoEnvioHandoff {
  estado: 'reservado' | ResultadoAvisoHandoff;
  em: string;
  motivo?: string;
}
export interface ContextoAvisoHandoff {
  episodio: string | null;
  emHandoff: boolean;
  contactId: string;
}
export interface AvisoHandoffDeps {
  db: Pick<AvisoDb, 'carregaConfig' | 'carregaCanal' | 'contatoAnonimizado' |
    'destinoEhDaPropriaOrganizacao' | 'registraJidDoAviso'>;
  transporte: TransporteDoAviso;
  pacing: PacingDoAviso;
  clock(): Date;
  urlPublica: string;
  origemDoDreno(): 'worker' | 'request';
  contexto(org: string, conversa: string): Promise<ContextoAvisoHandoff | null>;
  estado(row: EventRow): Promise<EstadoEnvioHandoff | null>;
  /** `settings.crm.avisar_transferencia_no_whatsapp`; ausente = ligado. */
  transferenciasLigadas(org: string): Promise<boolean>;
  /** Compare-and-set durável: só o vencedor pode chamar o transporte. */
  reservar(row: EventRow, em: string): Promise<boolean>;
  concluir(row: EventRow, estado: EstadoEnvioHandoff): Promise<void>;
}

/** Sem nome, motivo livre, transcrição ou dado clínico na notificação externa. */
export function textoDoAvisoHandoff(urlPublica: string, conversa: string): string | null {
  if (!UUID.test(conversa)) return null;
  let origem: URL;
  try { origem = new URL(urlPublica); } catch { return null; }
  if (origem.protocol !== 'https:' || origem.username || origem.password) return null;
  const link = new URL('/app/inbox', origem.origin);
  link.searchParams.set('id', conversa);
  return `Um atendimento precisa de uma pessoa da equipe.\n\nAbrir conversa: ${link.href}\n\nResponda pelo CRM; responder a este aviso não chega ao cliente.`;
}

/** Um recibo por episódio na Central; CAS no adapter preserva adendos concorrentes. */
export function corpoComResultadoHandoff(corpo: string, eventoId: string, estado: EstadoEnvioHandoff): string {
  const prefixo = `Aviso à equipe (${eventoId}): `;
  const mensagem = estado.estado === 'enviado'
    ? 'aceito pelo canal de WhatsApp.'
    : estado.estado === 'incerto' || estado.estado === 'reservado'
      ? 'entrega não confirmada; confira o WhatsApp. Não haverá reenvio automático.'
      : 'não enviado; acompanhe este atendimento pelo CRM.';
  return [...corpo.split('\n').filter((linha) => !linha.startsWith(prefixo)), `${prefixo}${mensagem}`].join('\n');
}

function resposta(status: HandlerResult['status'], detail: string, retryAt?: Date): HandlerResult {
  return { consumer_key: HANDLER_AVISO_HANDOFF, status, detail,
    ...(retryAt ? { retry_at: retryAt.toISOString() } : {}) };
}

/**
 * Uma tentativa de transporte por episódio, inclusive após crash/retry.
 * A reserva nunca vence para autorizar outro envio: incerteza exige humano.
 * Falhas de configuração e pacing antes da reserva não consomem tentativa.
 */
export async function aplicaAvisoHandoff(deps: AvisoHandoffDeps, row: EventRow): Promise<HandlerResult> {
  if (row.event_type !== EVENTO_AVISO_HANDOFF) return resposta('skipped', 'evento_ignorado');
  const conversa = row.entity_id;
  if (row.entity_kind !== 'conversation' || !conversa || !UUID.test(conversa) ||
      !UUID.test(row.id) || typeof row.payload.central_id !== 'string' || !UUID.test(row.payload.central_id)) {
    return resposta('skipped', 'evento_invalido');
  }
  const agora = deps.clock();
  const anterior = await deps.estado(row);
  if (anterior) {
    if (anterior.estado === 'reservado' && agora.getTime() - Date.parse(anterior.em) < RESERVA_AVISO_HANDOFF_MS) {
      return resposta('retry', 'envio_em_andamento', new Date(agora.getTime() + 15_000));
    }
    const final = anterior.estado === 'reservado'
      ? { ...anterior, estado: 'incerto' as const, motivo: 'tentativa_interrompida' } : anterior;
    await deps.concluir(row, final);
    return resposta('skipped', `ja_reivindicado:${final.estado}`);
  }
  const cancelar = async (motivo: string): Promise<HandlerResult> => {
    await deps.concluir(row, { estado: 'cancelado', em: agora.toISOString(), motivo });
    return resposta('skipped', motivo);
  };
  const criado = Date.parse(row.created_at ?? '');
  if (!Number.isFinite(criado) || agora.getTime() - criado > VALIDADE_AVISO_HANDOFF_MS) return cancelar('aviso_expirado');
  if (deps.origemDoDreno() === 'request') return resposta('retry', 'aguardando_worker', new Date(agora.getTime() + 15_000));
  const contexto = await deps.contexto(row.organization_id, conversa);
  if (!contexto?.emHandoff || contexto.episodio !== row.id) return cancelar('episodio_encerrado');
  if (await deps.db.contatoAnonimizado(row.organization_id, contexto.contactId)) return cancelar('contato_anonimizado');
  const texto = textoDoAvisoHandoff(deps.urlPublica, conversa);
  if (!texto) return cancelar('endereco_publico_invalido');
  const config = await deps.db.carregaConfig(row.organization_id);
  if (!config?.ligado || !config.channel_session_id || !config.telefone_destino) return cancelar('aviso_desligado');
  const canal = await deps.db.carregaCanal(row.organization_id, config.channel_session_id);
  if (!canal || canal.archived_at || canal.desativado || !canal.aceitaMensagemLivre) return cancelar('canal_indisponivel');
  if (canal.status !== 'WORKING') return resposta('retry', 'canal_desconectado', new Date(agora.getTime() + 300_000));
  if (await deps.db.destinoEhDaPropriaOrganizacao(row.organization_id, config.telefone_destino)) return cancelar('destino_circular');
  if (!(await deps.transporte.configurado(row.organization_id, canal))) return cancelar('canal_sem_chave');
  const destino = await deps.transporte.resolveDestino(row.organization_id, canal, config.telefone_destino);
  if (!destino) return cancelar('destino_invalido');
  const pacing = await deps.pacing.decide(row.organization_id, canal.id, agora);
  if (!pacing.liberado) return resposta('retry', pacing.motivo, pacing.liberaEm);
  // Releitura antes da reserva: retirada do opt-in ou atendimento retomado vence.
  const [configAtual, contextoAtual, transferencias] = await Promise.all([
    deps.db.carregaConfig(row.organization_id), deps.contexto(row.organization_id, conversa),
    deps.transferenciasLigadas(row.organization_id),
  ]);
  if (!transferencias) return cancelar('desligado_em_transferencias');
  if (!configAtual?.ligado || configAtual.channel_session_id !== config.channel_session_id ||
      configAtual.telefone_destino !== config.telefone_destino) return cancelar('configuracao_alterada');
  if (!contextoAtual?.emHandoff || contextoAtual.episodio !== row.id) return cancelar('episodio_encerrado');
  if (!(await deps.reservar(row, agora.toISOString()))) return resposta('retry', 'reserva_concorrente', new Date(agora.getTime() + 15_000));
  // Depois daqui NENHUMA falha autoriza outra chamada ao transporte.
  let resultado: EstadoEnvioHandoff;
  try {
    const envio = await deps.transporte.envia(row.organization_id, canal, destino, texto);
    resultado = { estado: envio.externalId ? 'enviado' : 'incerto', em: agora.toISOString(),
      motivo: envio.externalId ? 'aceito_pelo_canal' : 'sem_recibo_do_canal' };
  } catch {
    resultado = { estado: 'incerto', em: agora.toISOString(), motivo: 'resultado_do_transporte_incerto' };
  }
  // Conta até a tentativa incerta, conservadoramente, no pacing nativo.
  await deps.pacing.registraEnvio(row.organization_id, canal.id, agora);
  await deps.concluir(row, resultado);
  if (resultado.estado === 'enviado') await deps.db.registraJidDoAviso(row.organization_id, destino);
  return resposta(resultado.estado === 'enviado' ? 'ok' : 'skipped', resultado.motivo ?? resultado.estado);
}
type Admin = SupabaseClient;
type Metadata = Record<string, unknown>;

function lerEstado(metadata: Metadata): EstadoEnvioHandoff | null {
  const valor = metadata[MARCA_ENVIO_HANDOFF];
  if (valor === undefined || valor === null) return null;
  if (typeof valor === 'object' && !Array.isArray(valor)) {
    const estado = valor as Record<string, unknown>;
    if (['reservado', 'enviado', 'incerto', 'cancelado'].includes(String(estado.estado)) &&
        typeof estado.em === 'string' && Number.isFinite(Date.parse(estado.em))) {
      return estado as unknown as EstadoEnvioHandoff;
    }
  }
  // Uma marca ilegível nunca é licença para repetir uma chamada externa.
  return { estado: 'incerto', em: new Date(0).toISOString(), motivo: 'marca_ilegivel' };
}

/** Só este consumidor altera a metadata deste tipo de evento; o dreno altera status/attempts. */
export function criarPersistenciaAvisoHandoff(admin: Admin): Pick<AvisoHandoffDeps,
  'contexto' | 'estado' | 'reservar' | 'concluir' | 'transferenciasLigadas'> {
  async function metadataDoEvento(row: EventRow): Promise<Metadata> {
    const { data, error } = await admin.from('event_log').select('metadata')
      .eq('organization_id', row.organization_id).eq('id', row.id)
      .eq('event_type', EVENTO_AVISO_HANDOFF).maybeSingle();
    if (error || !data) throw new Error('aviso_handoff_evento_indisponivel');
    return (data.metadata ?? {}) as Metadata;
  }
  async function gravarSeIgual(row: EventRow, anterior: Metadata, estado: EstadoEnvioHandoff): Promise<boolean> {
    const { data, error } = await admin.from('event_log')
      .update({ metadata: { ...anterior, [MARCA_ENVIO_HANDOFF]: estado } })
      .eq('organization_id', row.organization_id).eq('id', row.id)
      .eq('event_type', EVENTO_AVISO_HANDOFF).eq('metadata', JSON.stringify(anterior)).select('id');
    if (error) throw new Error('aviso_handoff_reserva_nao_gravada');
    return (data?.length ?? 0) === 1;
  }
  async function reciboNaCentral(row: EventRow): Promise<void> {
    for (let tentativa = 0; tentativa < 3; tentativa++) {
      const { data, error } = await admin.from('agent_inbox_items').select('id, body')
        .eq('organization_id', row.organization_id).eq('id', row.payload.central_id)
        .eq('ref_kind', 'conversation').eq('ref_id', row.entity_id).maybeSingle();
      if (error || !data) throw new Error('aviso_handoff_central_indisponivel');
      // Ler o corpo ANTES do estado: se outro consumidor publicar um recibo
      // positivo depois desta leitura, o CAS do corpo perde e relê os dois.
      // Assim um resultado incerto atrasado não rebaixa o texto já esclarecido.
      const vigente = lerEstado(await metadataDoEvento(row));
      if (!vigente || vigente.estado === 'reservado') return;
      const corpo = corpoComResultadoHandoff(data.body ?? '', row.id, vigente);
      if (data.body === corpo) return;
      let update = admin.from('agent_inbox_items').update({ body: corpo })
        .eq('organization_id', row.organization_id).eq('id', data.id)
        .eq('ref_kind', 'conversation').eq('ref_id', row.entity_id);
      update = data.body === null ? update.is('body', null) : update.eq('body', data.body);
      const gravacao = await update.select('id');
      if (gravacao.error) throw new Error('aviso_handoff_recibo_nao_gravado');
      if (gravacao.data?.length === 1) return;
    }
    throw new Error('aviso_handoff_central_concorrente');
  }
  return {
    async contexto(org, conversa) {
      const { data, error } = await admin.from('conversations')
        .select('contact_id, status, bot_silenced_until, metadata')
        .eq('organization_id', org).eq('id', conversa).maybeSingle();
      if (error) throw new Error('aviso_handoff_contexto_indisponivel');
      if (!data) return null;
      const silencio = data.bot_silenced_until;
      const episodio = data.metadata?.[MARCA_EPISODIO_HANDOFF];
      return { contactId: data.contact_id,
        episodio: typeof episodio === 'string' ? episodio : null,
        emHandoff: !['closed', 'resolved', 'archived'].includes(data.status) &&
          (silencio === 'infinity' || (typeof silencio === 'string' && Date.parse(silencio) > Date.now())),
      };
    },
    async estado(row) { return lerEstado(await metadataDoEvento(row)); },
    async transferenciasLigadas(org) {
      // Erro de leitura LANÇA (o handler devolve error e o dreno tenta de novo):
      // nunca vira "ligado" para autorizar uma chamada externa.
      const { data, error } = await admin.from('organizations').select('settings')
        .eq('id', org).maybeSingle();
      if (error || !data) throw new Error('aviso_handoff_opcao_indisponivel');
      return avisoDeTransferenciaLigado((data as { settings?: unknown }).settings);
    },
    async reservar(row, em) {
      const anterior = await metadataDoEvento(row);
      if (lerEstado(anterior)) return false;
      return gravarSeIgual(row, anterior, { estado: 'reservado', em });
    },
    async concluir(row, pedido) {
      // Cancelamento concorrente não pode sobrescrever a reserva de quem ganhou.
      // Recibo positivo tardio pode esclarecer 'incerto'; nunca se faz o inverso.
      for (let tentativa = 0; tentativa < 3; tentativa++) {
        const metadata = await metadataDoEvento(row);
        const atual = lerEstado(metadata);
        const permitido = atual === null ? pedido.estado === 'cancelado'
          : atual.estado === 'reservado' ? pedido.estado !== 'cancelado'
          : atual.estado === 'incerto' ? pedido.estado === 'enviado' && atual.em === pedido.em
          : false;
        let final = atual;
        if (permitido) {
          if (!(await gravarSeIgual(row, metadata, pedido))) continue;
          final = pedido;
        }
        if (final === null) throw new Error('aviso_handoff_sem_reserva');
        // O vencedor ainda está enviando. O perdedor não declara cancelamento.
        if (final.estado !== 'reservado') await reciboNaCentral(row);
        return;
      }
      throw new Error('aviso_handoff_resultado_concorrente');
    },
  };
}
