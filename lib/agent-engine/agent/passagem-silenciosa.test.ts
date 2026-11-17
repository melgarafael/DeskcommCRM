/**
 * #4750 — O TERCEIRO MODO DA TROCA AUTOMÁTICA: SILENCIOSO.
 *
 * O defeito medido, em produção: a cada desfecho `reclassified` o agente novo
 * recebia a ordem de se apresentar e anunciar que continuaria o atendimento
 * (`passagem-do-roteador.ts`, ramo `primeiraInstrucao` de quem NÃO foi avisado).
 * Num dia, 14 trocas em 7 de 17 conversas — e o classificador troca em resposta
 * curta ("não", "obrigada", um horário), então o cliente lia uma reapresentação
 * a cada duas ou três mensagens. Escrever "não se reapresente" no prompt do
 * agente perdia para o bloco, que entra depois.
 *
 * O autor fechou o desenho: uma chave booleana `passagem_silenciosa` em
 * `ai_routers.config` (jsonb livre, SEM migration), lida como terceiro ramo de
 * `primeiraInstrucao`. Ligada, NADA vai ao cliente e o bloco só manda continuar
 * — sem se apresentar, sem anunciar a troca.
 *
 * Os cinco casos exigidos pela issue, na ordem: (a) silencioso sem mensagem e
 * com o bloco de continuidade; (b) silencioso MAIS frase cadastrada, sem
 * vazamento; (c) chave ausente = hoje sem frase; (d) chave falsa + frase = hoje;
 * (e) o interruptor grava e lê a chave pelo caminho da tela — este último mora
 * em `app/app/ai/routers/[id]/_client.test.tsx`, porque é o caminho do
 * formulário, não o da régua.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';

import { loadActiveRouter } from '@/lib/agent-engine/agent/router-config';
import {
  avisarClienteDaTrocaDeAgente,
  montarBlocoDePassagemDoRoteador,
  textoDaPassagemAoCliente,
} from '@/lib/agent-engine/agent/passagem-do-roteador';

const TROCA = {
  outcome: 'reclassified',
  textoConfigurado: null as string | null,
  agenteAnteriorId: 'agent-comercial',
  agenteNovoId: 'agent-suporte',
};

const PASSAGEM = { agenteAnteriorId: 'agent-comercial', agenteAnteriorNome: 'Ana, do comercial' };

function logMudo() {
  return { info: vi.fn(), warn: vi.fn() };
}

/** O dublê do banco: uma linha de roteador e nenhum membro. */
function poolComConfig(config: Record<string, unknown>): pg.Pool {
  const query = vi.fn();
  query.mockResolvedValueOnce({
    rows: [{ id: 'r1', name: 'Atendimento', config, fallback_agent_id: null }],
  });
  query.mockResolvedValueOnce({ rows: [] });
  return { query } as unknown as pg.Pool;
}

