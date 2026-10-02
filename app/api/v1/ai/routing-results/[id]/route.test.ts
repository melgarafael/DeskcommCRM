import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { audit } from '@/lib/audit';
import { requireRole } from '@/lib/auth/require-role';
import { requireSupportWrite } from '@/lib/impersonate/support';
import { createAdminClient } from '@/lib/supabase/admin';
import { PATCH } from './route';

vi.mock('@/lib/audit', () => ({ audit: vi.fn() }));
vi.mock('@/lib/auth/require-role', () => ({ requireRole: vi.fn() }));
vi.mock('@/lib/impersonate/support', () => ({ requireSupportWrite: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));
const ORG = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';
const ROUTER = '44444444-4444-4444-8444-444444444444';
const AGENT = '55555555-5555-4555-8555-555555555555';
let filtros: Array<[string,string,unknown]>;
let escreveu: Record<string,unknown> | null;
let achou = true;

beforeEach(() => {
  vi.clearAllMocks(); filtros = []; escreveu = null; achou = true;
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: 'u' }, org: { orgId: ORG } } as never);
  vi.mocked(createAdminClient).mockReturnValue({ from: (nome: string) => {
    const chain = {
      select: () => chain,
      update: (v: Record<string,unknown>) => { escreveu = v; return chain; },
      eq: (c: string, v: unknown) => { filtros.push([nome,c,v]); return chain; },
      maybeSingle: async () => ({ data: achou ? nome === 'jev_router_decisions'
        ? { id: ID, router_id: ROUTER, revisao: null, agent_id_esperado: null }
        : { agent_id: AGENT } : null, error: null }),
      then: (resolve: (v: unknown) => unknown) => resolve({ error: null }),
    };
    return chain;
  } } as never);
});

async function pedir(body: Record<string,unknown>) {
  const req = new NextRequest(`http://localhost/api/v1/ai/routing-results/${ID}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const res = await PATCH(req, { params: Promise.resolve({ id: ID }) });
  return { status: res.status, body: await res.json() };
}

describe('revisão humana da decisão', () => {
  it('salva revisão com agente do mesmo roteador e auditoria', async () => {
    const out = await pedir({ revisao: 'incorreto', agent_id_esperado: AGENT });
    expect(out.status).toBe(200);
    expect(escreveu).toMatchObject({ revisao: 'incorreto', agent_id_esperado: AGENT });
    expect(filtros).toContainEqual(['jev_router_decisions','organization_id',ORG]);
    expect(filtros).toContainEqual(['ai_router_members','router_id',ROUTER]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'ai.router_decision_reviewed', organizationId: ORG }));
  });

  it('não escreve decisão de outra organização nem aceita payload extra', async () => {
    achou = false;
    expect((await pedir({ revisao: 'correto' })).status).toBe(404);
    expect(escreveu).toBeNull();
    achou = true;
    expect((await pedir({ revisao: 'correto', organization_id: ORG })).status).toBe(422);
    expect(escreveu).toBeNull();
  });
});
