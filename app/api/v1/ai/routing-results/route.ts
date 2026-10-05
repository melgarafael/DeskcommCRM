import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { fail, ok } from '@/lib/api/wrappers';
import { requireRole } from '@/lib/auth/require-role';
import { roleAtLeast } from '@/lib/auth/types';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  dias: z.coerce.number().int().min(1).max(90).default(30),
  router_id: z.string().uuid().optional(),
  modo: z.enum(['tradicional_comparacao', 'jev_comparacao', 'jev_sob_demanda']).optional(),
  contexto: z.coerce.number().int().min(0).max(16).optional(),
  modelo: z.string().min(1).max(128).optional(),
});

interface Linha {
  id: string; router_id: string; conversation_id: string | null; message_id: string | null;
  job_id: string | null; modo: string; context_message_count: number; origem: string;
  motivo_reserva: string | null; intent_jev: string | null; intent_tradicional: string | null;
  intent_final: string | null; agent_id_final: string | null; confianca_final: number | null;
  modelo_jev: string | null; custo_jev_cents: number | null; custo_tradicional_cents: number | null;
  custo_incompleto: boolean; tempo_total_ms: number; revisao: string | null;
  revisado_em: string | null; agent_id_esperado: string | null; created_at: string;
}

const quantil = (n: number[], q: number) => n.length ? n[Math.ceil(q * n.length) - 1] ?? null : null;

