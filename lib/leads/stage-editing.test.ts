import { describe, expect, it } from 'vitest';
import {
  validarNomeDeEtapa, slugDeNome, validarMarcacao, updatesDeMarcacao,
  posicaoEntre, validarArquivamento,
} from './stage-editing';

const etapas = [
  { id: 'e1', name: 'Novo',     slug: 'novo',     position: 1000, is_won: false, is_lost: false, is_archived: false, agent_stage_hint: null },
  { id: 'e2', name: 'Proposta', slug: 'proposta', position: 2000, is_won: false, is_lost: false, is_archived: false, agent_stage_hint: 'negotiating' },
  { id: 'e3', name: 'Fechado',  slug: 'fechado',  position: 3000, is_won: true,  is_lost: false, is_archived: false, agent_stage_hint: 'won' },
];

describe('validarNomeDeEtapa', () => {
  it('recusa nome vazio e nome só de espaços', () => {
    expect(validarNomeDeEtapa('', etapas, null).ok).toBe(false);
    expect(validarNomeDeEtapa('   ', etapas, null).ok).toBe(false);
  });

  it('recusa nome repetido no mesmo funil, citando o nome', () => {
    const r = validarNomeDeEtapa('Proposta', etapas, null);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.erro).toMatch(/Proposta/);
  });

  it('aceita o próprio nome ao renomear (não colide consigo mesma)', () => {
    expect(validarNomeDeEtapa('Proposta', etapas, 'e2').ok).toBe(true);
  });

  it('compara ignorando caixa e espaços nas pontas — "  proposta " colide', () => {
    // Sem isto o usuário cria duas etapas que ele lê como a mesma.
    expect(validarNomeDeEtapa('  proposta ', etapas, null).ok).toBe(false);
  });

  it('dobra acento e espaço interno — "Pos  Venda" é a mesma coluna que "Pós venda"', () => {
    // Decisão de produto: quem digita sem acento cria uma duplicata que ele lê
    // como a mesma coluna, e ninguém sabe explicar por que o quadro tem duas.
    const comPosVenda = [...etapas, { ...etapas[0]!, id: 'e5', name: 'Pós venda', slug: 'pos_venda' }];
    expect(validarNomeDeEtapa('Pos  Venda', comPosVenda, null).ok).toBe(false);
  });

  it('etapa arquivada não bloqueia o nome — ela não está no quadro', () => {
    // Recusar por causa de uma etapa invisível seria erro sem saída para o usuário.
    const comArquivada = [...etapas, { ...etapas[1]!, id: 'e9', name: 'Antiga', slug: 'antiga', is_archived: true }];
    expect(validarNomeDeEtapa('Antiga', comArquivada, null).ok).toBe(true);
  });
});

describe('slugDeNome', () => {
  it('gera slug estável a partir do nome com hífens', () => {
    expect(slugDeNome('Em negociação')).toBe('em-negociacao');
    expect(slugDeNome('Pós-venda!')).toBe('pos-venda');
    expect(slugDeNome('Agendamento solicitado')).toBe('agendamento-solicitado');
    expect(slugDeNome('Chamar humano')).toBe('chamar-humano');
  });

  it('desempata acrescentando sufixo quando o slug já existe', () => {
    // "Pós venda" e "Pós-venda" viram o mesmo slug; o índice único recusaria.
    expect(slugDeNome('Pós venda', ['pos-venda'])).toBe('pos-venda-2');
  });

  it('nunca devolve slug vazio', () => {
    // Nome só de emoji/pontuação não pode virar slug '' e violar o índice.
    expect(slugDeNome('🎯').length).toBeGreaterThan(0);
  });

  it('respeita o formato que o banco exige — /^[a-z0-9_-]{2,40}$/', () => {
    // crm_stages_slug_format: 1 caractere e 41 caracteres são recusados pelo CHECK.
    const formato = /^[a-z0-9_-]{2,40}$/;
    expect(slugDeNome('A')).toMatch(formato);
    expect(slugDeNome('🎯')).toMatch(formato);
    expect(slugDeNome('Aguardando confirmação do pagamento pela operadora do cartão')).toMatch(formato);
    // E o sufixo de desempate cabe no limite, em vez de estourá-lo.
    const longo = slugDeNome('Aguardando confirmação do pagamento pela operadora do cartão');
    expect(slugDeNome('Aguardando confirmação do pagamento pela operadora do cartão', [longo])).toMatch(formato);
  });
});

