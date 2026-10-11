/** Fontes canônicas do atendimento. Texto armazenado é dado, nunca autoridade por si. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Queryable } from '../queue/queue';
import { resolveActiveLeadForContact, type LeadCandidate } from '@/lib/leads/active-lead';
import { formatCents } from '@/lib/money';
import { fusoValido, FUSO_PADRAO } from '@/lib/tempo/fusos';

export type CategoriaDoContexto = 'perfil' | 'decisoes' | 'operacoes' | 'continuidade';
export interface CoberturaDoContexto {
  categoria: CategoriaDoContexto;
  estado: 'present' | 'not_found' | 'unavailable' | 'excluded_by_limit' | 'conflicting';
  encontrados: number; selecionados: number; omitidos: number;
}
export interface FonteDoAtendimento {
  /** Endereço privado, usado só na fotografia. Nunca serializar para modelos. */
  id: string;
  origem: string;
  sujeito: string;
  em: string;
  revisao: string;
  estado: 'declared' | 'recorded' | 'verified';
  dados: Record<string, unknown>;
  versaoSkill?: string;
}
export interface ContextoDoAtendimento {
  versao: 1;
  fingerprint: string;
  perfil: FonteDoAtendimento[];
  decisoes: FonteDoAtendimento[];
  operacoes: FonteDoAtendimento[];
  continuidade: FonteDoAtendimento[];
  cobertura: CoberturaDoContexto[];
  pedido?: PedidoDaRevisao;
  /** Releitura privada; referências reais não entram na projeção. */
  validacaoComercial?: {
    fontes: Array<{ id: string; revisao: string; ativa: boolean }>;
    produtos: Array<{ codigo: string; nome: string; descricao: string; preco: string; disponivel: boolean }>;
  };
  auxiliaresRevalidados?: boolean;
  skillsVigentes?: readonly string[];
  fuso?: string;
  estadoDoJob?: string;
}
export interface PedidoDaRevisao {
  estado: 'present' | 'unavailable' | 'excluded_by_limit' | 'not_applicable';
  tipoTurno: string;
  gatilhoEm: string;
  mensagem: { id: string; text: string; at: string; origem: string } | null;
}
type Registro = Record<string, unknown>;
export interface FontesDoAtendimento {
  contato: Registro | null; negocios: Registro[]; notas: Registro[]; atividades: Registro[];
  propostas: Registro[]; agenda: Registro[]; retornos: Registro[]; caso: Registro[];
  job: Registro | null; conversa: Registro | null;
  policy?: unknown;
  auxiliares?: Registro[];
  produtos?: Registro[];
}
const string = (v: unknown): string => typeof v === 'string' ? v : '';
const object = (v: unknown): Registro => v && typeof v === 'object' && !Array.isArray(v) ? v as Registro : {};
const array = (v: unknown): Registro[] => Array.isArray(v) ? v.map(object) : [];
const provenienciaDaAcao = z.object({
  versao: z.literal(1), origem: z.literal('next_action_authenticated'),
  papel: z.enum(['agent', 'manager', 'admin']), proposta_seq: z.number().int().nonnegative(),
});
export function contextoDoAtendimentoIndisponivel(): ContextoDoAtendimento {
  return { versao: 1, fingerprint: 'fontes_indisponiveis', perfil: [], decisoes: [], operacoes: [], continuidade: [],
    cobertura: (['perfil', 'decisoes', 'operacoes', 'continuidade'] as const).map(categoria => ({ categoria, estado: 'unavailable', encontrados: 0, selecionados: 0, omitidos: 0 })) };
}

