import { describe, expect, it } from 'vitest';
import {
  criarFontesConsultadasDoTurno,
  normalizarFontesDoAtendimento,
  projetarContextoDoAtendimento,
  type FontesDoAtendimento,
} from './contexto-do-atendimento';

const org = '11111111-1111-4111-8111-111111111111';
const contact = '22222222-2222-4222-8222-222222222222';
const at = '2026-10-16T10:00:00Z';
function fontes(memory: string): FontesDoAtendimento {
  return {
    contato: { id: contact, organization_id: org, tags: ['adulto'], updated_at: at },
    negocios: [], notas: [{ id: 'nota', organization_id: org, contact_id: contact,
      body: 'Preferência registrada; não autoriza condições comerciais.', created_at: at }],
    atividades: [], propostas: [], agenda: [], retornos: [], caso: [], job: null, conversa: null,
    auxiliares: [{ id: 'documento', organization_id: org, body: memory, created_at: at }],
  };
}

describe('orçamento das fontes completas da revisão', () => {
  it('entrega memória geral acima de 8k e três skills completas, sem perder perfil individual', () => {
    const memory = 'm'.repeat(10300) + ' CONDICAO_FINAL: confirmar a publicação antes de orientar.';
    const registry = criarFontesConsultadasDoTurno(at);
    registry.registrar('memoria_org', 'documento', memory);
    const skills = [2591, 2311, 4721].map((size, i) => `skill${i}:` + 's'.repeat(size - 7));
    skills.forEach((body, i) => registry.registrar('skill_ativa', `skill-${i}`, body));
    const ctx = registry.aplicar(normalizarFontesDoAtendimento(fontes(memory), org));
    const projected = projetarContextoDoAtendimento(ctx);
    expect(ctx.perfil.find(f => f.origem === 'memoria_org')?.dados.texto).toBe(memory);
    expect(ctx.perfil.filter(f => f.origem === 'skill_ativa').map(f => f.dados.texto)).toEqual(skills);
    expect(ctx.perfil.some(f => f.origem === 'memoria_do_agente')).toBe(true);
    expect(ctx.cobertura.find(c => c.categoria === 'perfil')).toMatchObject({
      estado: 'present', encontrados: 6, selecionados: 6, omitidos: 0,
    });
    expect(JSON.stringify(projected)).toContain('CONDICAO_FINAL');
    expect(ctx.decisoes).toEqual([]);
    expect(ctx.perfil.find(f => f.origem === 'memoria_org')?.dados.autoridade)
      .toBe('fonte_auxiliar_nao_aprovacao_individual_ou_recibo');
  });

  it('aceita a mesma memória consultada quando a releitura não está disponível, sem fabricar aprovação', () => {
    const f = fontes('');
    delete f.auxiliares;
    const registry = criarFontesConsultadasDoTurno(at);
    const memory = 'm'.repeat(10000) + ' RESSALVA_FINAL';
    registry.registrar('memoria_org', 'documento', memory);
    const ctx = registry.aplicar(normalizarFontesDoAtendimento(f, org));
    expect(ctx.perfil.find(s => s.origem === 'memoria_org')?.dados.texto).toBe(memory);
    expect(ctx.decisoes).toEqual([]);
  });

  it('continua excluindo a memória inteira quando ela ultrapassa os 24k disponíveis', () => {
    const memory = 'm'.repeat(24001) + ' RESSALVA_QUE_NAO_PODE_SER_CORTADA';
    const ctx = normalizarFontesDoAtendimento(fontes(memory), org);
    expect(ctx.perfil.some(f => f.origem === 'memoria_org')).toBe(false);
    expect(JSON.stringify(projetarContextoDoAtendimento(ctx))).not.toContain('RESSALVA_QUE');
    expect(ctx.cobertura.find(c => c.categoria === 'perfil')).toMatchObject({
      estado: 'excluded_by_limit', omitidos: 1,
    });
  });

  it('mantém o teto total organizacional e os limites próprios das skills e referências', () => {
    const registry = criarFontesConsultadasDoTurno(at);
    registry.registrar('skill_ativa', 'primeira', 's'.repeat(7000));
    registry.registrar('skill_ativa', 'segunda', 's'.repeat(7000) + ' ULTIMA_SKILL');
    registry.registrar('referencia_skill', 'grande', 'r'.repeat(8001) + ' ULTIMA_REFERENCIA');
    const ctx = registry.aplicar(normalizarFontesDoAtendimento(fontes('m'.repeat(17000)), org));
    expect(ctx.perfil.find(f => f.origem === 'memoria_org')?.dados.texto).toHaveLength(17000);
    expect(JSON.stringify(ctx.perfil)).not.toContain('ULTIMA_SKILL');
    expect(JSON.stringify(ctx.perfil)).not.toContain('ULTIMA_REFERENCIA');
    expect(ctx.cobertura.find(c => c.categoria === 'perfil')?.estado).toBe('excluded_by_limit');
  });
});

describe('hora de parede dos recibos relidos', () => {
  it.each(['2026-10-16T17:40:00Z', '2026-10-16T17:40:00+00:00'])(
    'expõe o mesmo instante %s no fuso persistido, sem exigir aritmética do modelo', inicio => {
      const f = fontes('Política geral.');
      f.agenda = [{ id: 'reserva', organization_id: org, contact_id: contact,
        starts_at: inicio, ends_at: '2026-10-16T18:20:00Z', time_zone: 'America/Sao_Paulo', status: 'confirmed' }];
      const ctx = normalizarFontesDoAtendimento(f, org);
      expect(ctx.operacoes[0]?.dados).toMatchObject({ inicio, fuso: 'America/Sao_Paulo',
        horario_local_estado: 'present', inicio_local: '2026-10-16T14:40:00-03:00',
        fim_local: '2026-10-16T15:20:00-03:00', quando_local: 'sexta-feira 16/10 às 14:40' });
      expect(ctx.decisoes).toEqual([]);
    },
  );
  it('não corrige uma gravação errada para fazê-la coincidir com a escolha', () => {
    const f = fontes('Política geral.');
    f.agenda = [{ id: 'reserva', organization_id: org, contact_id: contact,
      starts_at: '2026-10-16T14:40:00Z', time_zone: 'America/Sao_Paulo' }];
    expect(normalizarFontesDoAtendimento(f, org).operacoes[0]?.dados.inicio_local)
      .toBe('2026-10-16T11:40:00-03:00');
  });
  it.each([
    { starts_at: 'invalido', time_zone: 'America/Sao_Paulo' },
    { starts_at: '2026-10-16T17:40:00Z', time_zone: 'Fuso/Inexistente' },
    { starts_at: '2026-10-16T17:40:00Z' },
  ])('não fabrica hora local com instante/fuso indisponível: %j', agenda => {
    const f = fontes('Política geral.');
    f.agenda = [{ id: 'reserva', organization_id: org, contact_id: contact, ...agenda }];
    const dados = normalizarFontesDoAtendimento(f, org).operacoes[0]?.dados;
    expect(dados?.horario_local_estado).toBe('unavailable');
    expect(dados).not.toHaveProperty('inicio_local');
  });
});