export async function GET(req: NextRequest): Promise<Response> {
  const authz = await requireRole('manager', { resource: 'jev_router_decisions' });
  if (!authz.ok) return authz.response;
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return fail('invalid_query', 'Filtros inválidos.', 422, { details: parsed.error.issues });
  const filtro = parsed.data;
  const db = createAdminClient();
  // O type gerado será atualizado pelo pipeline do schema; a tabela é criada
  // pela migration desta feature, e toda consulta filtra a organização da sessão.
  let q = db.from('jev_router_decisions' as 'jev_observacoes').select('*')
    .eq('organization_id', authz.org.orgId)
    .gte('created_at', new Date(Date.now() - filtro.dias * 86400000).toISOString())
    .order('created_at', { ascending: false }).limit(500);
  if (filtro.router_id) q = q.eq('router_id', filtro.router_id);
  if (filtro.modo) q = q.eq('modo', filtro.modo);
  if (filtro.contexto !== undefined) q = q.eq('context_message_count', filtro.contexto);
  const { data, error } = await q;
  if (error) return fail('query_failed', 'Não foi possível carregar o roteamento.', 500);
  const linhas = (data ?? []) as unknown as Linha[];
  const ids = linhas.flatMap((l) => l.message_id ? [l.message_id] : []);
  const jobs = [...new Set(linhas.flatMap((l) => l.job_id ? [l.job_id] : []))];
  const routers = [...new Set(linhas.map((l) => l.router_id))];
  const [obs, chamadas, membros, roteadores] = await Promise.all([
    ids.length ? db.from('jev_observacoes').select('message_id,rotulo_jev,rotulo_atual,intencao_jev,intencao_atual,concordou,modelo')
      .eq('organization_id', authz.org.orgId).eq('tarefa', 'roteador').in('message_id', ids) : Promise.resolve({ data: [], error: null }),
    jobs.length ? db.from('llm_calls').select('job_id,provider,cost_cents,model')
      .eq('organization_id', authz.org.orgId).eq('purpose', 'intent_router').in('job_id', jobs).limit(1500) : Promise.resolve({ data: [], error: null }),
    routers.length ? db.from('ai_router_members').select('router_id,agent_id,intent_name')
      .eq('organization_id', authz.org.orgId).in('router_id', routers) : Promise.resolve({ data: [], error: null }),
    routers.length ? db.from('ai_routers').select('id,name')
      .eq('organization_id', authz.org.orgId).in('id', routers) : Promise.resolve({ data: [], error: null }),
  ]);
  if (obs.error || chamadas.error || membros.error || roteadores.error) return fail('query_failed', 'Não foi possível carregar as medições.', 500);
  const porMensagem = new Map((obs.data ?? []).map((o) => [o.message_id, o]));
  const porJob = new Map<string, Array<{ provider: string; cost_cents: number | null; model: string }>>();
  for (const c of chamadas.data ?? []) {
    if (!c.job_id) continue;
    const arr = porJob.get(c.job_id) ?? [];
    arr.push(c);
    porJob.set(c.job_id, arr);
  }
  const casos = linhas.map((l) => {
    const observacao = l.message_id ? porMensagem.get(l.message_id) : null;
    const custos = l.job_id ? porJob.get(l.job_id) ?? [] : [];
    const soma = (tipo: 'jev' | 'tradicional') => {
      const lados = custos.filter((c) => tipo === 'jev' ? c.provider === 'typesafe' : c.provider !== 'typesafe');
      return lados.length === 0 ? null : lados.some((c) => c.cost_cents === null)
        ? null : lados.reduce((total, c) => total + Number(c.cost_cents), 0);
    };
    const custoJev = custos.some((c) => c.provider === 'typesafe') ? soma('jev') : l.custo_jev_cents;
    const custoTradicional = custos.some((c) => c.provider !== 'typesafe') ? soma('tradicional') : l.custo_tradicional_cents;
    return {
      ...l,
      modelo_jev: l.modelo_jev ?? observacao?.modelo ?? null,
      intent_jev: l.intent_jev ?? observacao?.intencao_jev ?? null,
      intent_tradicional: l.intent_tradicional ?? observacao?.intencao_atual ?? null,
      destino_jev: observacao?.rotulo_jev ?? null,
      destino_tradicional: observacao?.rotulo_atual ?? null,
      concordou_destino: observacao?.concordou ?? null,
      custo_jev_cents: custoJev,
      custo_tradicional_cents: custoTradicional,
      custo_incompleto: custoJev === null || custoTradicional === null,
    };
  }).filter((l) => !filtro.modelo || l.modelo_jev === filtro.modelo);
  const tempos = casos.map((l) => l.tempo_total_ms).sort((a, b) => a - b);
  const pares = casos.filter((l) => l.modo !== 'jev_sob_demanda' && l.concordou_destino !== null);
  const paresIntencao = pares.filter((l) => l.intent_jev !== null && l.intent_tradicional !== null);
  const custosConhecidos = casos.filter((l) => !l.custo_incompleto);
  return ok({
    casos,
    membros: membros.data ?? [],
    roteadores: roteadores.data ?? [],
    pode_revisar: roleAtLeast(authz.org.role, 'admin'),
    resumo: {
      total: casos.length, limite_amostra: 500, periodo_dias: filtro.dias,
      sem_reserva: casos.filter((l) => l.modo === 'jev_sob_demanda' && l.origem === 'jev').length,
      reservas: casos.filter((l) => l.origem === 'reserva').length,
      motivos_reserva: Object.fromEntries(['falha_jev','baixa_confianca','sem_intencao','intencao_invalida'].map((m) => [m, casos.filter((l) => l.motivo_reserva === m).length])),
      custo_total_cents: custosConhecidos.reduce((s, l) => s + Number(l.custo_jev_cents ?? 0) + Number(l.custo_tradicional_cents ?? 0), 0),
      custos_incompletos: casos.length - custosConhecidos.length,
      mediana_ms: quantil(tempos, .5), p95_ms: quantil(tempos, .95),
      comparacoes_destino: pares.length,
      concordancias_destino: pares.filter((l) => l.concordou_destino).length,
      comparacoes_intencao: paresIntencao.length,
      concordancias_intencao: paresIntencao.filter((l) => l.intent_jev === l.intent_tradicional).length,
      revisados: casos.filter((l) => l.revisao !== null).length,
      corretos_revisados: casos.filter((l) => l.revisao === 'correto').length,
    },
  });
}