describe('validarMarcacao', () => {
  it('recusa desmarcar ganho de etapa que representa o passo "cliente fechou"', () => {
    // O CHECK crm_stages_hint_coerente_com_won_lost proibiria, com erro cru.
    const r = validarMarcacao(etapas, 'e3', { is_won: false });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.erro).toMatch(/Fechado/);
  });

  it('recusa marcar como ganho uma etapa que já representa outro passo', () => {
    const r = validarMarcacao(etapas, 'e2', { is_won: true });
    expect(r.ok).toBe(false);
  });

  it('aceita mover a marcação de ganho para uma etapa livre', () => {
    expect(validarMarcacao(etapas, 'e1', { is_won: true }).ok).toBe(true);
  });

  it('recusa marcar a mesma etapa como ganho E perda', () => {
    expect(validarMarcacao(etapas, 'e1', { is_won: true, is_lost: true }).ok).toBe(false);
  });

  it('recusa desmarcar o ganho da INSTALAÇÃO FRESCA, onde ninguém tem hint', () => {
    // fn_seed_default_pipeline_for_org semeia "Pago" com is_won=true e
    // agent_stage_hint=null; o backfill da 0084 só pegou o que já existia. Uma
    // guarda chaveada no hint protegeria só bancos antigos — e o funil de toda
    // org nova ficaria sem etapa de ganho, com /leads/[id]/win em 422.
    const fresco = [
      { ...etapas[0]!, id: 'p1', name: 'Aguardando pagamento', slug: 'aguardando_pagamento' },
      { ...etapas[0]!, id: 'p2', name: 'Pago', slug: 'pago', is_won: true, agent_stage_hint: null },
    ];
    expect(validarMarcacao(fresco, 'p2', { is_won: false }).ok).toBe(false);
  });

  it('recusa desmarcar a etapa de PERDA — o lado espelho da regra de ganho', () => {
    const comPerdido = [...etapas, { ...etapas[0]!, id: 'e4', name: 'Perdido', slug: 'perdido', is_lost: true, agent_stage_hint: 'lost' }];
    expect(validarMarcacao(comPerdido, 'e4', { is_lost: false }).ok).toBe(false);
  });
});

describe('updatesDeMarcacao', () => {
  it('DESMARCA a antiga antes de marcar a nova — o índice único é imediato', () => {
    const ups = updatesDeMarcacao(etapas, 'e1', { is_won: true });
    // O passo do assistente ACOMPANHA a marcação: deixar 'won' na etapa que
    // perdeu o is_won violaria o CHECK crm_stages_hint_coerente_com_won_lost,
    // e apagá-lo sem repassar desligaria o agente em silêncio.
    expect(ups[0]).toEqual({ stageId: 'e3', patch: { is_won: false, agent_stage_hint: null } });
    expect(ups[1]).toEqual({ stageId: 'e1', patch: { is_won: true, agent_stage_hint: 'won' } });
    expect(ups).toHaveLength(2);
  });

  it('não emite update nenhum quando a marcação já é a desejada', () => {
    expect(updatesDeMarcacao(etapas, 'e3', { is_won: true })).toEqual([]);
  });

  it('move a marcação de PERDA com a mesma ordem e o mesmo cuidado com o hint', () => {
    const comPerdido = [...etapas, { ...etapas[0]!, id: 'e4', name: 'Perdido', slug: 'perdido', is_lost: true, agent_stage_hint: 'lost' }];
    const ups = updatesDeMarcacao(comPerdido, 'e1', { is_lost: true });
    expect(ups[0]).toEqual({ stageId: 'e4', patch: { is_lost: false, agent_stage_hint: null } });
    expect(ups[1]).toEqual({ stageId: 'e1', patch: { is_lost: true, agent_stage_hint: 'lost' } });
  });

  it('desmarca a etapa de ganho VIVA, não uma arquivada — o índice único ignora arquivadas', () => {
    // Mirar na arquivada deixaria a viva marcada: o UPDATE seguinte tomaria 23505.
    const comArquivada = [
      { ...etapas[2]!, id: 'e0', name: 'Ganho antigo', slug: 'ganho_antigo', is_archived: true, agent_stage_hint: null },
      ...etapas,
    ];
    const ups = updatesDeMarcacao(comArquivada, 'e1', { is_won: true });
    expect(ups.map((u) => u.stageId)).toEqual(['e3', 'e1']);
  });
});

