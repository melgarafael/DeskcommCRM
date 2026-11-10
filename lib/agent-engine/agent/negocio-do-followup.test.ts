import { describe, expect, it, vi } from 'vitest';

import { buildFlowStepOpeningMessage } from './followup-turn';
import { TETO_DA_DESCRICAO, blocoDoNegocio, carregarBlocoDoNegocio, type NegocioDoFollowup } from './negocio-do-followup';

// O card medido numa instalação real, com nomes trocados por nada sensível:
// a descrição é o contexto inteiro, e o funil não tem campo personalizado.
const CARD_DA_OBRA: NegocioDoFollowup = {
  title: 'Edvan',
  description:
    'Fiz a visita na obra dele\nsão 2 casas\nO Carlão é o Construtor e preciso falar com ele sobre o INSS da obra',
  stage_name: 'IA Começar o atendimento',
  custom_fields: {},
  pipeline_settings: { fields: [] },
};

describe('blocoDoNegocio: o card do negócio chega ao turno de IA do fluxo', () => {
  it('leva a descrição e a etapa do card — o que faltava no caso medido', () => {
    const bloco = blocoDoNegocio(CARD_DA_OBRA);
    expect(bloco).toContain('## Negócio deste contato');
    expect(bloco).toContain('Etapa atual: IA Começar o atendimento');
    expect(bloco).toContain('são 2 casas');
    expect(bloco).toContain('INSS da obra');
  });

  it('leva os campos do NEGÓCIO declarados no funil, com o rótulo e o valor legível', () => {
    const bloco = blocoDoNegocio({
      ...CARD_DA_OBRA,
      custom_fields: { tipo: 'residencial', area_m2: 180, cpf_mestre: '000', visitado: true, planta: 'https://x/y.pdf', solto: 'z' },
      pipeline_settings: {
        fields: [
          { key: 'tipo', label: 'Tipo de obra', type: 'select', options: [{ value: 'residencial', label: 'Residencial' }] },
          { key: 'area_m2', label: 'Área (m²)', type: 'number' },
          { key: 'cpf_mestre', label: 'CPF', type: 'text', escopo: 'contato' },
          { key: 'visitado', label: 'Visita feita', type: 'boolean' },
          { key: 'planta', label: 'Planta', type: 'file' },
          { key: 'vazio', label: 'Prazo', type: 'text' },
        ],
      },
    });
    expect(bloco).toContain('Tipo de obra: Residencial');
    expect(bloco).toContain('Área (m²): 180');
    expect(bloco).toContain('Visita feita: Sim');
    // campo do CONTATO, arquivo, vazio e chave sem declaração ficam fora
    expect(bloco).not.toContain('CPF');
    expect(bloco).not.toContain('Planta');
    expect(bloco).not.toContain('Prazo');
    expect(bloco).not.toContain('solto');
  });

  it('não acrescenta nada quando não há negócio, ou o card só tem título', () => {
    expect(blocoDoNegocio(null)).toBe('');
    expect(
      blocoDoNegocio({ title: 'Edvan', description: '  ', stage_name: null, custom_fields: null, pipeline_settings: null }),
    ).toBe('');
  });

  it('corta a descrição no teto e diz que cortou', () => {
    const bloco = blocoDoNegocio({ ...CARD_DA_OBRA, description: 'a'.repeat(TETO_DA_DESCRICAO + 500) });
    expect(bloco).toContain('(descrição cortada)');
    expect(bloco).not.toContain('a'.repeat(TETO_DA_DESCRICAO + 1));
  });
});

describe('carregarBlocoDoNegocio: acréscimo que nunca derruba o turno', () => {
  it('filtra pela organização e pelo contato do job', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [CARD_DA_OBRA] });
    const bloco = await carregarBlocoDoNegocio({ query } as never, 'org-1', 'contato-1');
    expect(bloco).toContain('INSS da obra');
    expect(query.mock.calls[0]![0]).toMatch(/l\.organization_id = \$1 and l\.contact_id = \$2/);
    expect(query.mock.calls[0]![1]).toEqual(['org-1', 'contato-1']);
  });

  it('leitura que falha vira bloco vazio e aviso no log', async () => {
    const warn = vi.fn();
    const query = vi.fn().mockRejectedValue(new Error('conexão caiu'));
    expect(await carregarBlocoDoNegocio({ query } as never, 'org-1', 'contato-1', { warn })).toBe('');
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('buildFlowStepOpeningMessage: a abertura do passo de fluxo não inventa combinado', () => {
  const abrir = (negocio: string, hint?: string) =>
    buildFlowStepOpeningMessage('Agora são 17:43.', ['<ritual>'], negocio, hint);

  it('não diz ao modelo que ele "havia combinado retornar"', () => {
    const texto = abrir(blocoDoNegocio(CARD_DA_OBRA), 'Dê boas-vindas.');
    expect(texto).not.toMatch(/havia combinado retornar/);
    expect(texto).toMatch(/primeiro contato/);
  });

  it('põe o negócio antes da orientação do passo, que fica por último', () => {
    const texto = abrir(blocoDoNegocio(CARD_DA_OBRA), 'Dê boas-vindas.');
    const iNegocio = texto.indexOf('## Negócio deste contato');
    const iHint = texto.indexOf('## Orientação do passo do fluxo');
    expect(iNegocio).toBeGreaterThan(texto.indexOf('<ritual>'));
    expect(iHint).toBeGreaterThan(iNegocio);
    expect(texto.trimEnd().endsWith('Dê boas-vindas.')).toBe(true);
  });

  it('sem negócio e sem orientação, nenhum dos dois cabeçalhos aparece', () => {
    const texto = abrir('');
    expect(texto).not.toContain('## Negócio deste contato');
    expect(texto).not.toContain('## Orientação do passo do fluxo');
  });
});
