import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { fail, ok } from '@/lib/api/wrappers';
import { audit } from '@/lib/audit';
import { requireRole } from '@/lib/auth/require-role';
import { requireSupportWrite } from '@/lib/impersonate/support';
import { createAdminClient } from '@/lib/supabase/admin';

const bodySchema = z.object({
  revisao: z.enum(['correto', 'incorreto']).nullable(),
  agent_id_esperado: z.string().uuid().nullable().optional(),
}).strict().refine((v) => v.revisao === 'incorreto' || !v.agent_id_esperado, {
  message: 'Agente esperado só cabe em revisão incorreta.',
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const authz = await requireRole('admin', { requestId, resource: 'jev_router_decisions' });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return fail('invalid_request', 'ID inválido.', 400, { requestId });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail('invalid_body', 'Revisão inválida.', 422, { requestId, details: parsed.error.issues });
  const db = createAdminClient();
  const tabela = db.from('jev_router_decisions' as 'jev_observacoes');
  const { data: atual, error } = await tabela.select('id,router_id,revisao,agent_id_esperado')
    .eq('organization_id', authz.org.orgId).eq('id', id).maybeSingle();
  if (error) return fail('query_failed', 'Não foi possível carregar a decisão.', 500, { requestId });
  if (!atual) return fail('not_found', 'Decisão não encontrada.', 404, { requestId });
  const antes = atual as unknown as { router_id: string; revisao: string | null; agent_id_esperado: string | null };
  const esperado = parsed.data.revisao === 'incorreto' ? parsed.data.agent_id_esperado ?? null : null;
  if (esperado) {
    const membro = await db.from('ai_router_members').select('agent_id')
      .eq('organization_id', authz.org.orgId).eq('router_id', antes.router_id).eq('agent_id', esperado).maybeSingle();
    if (membro.error) return fail('query_failed', 'Não foi possível conferir o agente esperado.', 500, { requestId });
    if (!membro.data) return fail('invalid_body', 'Escolha um agente deste roteador.', 422, { requestId });
  }
  if (antes.revisao === parsed.data.revisao && antes.agent_id_esperado === esperado) {
    return ok({ alterado: false }, { requestId });
  }
  const { error: updateError } = await db.from('jev_router_decisions' as 'jev_observacoes')
    .update({ revisao: parsed.data.revisao, agent_id_esperado: esperado,
      revisado_por: parsed.data.revisao ? authz.user.id : null,
      revisado_em: parsed.data.revisao ? new Date().toISOString() : null } as never)
    .eq('organization_id', authz.org.orgId).eq('id', id);
  if (updateError) return fail('save_failed', 'Não foi possível salvar a revisão.', 500, { requestId });
  void audit({ action: 'ai.router_decision_reviewed', organizationId: authz.org.orgId,
    actorUserId: authz.user.id, resourceType: 'ai_router_decision', resourceId: id,
    requestId, metadata: { revisao: parsed.data.revisao, agent_id_esperado: esperado } });
  return ok({ alterado: true }, { requestId });
}
