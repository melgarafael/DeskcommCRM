import { describe, expect, it, vi } from 'vitest';
import { loadSkills, recentInboundSignal } from './skills';

describe('loadSkills', () => {
  it('loadSkills expõe versionId de cada skill', async () => {
    const rows = [{ organization_id: null, id: 'ver-1', name: 'frete', description: 'd', body: 'b', matcher: { any_keywords: ['frete'] } }];
    const db = { query: vi.fn().mockResolvedValue({ rows }) } as never;
    const skills = await loadSkills(db, 'org1');
    expect(skills[0]?.versionId).toBe('ver-1');
  });
});

describe('recentInboundSignal', () => {
  const msg = (direction: 'inbound' | 'outbound', body: string) => ({ direction, body, sent_at: '' });

  it('junta as últimas inbound (o contexto mantém a skill viva)', () => {
    const sinal = recentInboundSignal([
      msg('inbound', 'Cb 300'),
      msg('outbound', 'Tenho sim...'),
      msg('inbound', 'A 2025'),
    ]);
    expect(sinal).toContain('Cb 300');
    expect(sinal).toContain('A 2025');
  });

  it('ignora outbound e respeita a janela', () => {
    const sinal = recentInboundSignal(
      [msg('inbound', 'a'), msg('inbound', 'b'), msg('inbound', 'c')],
      2,
    );
    expect(sinal).not.toContain('a');
    expect(sinal).toContain('b');
    expect(sinal).toContain('c');
  });
});