/** Sem extração por LLM, sem inventar beneficiário, verificação ou papel histórico. */
export function normalizarFontesDoAtendimento(f: FontesDoAtendimento, tenantId: string): ContextoDoAtendimento {
  if (!f.contato || f.contato.organization_id !== tenantId) return contextoDoAtendimentoIndisponivel();
  const out = contextoDoAtendimentoIndisponivel();
  out.estadoDoJob = f.job ? string(f.job.status) : 'unavailable';
  const policy = object(f.policy);
  if (Object.hasOwn(policy, 'timezone')) out.fuso = fusoValido(string(policy.timezone)) ? string(policy.timezone) : FUSO_PADRAO;
  out.auxiliaresRevalidados = f.auxiliares !== undefined;
  if (Object.hasOwn(policy, 'skills')) out.skillsVigentes = array(policy.skills).map(s => string(s.version));
  out.validacaoComercial = {
    fontes: array(policy.sources).map(s => ({ id: string(s.id), ativa: s.active === true,
      revisao: createHash('sha256').update(JSON.stringify(s)).digest('hex') })),
    produtos: (f.produtos ?? []).map(p => ({ codigo: string(p.codigo), nome: string(p.nome), descricao: string(p.descricao),
      preco: formatCents(Number(p.preco_cents), string(p.moeda) || 'BRL'),
      disponivel: p.ativo === true && (!p.controla_estoque || Number(p.quantidade) > 0) })),
  };
  const mensagem = object(f.job?.canonical_message);
  const texto = string(mensagem.text);
  const tipoTurno = string(f.job?.kind);
  const requerMensagem = tipoTurno === 'inbound_turn' || tipoTurno === 'case_reply_turn';
  out.pedido = { estado: texto.length > 8000 ? 'excluded_by_limit' : string(mensagem.id) ? 'present' : requerMensagem ? 'unavailable' : 'not_applicable',
    tipoTurno, gatilhoEm: string(f.job?.trigger_at ?? f.job?.created_at),
    mensagem: string(mensagem.id) && texto.length <= 8000 ? { id: string(mensagem.id), text: texto, at: string(mensagem.at), origem: string(mensagem.origem) } : null };
  const encontrados: Record<CategoriaDoContexto, number> = { perfil: 0, decisoes: 0, operacoes: 0, continuidade: 0 };
  const limites = { perfil: [32, 8000], decisoes: [8, 12000], operacoes: [8, 4000], continuidade: [8, 4000] } as const;
  const chars = { perfil: 0, decisoes: 0, operacoes: 0, continuidade: 0 };
  const adicionar = (categoria: CategoriaDoContexto, r: Registro, origem: string, sujeito: string, estado: FonteDoAtendimento['estado'], dados: Registro): void => {
    encontrados[categoria]++;
    const item: FonteDoAtendimento = { id: string(r.id), origem, sujeito, em: string(r.performed_at ?? r.created_at), revisao: createHash('sha256').update(JSON.stringify(dados)).digest('hex'), estado, dados };
    const size = JSON.stringify(item).length;
    if (out[categoria].length >= limites[categoria][0] || chars[categoria] + size > limites[categoria][1]) return;
    chars[categoria] += size; out[categoria].push(item);
  };
  // Defesa em profundidade além do SQL: org e contato vêm do closure do turno.
  const contactId = string(f.contato?.id);
  const pertence = (r: Registro) => r.organization_id === tenantId && r.contact_id === contactId;
  const negocios = f.negocios.filter(pertence).sort((a,b)=>string(a.id).localeCompare(string(b.id)));
  const candidatos = negocios.map(r => ({ ...r, organization_id: tenantId })) as unknown as LeadCandidate[];
  const roteamento = resolveActiveLeadForContact(candidatos);
  const ativo = roteamento.routed ? roteamento.leadId : null;
  const alias = new Map(negocios.map((n, i) => [string(n.id), `pedido_${i + 1}`]));
  if (f.contato?.organization_id === tenantId) {
    for (const key of ['birthdate', 'tags']) if (f.contato[key] != null) adicionar('perfil', f.contato, 'cadastro_contato', 'contato', 'recorded', { campo: key, valor: f.contato[key] });
  }
  for (const n of negocios) {
    const sujeito = alias.get(string(n.id))!;
    adicionar('perfil', n, 'negocio', sujeito, 'recorded', { titulo: n.title, descricao: n.description, situacao: n.status, origem_cadastro: n.source, negocio_ativo: n.id === ativo });
    const campos = object(n.custom_fields);
    for (const [campo, valor] of Object.entries(campos)) {
      // IDs/credenciais e objetos opacos não são fatos de perfil. Só valores de campos cadastrados.
      const defs = array(n.field_definitions);
      const def = defs.find(d => d.key === campo || d.id === campo);
      if (!def || !['string', 'number', 'boolean'].includes(typeof valor) && !Array.isArray(valor)) continue;
      adicionar('perfil', n, 'campo_crm', sujeito, n.source === 'form' || n.source === 'formulario' ? 'declared' : 'recorded', { campo: string(def.label ?? def.name) || campo, valor });
    }
  }
  const notas = f.notas.filter(pertence);
  for (const n of notas.slice(0,8)) adicionar('perfil', n, 'memoria_do_agente', 'contato_sem_beneficiario_inferido', 'recorded', { titulo: n.headline, texto: n.body, autoridade: 'memoria_auxiliar_nao_verificada' });
  const auxiliares = (f.auxiliares ?? []).filter(m => m.organization_id === tenantId);
  for (const m of auxiliares.slice(0,8)) adicionar('perfil', m, 'memoria_org', 'organizacao', 'recorded', { texto:m.body,autoridade:'fonte_auxiliar_nao_aprovacao_individual_ou_recibo' });
  encontrados.perfil += Math.max(0,notas.length-8) + Math.max(0,auxiliares.length-8);
  for (const a of f.atividades.filter(pertence)) {
    if (!alias.has(string(a.lead_id))) continue;
    const p = object(a.payload), provenance = provenienciaDaAcao.safeParse(p.review_context_v1);
    const humana = a.actor_kind === 'user' && !!a.performed_by_user_id;
    const maisNova = f.atividades.some(n => pertence(n) && n.lead_id === a.lead_id &&
      (n.type === 'next_action_approved' || n.type === 'next_action_dismissed') &&
      `${string(n.performed_at)}|${string(n.id)}` > `${string(a.performed_at)}|${string(a.id)}`);
    const atual = humana && provenance.success && !maisNova && a.lead_id === ativo && provenance.data.proposta_seq === a.current_action_seq;
    if (a.type === 'next_action_approved' || a.type === 'next_action_dismissed') {
      adicionar('decisoes', a, 'proxima_acao', alias.get(string(a.lead_id))!, 'recorded', {
        acao: p.next_action, decisao: a.type === 'next_action_approved' ? 'aprovada' : 'recusada',
        proveniencia: humana ? provenance.success ? 'authenticated' : 'historical_role_unknown' : 'unverifiable',
        papel: humana && provenance.success ? provenance.data.papel : null,
        validade: atual ? 'valid' : 'unverifiable_or_superseded', alcance: 'acao_da_proposta_original',
        significado: 'decisao_sobre_acao_nao_recibo_de_execucao',
      });
    } else if (a.type === 'note_added' && humana) adicionar('perfil', a, 'nota_humana_no_crm', alias.get(string(a.lead_id))!, 'recorded', { texto: a.reason, significado: 'registro_humano_nao_aprovacao_comercial' });
  }
  for (const p of f.propostas.filter(pertence)) {
    if (!alias.has(string(p.lead_id))) continue;
    adicionar('operacoes', p, 'proposta', alias.get(string(p.lead_id))!, 'verified', { titulo: p.titulo, estado: p.status, decidida_em: p.decided_at, motivo: p.decision_reason, significado: 'estado_da_proposta_nao_pagamento_ou_matricula' });
  }
  for (const a of f.agenda.filter(pertence)) adicionar('operacoes', a, 'agenda_persistida', 'contato', 'verified', { titulo: a.title, estado: a.status, inicio: a.starts_at, fim: a.ends_at, fuso: a.time_zone, cancelada_em: a.cancelled_at, significado: 'registro_da_agenda_nao_presenca' });
  for (const c of f.retornos.filter(pertence)) adicionar('operacoes', c, 'callback_ia', 'contato', 'verified', { agendado_para: c.next_run_at, habilitado: c.enabled, cancelado_em: c.cancelled_at, promessa: c.promise, motivo: c.reason, significado: 'retorno_da_ia_nao_telefonema_humano' });
  for (const c of f.caso.filter(pertence)) adicionar('continuidade', c, 'caso_humano', 'contato', 'recorded', { estado: c.status, pergunta_humana: c.human_ask, resposta_cliente: c.lead_update, significado: 'resposta_do_cliente_nao_verificacao' });
  if (f.job && pertence(f.job)) adicionar('continuidade', f.job, 'gatilho_persistido', 'contato', 'verified', { tipo_turno: f.job.kind, modo: f.job.mode, proposito: f.job.purpose, motivo: f.job.reason, promessa_anterior: f.job.promise, prometido_em: f.job.promised_at, fluxo: f.job.flow_kind, significado: 'gatilho_nao_nova_promessa' });
  if (f.conversa && pertence(f.conversa)) adicionar('continuidade', f.conversa, 'estado_atual', 'contato', 'verified', { atendimento: f.conversa.service_revision, em_comando_humano: f.conversa.force_human, significado: 'nao_autoriza_envio_durante_takeover' });
  out.cobertura = (Object.keys(encontrados) as CategoriaDoContexto[]).map(categoria => ({ categoria,
    estado: encontrados[categoria] > out[categoria].length ? 'excluded_by_limit' : encontrados[categoria] ? 'present' : 'not_found',
    encontrados: encontrados[categoria], selecionados: out[categoria].length, omitidos: encontrados[categoria] - out[categoria].length,
  }));
  if (negocios.length > 8 || !roteamento.routed && roteamento.reason === 'ambiguous_open_leads') out.cobertura.find(c => c.categoria === 'perfil')!.estado = 'conflicting';
  for (const [categoria, rows] of [['perfil', f.notas], ['decisoes', f.atividades], ['operacoes', [...f.propostas, ...f.agenda, ...f.retornos]], ['continuidade', f.caso]] as const) {
    if (rows.length > 8) out.cobertura.find(c => c.categoria === categoria)!.estado = 'excluded_by_limit';
  }
  out.fingerprint = createHash('sha256').update(JSON.stringify({ contexto: out, scope:f.conversa,policy:f.policy, jobState:f.job?.status,
    autores:f.atividades.filter(pertence).map(a=>({id:a.id,actor_kind:a.actor_kind,autor:a.performed_by_user_id,payload:a.payload,current_seq:a.current_action_seq})) })).digest('hex');
  return out;
}