describe('#4750 — troca automática silenciosa', () => {
  it('(a) silencioso: NADA é enviado ao cliente e o bloco só manda continuar', async () => {
    const enviar = vi.fn(async () => 'sent' as const);
    const desfecho = await avisarClienteDaTrocaDeAgente(
      { enviar, log: logMudo() },
      { ...TROCA, passagemSilenciosa: true },
    );
    expect(desfecho).toEqual({ enviado: false, motivo: 'modo_silencioso' });
    expect(enviar).not.toHaveBeenCalled();

    const bloco = montarBlocoDePassagemDoRoteador(PASSAGEM, 'pt-BR', false, true);
    expect(bloco).toContain('NÃO se apresente nem anuncie a troca');
    expect(bloco).toContain('Continue do ponto em que a conversa está');
    // O que o modo silencioso PROÍBE: a reapresentação e o anúncio da troca.
    expect(bloco).not.toContain('Apresente-se ao cliente pelo seu nome');
    expect(bloco).not.toContain('diga, em uma frase, que você vai continuar');
  });

  it('(b) silencioso + frase cadastrada: a frase NÃO vaza — o silêncio ganha', async () => {
    const frase = 'Você está falando agora com o time de suporte.';
    const enviar = vi.fn(async () => 'sent' as const);
    const troca = { ...TROCA, textoConfigurado: frase, passagemSilenciosa: true };

    // A régua pura: com frase cadastrada E silêncio ligado, não há texto.
    expect(textoDaPassagemAoCliente(troca)).toBeNull();

    const desfecho = await avisarClienteDaTrocaDeAgente({ enviar, log: logMudo() }, troca);
    expect(desfecho).toEqual({ enviado: false, motivo: 'modo_silencioso' });
    expect(enviar).not.toHaveBeenCalled();

    const bloco = montarBlocoDePassagemDoRoteador(PASSAGEM, 'pt-BR', false, true);
    expect(bloco).not.toContain(frase);
    expect(bloco).toContain('A troca é SILENCIOSA');
    expect(bloco).not.toContain('Apresente-se ao cliente');
  });

  it('(c) chave ausente: o comportamento é o de hoje, sem frase', async () => {
    // `config` antigo, gravado antes desta chave existir: não quebra e lê falso.
    const router = await loadActiveRouter(poolComConfig({ sticky: true }), 'org1', 'cs1');
    expect(router?.passagemSilenciosa).toBe(false);

    const enviar = vi.fn(async () => 'sent' as const);
    const desfecho = await avisarClienteDaTrocaDeAgente({ enviar, log: logMudo() }, TROCA);
    expect(desfecho).toEqual({ enviado: false, motivo: 'sem_texto' });
    expect(enviar).not.toHaveBeenCalled();

    // O bloco de antes: o agente novo se apresenta.
    const bloco = montarBlocoDePassagemDoRoteador(PASSAGEM, 'pt-BR');
    expect(bloco).toContain('Apresente-se ao cliente pelo seu nome');
    expect(bloco).toContain('O cliente ainda NÃO foi avisado da troca.');
  });

  it('(d) chave falsa + frase cadastrada: idêntico a hoje (a frase sai uma vez)', async () => {
    const router = await loadActiveRouter(
      poolComConfig({ passagem_silenciosa: false }),
      'org1',
      'cs1',
    );
    expect(router?.passagemSilenciosa).toBe(false);

    const frase = 'Você está falando agora com o time de suporte.';
    const enviar = vi.fn(async () => 'sent' as const);
    const troca = { ...TROCA, textoConfigurado: frase, passagemSilenciosa: false };
    const desfecho = await avisarClienteDaTrocaDeAgente({ enviar, log: logMudo() }, troca);
    expect(desfecho).toEqual({ enviado: true, desfecho: 'sent' });
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(enviar).toHaveBeenCalledWith(frase);

    // E o bloco do modo avisado, como antes.
    const bloco = montarBlocoDePassagemDoRoteador(PASSAGEM, 'pt-BR', true, false);
    expect(bloco).toContain('O cliente JÁ foi avisado da troca');
    expect(bloco).not.toContain('Apresente-se ao cliente');
  });

  it('a chave só vale como booleana verdadeira: lixo no config não liga o silêncio', async () => {
    for (const valor of ['true', 1, {}, 'sim']) {
      const router = await loadActiveRouter(
        poolComConfig({ passagem_silenciosa: valor }),
        'org1',
        'cs1',
      );
      expect(router?.passagemSilenciosa).toBe(false);
    }
    const ligado = await loadActiveRouter(
      poolComConfig({ passagem_silenciosa: true }),
      'org1',
      'cs1',
    );
    expect(ligado?.passagemSilenciosa).toBe(true);
  });
});

/**
 * A última ponta: o turno precisa CONSULTAR a chave e passar o silêncio ao
 * bloco. Sem isto o texto existe, os testes de régua passam — e o modelo
 * continua recebendo a ordem de se apresentar.
 */
describe('#4750 — o turno consulta o modo silencioso', () => {
  const fonte = readFileSync(join(__dirname, 'inbound-turn.ts'), 'utf8');

  it('lê a chave do roteamento e não chama o envio quando ela está ligada', () => {
    expect(fonte).toContain("'passagemSilenciosaDoRouter' in routed");
    expect(fonte).toMatch(/passagemSilenciosaDaTroca === false &&/);
  });

  it('passa o silêncio ao bloco do agente, ao lado de clienteAvisado', () => {
    expect(fonte).toMatch(/clienteAvisadoDaTroca,\n\s+passagemSilenciosaDaTroca,/);
  });
});
