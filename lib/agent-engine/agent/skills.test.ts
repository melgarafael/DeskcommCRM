import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  loadSkills,
  matchSkills,
  recentInboundSignal,
  skillMatcherSchema,
  skillsDoAgente,
  skillsPuxadasPeloRoteiro,
  type LoadedSkill,
} from './skills';

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

describe('skillsDoAgente (skills por agente, 9107)', () => {
  const todas = [
    skill('agendamento', { any_keywords: ['horário'] }),
    skill('objecao-preco', { any_keywords: ['caro'] }),
    skill('visita', { any_keywords: ['visita'] }),
  ];

  it('null = todas, na mesma ordem (o comportamento de antes)', () => {
    expect(skillsDoAgente(todas, null).map((s) => s.name)).toEqual([
      'agendamento',
      'objecao-preco',
      'visita',
    ]);
  });

  it('lista = só as marcadas, sem reordenar', () => {
    expect(skillsDoAgente(todas, ['visita', 'agendamento']).map((s) => s.name)).toEqual([
      'agendamento',
      'visita',
    ]);
  });

  it('[] = nenhuma', () => {
    expect(skillsDoAgente(todas, [])).toEqual([]);
  });

  it('nome que não existe não lança e não traz nada', () => {
    expect(skillsDoAgente(todas, ['nao-existe'])).toEqual([]);
  });

  it('o matcher sobre a lista filtrada não injeta skill de fora dela', () => {
    const doAgente = skillsDoAgente(todas, ['visita']);
    expect(matchSkills(doAgente, 'achei caro, mas quero uma visita').matched.map((s) => s.name)).toEqual([
      'visita',
    ]);
  });

  // O nó `skill` do roteiro de atendimento é a exceção declarada na tela do agente:
  // a skill que ele nomeia chega mesmo fora da lista. Sem isto, restringir a lista
  // calaria em silêncio o passo do roteiro que depende dela.
  it('roteiro puxa skill de FORA da lista do agente', () => {
    const doAgente = skillsDoAgente(todas, ['visita']);
    const casadas = matchSkills(doAgente, 'quero uma visita').matched;
    expect(skillsPuxadasPeloRoteiro(todas, ['objecao-preco'], casadas).map((s) => s.name)).toEqual([
      'objecao-preco',
    ]);
  });

  it('roteiro com lista vazia no agente ainda puxa a skill que nomeia', () => {
    expect(skillsPuxadasPeloRoteiro(todas, ['agendamento'], []).map((s) => s.name)).toEqual(['agendamento']);
  });

  it('roteiro: nome inexistente some e a já casada não repete', () => {
    const casadas = matchSkills(todas, 'quero uma visita').matched;
    expect(skillsPuxadasPeloRoteiro(todas, ['visita', 'nao-existe'], casadas)).toEqual([]);
  });

  it('o turno resolve o roteiro sobre as skills da organização, não sobre as do agente', () => {
    const fonte = readFileSync(join(process.cwd(), 'lib/agent-engine/agent/inbound-turn.ts'), 'utf8');
    expect(fonte).toMatch(/skillsPuxadasPeloRoteiro\(skills, roteiro\?\.skills \?\? \[\], skillMatch\.matched\)/);
  });
});
