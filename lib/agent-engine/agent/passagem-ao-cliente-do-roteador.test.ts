/**
 * #4363 — A TROCA AUTOMÁTICA DE AGENTE AVISA O CLIENTE, COM A FRASE DO ROTEADOR.
 *
 * ─── O que este arquivo mede, e por que aqui ───────────────────────────────
 *
 * O #4385 (já na main) entrega a metade que avisa o AGENTE que herdou a
 * conversa: um bloco derivado do turno, sem coluna. A outra metade — a frase
 * que o CLIENTE lê — é do dono do roteador (`ai_routers.passagem_ao_cliente`,
 * migration 9367), e o que se prova aqui é QUANDO ela sai:
 *
 *   1. sai UMA vez quando o roteador tem frase ligada e houve troca;
 *   2. não sai NADA quando a frase está desligada (o padrão, e o comportamento
 *      de antes desta mudança);
 *   3. não sai quando o responsável não muda (mesmo agente, ou conversa nova);
 *   4. a passagem EXPLÍCITA (#3823) continua sendo do agente, com o texto dele:
 *      `transferir-agente.ts` não conhece este módulo, e o turno seguinte chega
 *      com desfecho `sticky` — que a régua recusa.
 *
 * O envio é injetado (`enviar`): a régua é medida sem banco, sem canal e sem
 * LLM, e a contagem de chamadas é a própria asserção do "uma vez só".
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  avisarClienteDaTrocaDeAgente,
  montarBlocoDePassagemDoRoteador,
  textoDaPassagemAoCliente,
  type DesfechoDoEnvioDaPassagem,
  type TrocaQuePedeAviso,
} from '@/lib/agent-engine/agent/passagem-do-roteador';

const FRASE = 'Só um instante: agora quem continua o atendimento é o time de suporte.';

function logDeTeste() {
  const linhas: Array<{ nivel: string; msg: string; fields?: Record<string, unknown> }> = [];
  return {
    linhas,
    log: {
      info: (msg: string, fields?: Record<string, unknown>) => linhas.push({ nivel: 'info', msg, fields }),
      warn: (msg: string, fields?: Record<string, unknown>) => linhas.push({ nivel: 'warn', msg, fields }),
    },
  };
}

/** Contador de envios — a prova do "exatamente uma mensagem". */
function enviador(desfecho: DesfechoDoEnvioDaPassagem = 'sent') {
  const enviados: string[] = [];
  return {
    enviados,
    enviar: async (texto: string) => {
      enviados.push(texto);
      return desfecho;
    },
  };
}

function troca(over: Partial<TrocaQuePedeAviso> = {}): TrocaQuePedeAviso {
  return {
    outcome: 'reclassified',
    textoConfigurado: FRASE,
    agenteAnteriorId: 'agent-vendas',
    agenteNovoId: 'agent-suporte',
    ...over,
  };
}

