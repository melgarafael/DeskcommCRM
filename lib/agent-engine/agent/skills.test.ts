import { describe, expect, it, vi } from 'vitest';
import { loadSkills, matchSkills, recentInboundSignal, skillMatcherSchema, type LoadedSkill } from './skills';

const skill = (name: string, matcher: LoadedSkill['matcher']): LoadedSkill => ({
  versionId: `v-${name}`,
  name,
  description: 'd',
  body: `corpo de ${name}`,
  matcher,
  manifest: [],
});

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

describe('matchSkills — etiqueta da conversa ou do contato (any_tags)', () => {
  const prospeccao = skill('prospec-odonto', { any_keywords: ['dentista'], any_tags: ['odonto'] });
  const frete = skill('frete', { any_keywords: ['frete'] });

  it('etiqueta casa e carrega o corpo, mesmo com o cliente dizendo só "Olá"', () => {
    const r = matchSkills([prospeccao, frete], 'Olá, boa tarde', ['odonto']);
    expect(r.matched.map((s) => s.name)).toEqual(['prospec-odonto']);
    expect(r.matched[0]?.body).toBe('corpo de prospec-odonto');
  });

  it('etiqueta ausente não carrega a skill', () => {
    const r = matchSkills([prospeccao], 'Olá, boa tarde', ['imobiliaria']);
    expect(r.matched).toEqual([]);
  });

  it('casa por igualdade sem caixa nem acento ("Odonto" casa "odonto")', () => {
    const r = matchSkills([prospeccao], 'Olá', ['Odonto']);
    expect(r.matched.map((s) => s.name)).toEqual(['prospec-odonto']);
  });

  it('igualdade, não substring: a etiqueta "odontologia" não casa "odonto"', () => {
    const r = matchSkills([prospeccao], 'Olá', ['odontologia']);
    expect(r.matched).toEqual([]);
  });

  it('palavra-chave continua funcionando sem nenhuma etiqueta', () => {
    const r = matchSkills([prospeccao, frete], 'quanto custa o frete?');
    expect(r.matched.map((s) => s.name)).toEqual(['frete']);
  });

  it('sinal vazio com etiqueta casa; sinal vazio sem etiqueta não casa nada', () => {
    expect(matchSkills([prospeccao, frete], '', ['odonto']).matched.map((s) => s.name)).toEqual(['prospec-odonto']);
    expect(matchSkills([prospeccao, frete], '   ').matched).toEqual([]);
  });

  it('sinal vazio não gera near-miss, mesmo com probe casando a etiqueta', () => {
    const comProbe = skill('x', { any_keywords: ['y'], probe_keywords: ['odonto'] });
    const r = matchSkills([comProbe], '', ['odonto']);
    expect(r.missCandidates).toEqual([]);
  });

  it('skill sem any_tags segue igual a hoje, mesmo com etiquetas no turno', () => {
    const r = matchSkills([frete], 'Olá', ['odonto']);
    expect(r.matched).toEqual([]);
    expect(r.missCandidates).toEqual([]);
  });

  it('chamada sem o terceiro argumento é o comportamento de antes', () => {
    const r = matchSkills([frete], 'frete caro');
    expect(r.matched.map((s) => s.name)).toEqual(['frete']);
  });
});

describe('skillMatcherSchema — any_tags', () => {
  it('aceita any_tags opcional e recusa mais de 20 etiquetas', () => {
    expect(skillMatcherSchema.safeParse({ any_keywords: ['a'], any_tags: ['odonto'] }).success).toBe(true);
    expect(skillMatcherSchema.safeParse({ any_keywords: ['a'] }).success).toBe(true);
    const vinte = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const vinteUm = [...vinte, 'extra'];
    expect(skillMatcherSchema.safeParse({ any_keywords: ['a'], any_tags: vinte }).success).toBe(true);
    expect(skillMatcherSchema.safeParse({ any_keywords: ['a'], any_tags: vinteUm }).success).toBe(false);
  });

  it('continua exigindo any_keywords: skill só com etiqueta não passa', () => {
    expect(skillMatcherSchema.safeParse({ any_tags: ['odonto'] }).success).toBe(false);
  });
});