describe('posicaoEntre', () => {
  it('devolve o meio entre as duas vizinhas', () => {
    expect(posicaoEntre(1000, 2000)).toBe(1500);
  });

  it('aceita as pontas da lista', () => {
    expect(posicaoEntre(null, 1000)).toBeLessThan(1000);
    expect(posicaoEntre(3000, null)).toBeGreaterThan(3000);
  });
});

describe('validarArquivamento', () => {
  it('exige destino quando a etapa tem negócios', () => {
    const r = validarArquivamento(etapas, 'e2', { negocios: 7, destinoId: null });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.erro).toMatch(/7/);
  });

  it('dispensa destino quando a etapa está vazia', () => {
    expect(validarArquivamento(etapas, 'e2', { negocios: 0, destinoId: null }).ok).toBe(true);
  });

  it('recusa destino igual à própria etapa, e diz que foi por isso', () => {
    // Só `ok:false` não mede esta regra: a etapa também não está entre as
    // restantes, então a regra de destino inválido recusaria igual — com um
    // texto ("recarregue a página") que manda o usuário fazer a coisa errada.
    const r = validarArquivamento(etapas, 'e2', { negocios: 3, destinoId: 'e2' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.erro).toMatch(/ela mesma/);
  });

  it('recusa destino que não está no funil', () => {
    const r = validarArquivamento(etapas, 'e2', { negocios: 3, destinoId: 'e404' });
    expect(r.ok).toBe(false);
  });

  it('recusa mandar os negócios para a etapa de GANHO — seria fechar negócio por configuração', () => {
    // `fn_crm_lead_close_on_stage` marca `status='won'` com `closed_at=now()`
    // por estágio: N negócios virariam receita porque alguém arrumou o quadro.
    const r = validarArquivamento(etapas, 'e2', { negocios: 3, destinoId: 'e3' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.erro).toMatch(/encerrados/);
  });

  it('recusa mandar os negócios para a etapa de PERDA — o banco levantaria 22023', () => {
    const comPerdido = [
      ...etapas,
      { ...etapas[0]!, id: 'e4', name: 'Perdido', slug: 'perdido', is_lost: true },
    ];
    const r = validarArquivamento(comPerdido, 'e2', { negocios: 3, destinoId: 'e4' });
    expect(r.ok).toBe(false);
    // Mede o MOTIVO, não só o `ok:false`: sem isso, a regra de "destino fora do
    // funil" recusaria igual e o teste passaria com esta regra removida.
    expect(r.ok === false && r.erro).toMatch(/de perda/);
  });

  it('aceita destino em aberto no mesmo funil', () => {
    expect(validarArquivamento(etapas, 'e2', { negocios: 3, destinoId: 'e1' }).ok).toBe(true);
  });

  it('recusa arquivar a etapa de ganho — /leads/[id]/win não filtra arquivada', () => {
    // A rota busca `.eq("is_won", true)` sem filtrar is_archived: o negócio
    // fechado SERIA MOVIDO para uma coluna fora do quadro, em silêncio.
    const r = validarArquivamento(etapas, 'e3', { negocios: 0, destinoId: null });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.erro).toMatch(/ganho/);
  });

  it('recusa arquivar a ÚLTIMA etapa do funil', () => {
    // Funil sem etapa nenhuma não recebe negócio novo e some do board.
    const so = [etapas[0]!];
    expect(validarArquivamento(so, 'e1', { negocios: 0, destinoId: null }).ok).toBe(false);
  });
});