describe('a frase da passagem automática ao CLIENTE (#4363)', () => {
  it('LIGADA + troca: envia exatamente UMA mensagem, e é a frase do roteador', async () => {
    const { enviados, enviar } = enviador('sent');
    const { log } = logDeTeste();

    const desfecho = await avisarClienteDaTrocaDeAgente({ enviar, log }, troca());

    expect(enviados).toHaveLength(1);
    expect(enviados[0]).toBe(FRASE);
    expect(desfecho).toEqual({ enviado: true, desfecho: 'sent' });
  });

  it('DESLIGADA (null, "", espaço): não envia nada — é o comportamento de antes', async () => {
    for (const desligada of [null, undefined, '', '   '] as const) {
      const { enviados, enviar } = enviador();
      const { log } = logDeTeste();
      const desfecho = await avisarClienteDaTrocaDeAgente(
        { enviar, log },
        troca({ textoConfigurado: desligada }),
      );
      expect(enviados, `textoConfigurado=${JSON.stringify(desligada)}`).toHaveLength(0);
      expect(desfecho.enviado).toBe(false);
    }
  });

  it('o RESPONSÁVEL não mudou: não envia (mesmo agente, ou conversa sem agente antes)', async () => {
    for (const over of [
      { agenteAnteriorId: 'agent-suporte', agenteNovoId: 'agent-suporte' },
      { agenteAnteriorId: null },
      { agenteNovoId: null },
    ]) {
      const { enviados, enviar } = enviador();
      const { log } = logDeTeste();
      const desfecho = await avisarClienteDaTrocaDeAgente({ enviar, log }, troca(over));
      expect(enviados, JSON.stringify(over)).toHaveLength(0);
      expect(desfecho).toEqual({ enviado: false, motivo: 'mesmo_agente' });
    }
  });

  it('a passagem EXPLÍCITA (#3823) não é anunciada por aqui: sticky/classified não são troca', async () => {
    for (const outcome of ['sticky', 'classified', 'fallback', 'no_match', 'classifier_failed']) {
      const { enviados, enviar } = enviador();
      const { log } = logDeTeste();
      const desfecho = await avisarClienteDaTrocaDeAgente({ enviar, log }, troca({ outcome }));
      expect(enviados, outcome).toHaveLength(0);
      expect(desfecho).toEqual({ enviado: false, motivo: 'nao_e_troca' });
      expect(textoDaPassagemAoCliente(troca({ outcome }))).toBeNull();
    }

    // E o módulo da passagem explícita NÃO conhece esta régua: lá o aviso é o
    // texto do próprio agente (`transferir-agente.ts`, #3823), e é isso que
    // impede as duas mensagens na mesma troca.
    const fonteDaExplicita = readFileSync(
      join(process.cwd(), 'lib/agent-engine/agent/transferir-agente.ts'),
      'utf8',
    );
    expect(fonteDaExplicita).not.toContain('passagem-do-roteador');
    expect(fonteDaExplicita).not.toContain('avisarClienteDaTrocaDeAgente');
  });

  it('a cadeia vetou ou o canal caiu: NÃO lança, e o desfecho é honesto', async () => {
    const casos: Array<[DesfechoDoEnvioDaPassagem, string]> = [
      ['queued', 'na_fila'],
      ['blocked', 'contato_bloqueado'],
      ['failed', 'canal_falhou'],
      ['unavailable', 'canal_indisponivel'],
    ];
    for (const [desfechoDoEnvio, motivo] of casos) {
      const { enviar } = enviador(desfechoDoEnvio);
      const { log } = logDeTeste();
      const desfecho = await avisarClienteDaTrocaDeAgente({ enviar, log }, troca());
      expect(desfecho).toEqual({ enviado: false, motivo });
    }

    const { log } = logDeTeste();
    const desfecho = await avisarClienteDaTrocaDeAgente(
      { enviar: async () => { throw new Error('canal explodiu'); }, log },
      troca(),
    );
    expect(desfecho).toEqual({ enviado: false, motivo: 'canal_falhou' });
  });

  it('a frase vai como o dono escreveu, só sem as pontas', async () => {
    const { enviados, enviar } = enviador();
    const { log } = logDeTeste();
    await avisarClienteDaTrocaDeAgente(
      { enviar, log },
      troca({ textoConfigurado: `\n  ${FRASE}  \n` }),
    );
    expect(enviados).toEqual([FRASE]);
  });
});

describe('o bloco do AGENTE quando o cliente JÁ foi avisado (#4363)', () => {
  const passagem = { agenteAnteriorId: 'agent-vendas', agenteAnteriorNome: 'Ana, do comercial' };

  it('desligada (padrão): o agente novo se apresenta, como antes', () => {
    const bloco = montarBlocoDePassagemDoRoteador(passagem, 'pt-BR');
    expect(bloco).toMatch(/ainda NÃO foi avisado/);
    expect(bloco).toMatch(/Apresente-se ao cliente/);
  });

  it('avisado: manda NÃO repetir o aviso — senão o cliente lê duas passagens', () => {
    const bloco = montarBlocoDePassagemDoRoteador(passagem, 'pt-BR', true);
    expect(bloco).toMatch(/JÁ foi avisado/);
    expect(bloco).not.toMatch(/ainda NÃO foi avisado/);
    expect(bloco).not.toMatch(/Apresente-se ao cliente/);
    expect(bloco).toMatch(/NÃO se apresente de novo/);
    // O resto do bloco continua valendo: continuidade e idioma da organização.
    expect(bloco).toMatch(/NÃO recomece/);
    expect(bloco).toMatch(/português/);
  });
});