/** Um read agrupado, sem rede/LLM; não consulta contas, credenciais, tokens ou conteúdo de outra pessoa. */
export async function carregarContextoDoAtendimento(db: Queryable, ids: { tenantId: string; leadId: string; conversationId: string; jobId?: string; knowledgeSourceIds?: readonly string[]; skillVersionIds?: readonly string[]; productCodes?: readonly string[] }): Promise<ContextoDoAtendimento> {
  const { rows } = await db.query<FontesDoAtendimento>(`with escopo as (
    select c.id,c.contact_id,c.organization_id,c.service_revision,c.current_demanda_id,ct.force_human from conversations c
    join contacts ct on ct.id=c.contact_id and ct.organization_id=c.organization_id
    where c.organization_id=$1 and c.contact_id=$2 and c.id=$3 and not c.is_group and not ct.is_anonymized
  ) select
    (select jsonb_build_object('id',id,'organization_id',organization_id,'birthdate',birthdate,'tags',tags,'updated_at',updated_at) from contacts where organization_id=$1 and id=$2) as contato,
    (select coalesce(jsonb_agg(x),'[]') from (select l.id,l.organization_id,l.contact_id,l.pipeline_id,l.title,l.description,l.status,l.source,l.custom_fields,l.created_at,l.updated_at,l.last_activity_at,p.settings->'fields' as field_definitions from crm_leads l join crm_pipelines p on p.id=l.pipeline_id and p.organization_id=l.organization_id where l.organization_id=$1 and l.contact_id=$2 order by l.updated_at desc,l.id limit 9) x) as negocios,
    (select coalesce(jsonb_agg(x),'[]') from (select id,organization_id,contact_id,headline,body,created_at,updated_at from lead_notes where organization_id=$1 and contact_id=$2 order by created_at desc,id limit 9) x) as notas,
    (select coalesce(jsonb_agg(x),'[]') from (select a.id,a.organization_id,a.contact_id,a.lead_id,a.type,a.payload,a.reason,a.actor_kind,a.performed_by_user_id,a.performed_at,s.next_action_seq as current_action_seq from crm_lead_activities a join crm_leads l on l.id=a.lead_id and l.organization_id=a.organization_id and l.contact_id=a.contact_id left join lead_state s on s.organization_id=a.organization_id and s.contact_id=a.contact_id where a.organization_id=$1 and a.contact_id=$2 and a.type in ('next_action_approved','next_action_dismissed','note_added') order by a.performed_at desc,a.id limit 9) x) as atividades,
    (select coalesce(jsonb_agg(x),'[]') from (select id,organization_id,contact_id,lead_id,titulo,status,decided_at,decision_reason,created_at,updated_at from crm_proposals where organization_id=$1 and contact_id=$2 and (conversation_id=$3 or conversation_id is null) and status<>'rascunho' order by updated_at desc,id limit 9) x) as propostas,
    (select coalesce(jsonb_agg(x),'[]') from (select id,organization_id,contact_id,title,status,starts_at,ends_at,time_zone,cancelled_at,created_at,updated_at from calendar_appointments where organization_id=$1 and contact_id=$2 and conversation_id=$3 order by updated_at desc,id limit 9) x) as agenda,
    (select coalesce(jsonb_agg(x),'[]') from (select id,organization_id,contact_id,next_run_at,enabled,cancelled_at,payload->>'promise' as promise,payload->>'reason' as reason,created_at,updated_at from cron_jobs where organization_id=$1 and contact_id=$2 and job_kind='followup_turn' and payload->>'conversation_id'=$3::text order by updated_at desc,id limit 9) x) as retornos,
    (select coalesce(jsonb_agg(x),'[]') from (select ac.id,ac.organization_id,c.contact_id,ac.status,
      (select body from agent_case_events where organization_id=$1 and case_id=ac.id and kind='human_replied' and human_action='need_lead_info' and actor_kind='human' and actor_user_id is not null order by created_at desc,id limit 1) as human_ask,
      (select body from agent_case_events where organization_id=$1 and case_id=ac.id and kind='lead_provided' and actor_kind='lead' order by created_at desc,id limit 1) as lead_update,
      ac.created_at,ac.updated_at from agent_cases ac join conversations c on c.id=ac.conversation_id and c.organization_id=ac.organization_id where ac.organization_id=$1 and c.contact_id=$2 and c.id=$3 and ac.status in ('awaiting_lead','awaiting_human') order by ac.updated_at desc,ac.id limit 9) x) as caso,
    (select jsonb_build_object('id',j.id,'organization_id',j.organization_id,'contact_id',j.contact_id,'kind',j.kind,'status',j.status,'created_at',j.created_at,
      'trigger_at',coalesce(e.created_at,j.created_at),'mode',j.payload->>'mode','purpose',j.payload->>'purpose','reason',j.payload->>'reason','promise',j.payload->>'promise','promised_at',j.payload->>'promised_at',
      'flow_kind',case when j.payload ? 'fixed_body' then 'fixed_text' when j.payload->>'purpose' in ('classify','plan_timing') then 'internal_task' else 'ai_reentry' end,
      'canonical_message',(select jsonb_build_object('id',m.id,'text',coalesce(m.media_derived_text,m.body,''),'at',m.sent_at,'origem',case when m.media_derived_text is not null then 'media_derived' else 'client_message' end)
        from messages m join escopo s on s.id=m.conversation_id and s.organization_id=m.organization_id
        where m.organization_id=$1 and m.conversation_id=$3 and m.contact_id=$2 and m.direction='inbound' and m.service_revision=s.service_revision
          and (m.demanda_id is not distinct from s.current_demanda_id or m.demanda_id is null)
          and m.id::text=case when j.kind='inbound_turn' then j.payload->>'inbound_message_id' when j.kind='case_reply_turn' then ac.context_snapshot->>'request_message_id' end))
      from job_queue j left join agent_case_events e on j.kind='case_reply_turn'
        and (e.id::text=j.payload->>'human_event_id' or (not j.payload ? 'human_event_id' and e.metadata->>'legacy_reply_job_id'=j.id::text))
        and e.case_id::text=j.payload->>'case_id'
        and e.organization_id=j.organization_id and e.kind='human_replied' and e.actor_kind='human' and e.actor_user_id is not null
      left join agent_cases ac on ac.id=e.case_id and ac.organization_id=e.organization_id and ac.conversation_id=$3
      where j.organization_id=$1 and j.contact_id=$2 and j.id=$4::uuid) as job,
    (select to_jsonb(escopo) from escopo) as conversa,
    (select coalesce(jsonb_agg(jsonb_build_object('codigo',codigo,'nome',nome,'descricao',descricao,'preco_cents',preco_cents,'moeda',moeda,'controla_estoque',controla_estoque,'quantidade',quantidade,'ativo',ativo) order by codigo),'[]')
      from catalog_products where organization_id=$1 and codigo=any($7::text[])) as produtos,
    (select coalesce(jsonb_agg(x),'[]') from (
      select 'documento' as id,p.organization_id,v.content as body,v.created_at from org_memory_pointers p join org_memory_versions v on v.id=p.version_id and v.organization_id=p.organization_id where p.organization_id=$1
      union all select e.id::text,e.organization_id,e.title || E'\n' || e.body,e.created_at from org_memory_entries e where e.organization_id=$1 and e.status='active' order by created_at desc limit 9) x) as auxiliares,
    (select jsonb_build_object('jev',settings->'jev','timezone',timezone,
      'promise_table',(select version_id from promise_table_pointers where organization_id=$1),
      'bindings',(select jsonb_agg(jsonb_build_object('purpose',purpose,'provider',provider,'model',model_id,'credential',credential_id,'enabled',is_enabled,'base',base_url) order by purpose) from ai_purpose_bindings where organization_id=$1 and purpose in ('promise_semantic','human_return_confirmation')),
      'sources',(select jsonb_agg(jsonb_build_object('id',id,'active',is_active,'version',active_kb_version_id,'content_hash',content_hash) order by id) from ai_knowledge_sources where organization_id=$1 and id=any($5::uuid[])),
      'skills',(select jsonb_agg(jsonb_build_object('name',name,'version',version_id) order by name) from skill_pointers where organization_id=$1 and version_id=any($6::uuid[]))) from organizations where id=$1) as policy
    from escopo`, [ids.tenantId, ids.leadId, ids.conversationId, ids.jobId ?? null, ids.knowledgeSourceIds ?? [], ids.skillVersionIds ?? [], ids.productCodes ?? []]);
  if (!rows[0]) return contextoDoAtendimentoIndisponivel();
  return normalizarFontesDoAtendimento(rows[0], ids.tenantId);
}

