/**
 * #4363 — A TROCA AUTOMÁTICA DO ROTEADOR CHEGA AO AGENTE QUE RECEBE A CONVERSA.
 *
 * O defeito medido: com sticky, o cliente responde algo da intenção de outro
 * membro e a mensagem já é atendida pelo agente 2; nada no contexto dele diz que
 * a conversa foi HERDADA, então ele responde como se o atendimento começasse
 * ali (e a regra que o membro escreveu no prompt do agente 1 nunca é usada).
 *
 * Os casos abaixo cobrem as três pontas do conserto: o texto do aviso (de quem,
 * e em que idioma), a ausência dele quando NÃO houve troca (controle positivo
 * contra vacuidade) e o caminho até o prompt — porque um bloco que ninguém
 * repassa ao ritual não chega ao modelo.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  TITULO_DO_BLOCO_DE_PASSAGEM,
  montarBlocoDePassagemDoRoteador,
} from '@/lib/agent-engine/agent/passagem-do-roteador';
import { buildOpeningMessage, ritualBlocks } from '@/lib/agent-engine/agent/abertura/ritual';

const contexto = { contact: { name: 'Cliente', email: null }, messages: [] } as never;

describe('o aviso da passagem automática do roteador (#4363)', () => {
  it('diz de QUEM o agente herdou a conversa e que ele precisa se apresentar', () => {
    const bloco = montarBlocoDePassagemDoRoteador(
      { agenteAnteriorId: 'agent-vendas', agenteAnteriorNome: 'Ana, do comercial' },
      'pt-BR',
    );
    expect(bloco).toContain(TITULO_DO_BLOCO_DE_PASSAGEM);
    expect(bloco).toContain('Ana, do comercial');
    expect(bloco).toMatch(/Apresente-se ao cliente/);
    // O cliente não recebeu aviso da troca: quem avisa é o agente novo.
    expect(bloco).toMatch(/ainda NÃO foi avisado/);
    expect(bloco).toMatch(/NÃO recomece/);
  });

  it('manda falar o idioma da ORGANIZAÇÃO, não o do código', () => {
    const passagem = { agenteAnteriorId: 'agent-vendas', agenteAnteriorNome: 'Ana' };
    expect(montarBlocoDePassagemDoRoteador(passagem, 'es')).toContain('Fale espanhol');
    expect(montarBlocoDePassagemDoRoteador(passagem, 'pt-BR')).toContain('Fale português do Brasil');
  });

  it('sem nome conhecido não inventa nome — mas o aviso continua valendo', () => {
    const bloco = montarBlocoDePassagemDoRoteador({ agenteAnteriorId: 'agent-x', agenteAnteriorNome: null });
    expect(bloco).toContain('outro agente');
    expect(bloco).not.toContain('""');
    expect(bloco).toContain(TITULO_DO_BLOCO_DE_PASSAGEM);
  });

  it('controle positivo: sem troca de agente NÃO existe aviso nenhum', () => {
    expect(montarBlocoDePassagemDoRoteador(null)).toBe('');
    expect(montarBlocoDePassagemDoRoteador(undefined, 'es')).toBe('');
  });
});

describe('o aviso chega ao prompt do turno', () => {
  const bloco = montarBlocoDePassagemDoRoteador(
    { agenteAnteriorId: 'agent-vendas', agenteAnteriorNome: 'Ana' },
    'es',
  );

  it('buildOpeningMessage repassa o bloco ao ritual', () => {
    const texto = buildOpeningMessage(
      null, null, contexto, 'sem notas', false, [], '', undefined, undefined, '', 'json', bloco,
    );
    expect(texto).toContain(TITULO_DO_BLOCO_DE_PASSAGEM);
    expect(texto).toContain('Fale espanhol');
  });

  it('sem passagem, a MESMA abertura não traz o aviso (contra vacuidade)', () => {
    const texto = buildOpeningMessage(
      null, null, contexto, 'sem notas', false, [], '', undefined, undefined, '', 'json', '',
    );
    expect(texto).not.toContain(TITULO_DO_BLOCO_DE_PASSAGEM);
    expect(texto).toContain('## Contexto do lead');
  });

  it('o bloco vem ANTES do contexto do lead — é a instrução que governa o turno', () => {
    const blocos = ritualBlocks(null, null, contexto, 'sem notas', false, '', '', 'json', bloco);
    const texto = blocos.join('\n');
    expect(texto.indexOf(TITULO_DO_BLOCO_DE_PASSAGEM)).toBeGreaterThanOrEqual(0);
    expect(texto.indexOf(TITULO_DO_BLOCO_DE_PASSAGEM)).toBeLessThan(
      texto.indexOf('## Contexto do lead'),
    );
  });
});

/**
 * A última ponta do caminho: o turno inbound precisa CALCULAR o bloco a partir
 * da resolução e REPASSÁ-LO ao `buildOpening` — sem isso, o texto existe, os
 * testes de texto passam, e o modelo nunca o vê. Mesma régua do
 * `o-agente-recebe-o-anuncio-do-contato` para o bloco de origem.
 */
describe('o turno inbound repassa o bloco ao buildOpening', () => {
  const fonte = readFileSync(join(__dirname, 'inbound-turn.ts'), 'utf8');

  it('calcula o bloco a partir de routed.passagemRecebida', () => {
    expect(fonte).toContain("'passagemRecebida' in routed");
    expect(fonte).toMatch(/montarBlocoDePassagemDoRoteador\(\s*passagemRecebida,/);
    expect(fonte).toContain('idiomaDaOrganizacaoDoTurno(pool, tenantId, runLog)');
  });

  it('entrega o bloco ao buildOpening pelo ritual da abertura', () => {
    expect(fonte).toMatch(/origemBlock,\n\s+passagemBlock,\n\s+formatoDoHistorico/);
    expect(fonte).toMatch(/origemBlock,\n\s+formatoDoHistorico,\n\s+passagemBlock,\n\s+\)/);
  });
});