export { projetarContextoDoAtendimento } from '../guardrails/promise/projecao-atendimento';

/** Leituras já autorizadas do loop, capturadas pelo servidor; sem confiar em texto devolvido pelo modelo. */
export function criarFontesConsultadasDoTurno(observadoEm: string) {
  const consultadas = new Map<string, FonteDoAtendimento>();
  const registry = {
    registrar(origem: 'memoria_org' | 'skill_ativa' | 'referencia_skill' | 'nota_memoria', referenciaPrivada: string, texto: string, versaoSkill?: string): void {
      if (!texto.trim()) return;
      consultadas.set(`${origem}:${referenciaPrivada}`, { id: referenciaPrivada, origem, sujeito: origem === 'nota_memoria' ? 'contato_sem_beneficiario_inferido' : 'organizacao',
        em: '', revisao: createHash('sha256').update(texto).digest('hex'), estado: 'recorded', ...(versaoSkill ? {versaoSkill} : {}),
        dados: { texto, observado_em: observadoEm, autoridade: 'fonte_auxiliar_nao_aprovacao_individual_ou_recibo' } });
    },
    aplicar(base: ContextoDoAtendimento): ContextoDoAtendimento {
      const perfil = [...base.perfil];let omitidos = 0;let adicionais = 0;
      for (const item of consultadas.values()) {
        // Corpo efetivamente consultado tem prioridade sobre sua cópia inicial.
        const idx=perfil.findIndex(p=>p.id===item.id && (p.origem==='memoria_do_agente' || p.origem===item.origem));
        if (idx<0) adicionais++;
        if (item.origem==='memoria_org' && base.auxiliaresRevalidados) {
          // A leitura atual vence também quando a entrada foi retirada. Não ressuscitar o snapshot.
          if (idx<0) omitidos++;
          continue;
        }
        if (item.origem==='skill_ativa' && base.skillsVigentes && !base.skillsVigentes.includes(item.id)) { omitidos++; continue; }
        if (item.origem==='referencia_skill' && item.versaoSkill && base.skillsVigentes && !base.skillsVigentes.includes(item.versaoSkill)) { omitidos++; continue; }
        if(idx>=0)perfil.splice(idx,1);
        if(perfil.length>=32 || JSON.stringify([...perfil,item]).length>8000){omitidos++;continue;}
        perfil.push(item);
      }
      const cobertura=base.cobertura.map(c=>c.categoria!=='perfil'?c:{...c,estado:omitidos?'excluded_by_limit' as const:c.estado==='not_found' && perfil.length?'present' as const:c.estado,
        encontrados:c.encontrados+adicionais,selecionados:perfil.length,omitidos:c.omitidos+omitidos});
      const result={...base,perfil,cobertura};
      return {...result,fingerprint:createHash('sha256').update(JSON.stringify({base:base.fingerprint,consultadas:[...consultadas.values()],cobertura})).digest('hex')};
    },
    registrarMemoriaDaTool(resultado: unknown): void {
      const r=object(resultado);
      if(r.ok===false || r.error || r.erro)return;
      for(const n of array(r.anotacoes)) if(string(n.id) && string(n.body)) registry.registrar('memoria_org',string(n.id),`${string(n.title)}\n${string(n.body)}`);
    },
    skillVersionIds(): string[] { return [...new Set([...consultadas.values()].flatMap(v=>v.origem==='skill_ativa'?[v.id]:v.versaoSkill?[v.versaoSkill]:[]))]; },
  };
  return registry;
}
