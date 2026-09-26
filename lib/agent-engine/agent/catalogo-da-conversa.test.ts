import { describe, expect, it, vi } from 'vitest';

import type { MotoDoCatalogo } from './fotos-do-catalogo';
import {
  carregarCatalogoDaConversa,
  motoEscolhidaPeloCliente,
  salvarCatalogoDaConversa,
} from './catalogo-da-conversa';

const CB300: MotoDoCatalogo = {
  nome: 'CB 300',
  ano: '2015',
  cor: 'Preto',
  fotos: ['https://x/cb300-1.jpg', 'https://x/cb300-2.jpg'],
};
const TWISTER: MotoDoCatalogo = {
  nome: 'CB 300 F Twister',
  ano: '2025',
  cor: 'Vermelho',
  fotos: ['https://x/tw-1.jpg', 'https://x/tw-2.jpg', 'https://x/tw-3.jpg'],
};
const CATALOGO = [CB300, TWISTER];

describe('motoEscolhidaPeloCliente', () => {
  it('usa a moto que o MODELO citou, resolvendo nome aninhado ("CB 300" ⊂ Twister)', () => {
    const escolhida = motoEscolhidaPeloCliente(
      'Boa escolha! A CB 300 F Twister 2025 é muito conservada.',
      'A 2025',
      CATALOGO,
      [],
    );
    expect(escolhida?.nome).toBe('CB 300 F Twister');
  });

  it('casa pelo ANO que o cliente disse, sem o modelo citar o nome', () => {
    expect(motoEscolhidaPeloCliente('Boa escolha!', 'A 2025', CATALOGO, [])?.nome).toBe(
      'CB 300 F Twister',
    );
  });

  it('casa pela COR quando é única', () => {
    expect(motoEscolhidaPeloCliente('Certo!', 'gostei da vermelha', CATALOGO, [])?.nome).toBe(
      'CB 300 F Twister',
    );
    expect(motoEscolhidaPeloCliente('Certo!', 'quero a preta', CATALOGO, [])?.nome).toBe('CB 300');
  });

  it('não decide quando o texto cita DUAS motos distintas (sem escolha)', () => {
    expect(
      motoEscolhidaPeloCliente('Temos a Biz e a Pop aqui', 'quais tem?', [
        { nome: 'Biz 125', fotos: ['https://x/b.jpg'] },
        { nome: 'Pop 110', fotos: ['https://x/p.jpg'] },
      ], []),
    ).toBeUndefined();
  });

  it('não repete moto já enviada em detalhe', () => {
    expect(
      motoEscolhidaPeloCliente('A CB 300 F Twister é ótima', 'A 2025', CATALOGO, [
        'CB 300 F Twister',
      ]),
    ).toBeUndefined();
  });

  it('sem escolha clara ⇒ undefined (nunca chuta)', () => {
    expect(motoEscolhidaPeloCliente('Sobre a loja...', 'Sao paulo', CATALOGO, [])).toBeUndefined();
  });

  it('pergunta/objeção sobre a moto NÃO é escolha (medido ao vivo 2026-09-22)', () => {
    expect(motoEscolhidaPeloCliente('', 'E a CB 300? Achei meio caro', CATALOGO, [])).toBeUndefined();
    expect(motoEscolhidaPeloCliente('', 'Tem como melhorar o preço?', CATALOGO, [])).toBeUndefined();
    expect(motoEscolhidaPeloCliente('', 'Vou pensar melhor', CATALOGO, [])).toBeUndefined();
    expect(
      motoEscolhidaPeloCliente('', 'Vocês aceitam minha moto na troca?', CATALOGO, []),
    ).toBeUndefined();
  });

  it('sinal positivo vence a pergunta: "quero a CB 300, quanto fica?" é escolha', () => {
    expect(motoEscolhidaPeloCliente('', 'quero a CB 300, quanto fica?', CATALOGO, [])?.nome).toBe(
      'CB 300',
    );
  });
});

describe('carregarCatalogoDaConversa', () => {
  it('lê o metadata e filtra entradas inválidas', async () => {
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            agent_catalogo: {
              motos: [TWISTER, { nome: 'x' }],
              detalhadas: ['CB 300', 7],
              escolhida: TWISTER,
            },
          },
        ],
      }),
    } as never;
    const estado = await carregarCatalogoDaConversa(db, 'org', 'conv');
    expect(estado.motos).toHaveLength(1);
    expect(estado.motos[0]?.nome).toBe('CB 300 F Twister');
    expect(estado.detalhadas).toEqual(['CB 300']);
    expect(estado.escolhida?.nome).toBe('CB 300 F Twister');
  });

  it('escolhida inválida/ausente ⇒ null', async () => {
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [{ agent_catalogo: { motos: [TWISTER], detalhadas: [], escolhida: { nome: 'x' } } }],
      }),
    } as never;
    expect((await carregarCatalogoDaConversa(db, 'org', 'conv')).escolhida).toBeNull();
  });

  it('ausência/erro ⇒ vazio (nunca lança)', async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error('boom')) } as never;
    expect(await carregarCatalogoDaConversa(db, 'org', 'conv')).toEqual({
      motos: [],
      detalhadas: [],
      escolhida: null,
      referencia: null,
      objecao: null,
      opcoes: null,
    });
  });
});

describe('salvarCatalogoDaConversa', () => {
  function payloadDe(query: ReturnType<typeof vi.fn>): {
    motos: { nome: string }[];
    detalhadas: string[];
    escolhida: { nome: string } | null;
    referencia: { nome: string } | null;
    objecao: { moto: string; fase: string } | null;
  } {
    return JSON.parse(query.mock.calls[0]![1]![2] as string);
  }

  it('faz merge: motos novas primeiro, dedup e marca a detalhada', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await salvarCatalogoDaConversa(
      { query } as never,
      'org',
      'conv',
      { motos: [TWISTER], detalhadas: [], escolhida: null, referencia: null, objecao: null, opcoes: null },
      [CB300, TWISTER],
      'CB 300 F Twister',
    );
    expect(query).toHaveBeenCalledTimes(1);
    const payload = payloadDe(query);
    expect(payload.motos.map((m) => m.nome)).toEqual(['CB 300', 'CB 300 F Twister']);
    expect(payload.detalhadas).toEqual(['cb 300 f twister']);
  });

  it('GRAVA a escolha (trava de decisão)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await salvarCatalogoDaConversa(
      { query } as never,
      'org',
      'conv',
      { motos: [CB300, TWISTER], detalhadas: [], escolhida: null, referencia: null, objecao: null, opcoes: null },
      [],
      'CB 300 F Twister',
      TWISTER,
    );
    expect(payloadDe(query).escolhida?.nome).toBe('CB 300 F Twister');
  });

  it('PRESERVA a escolha quando não há nova apresentação nem nova escolha', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await salvarCatalogoDaConversa(
      { query } as never,
      'org',
      'conv',
      { motos: [CB300, TWISTER], detalhadas: ['cb 300 f twister'], escolhida: TWISTER, referencia: null, objecao: null, opcoes: null },
      [],
      null,
    );
    expect(payloadDe(query).escolhida?.nome).toBe('CB 300 F Twister');
  });

  it('DESTRAVA (null explícito) quando o cliente pede para ver outras', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await salvarCatalogoDaConversa(
      { query } as never,
      'org',
      'conv',
      { motos: [CB300, TWISTER], detalhadas: [], escolhida: TWISTER, referencia: null, objecao: null, opcoes: null },
      [CB300],
      null,
      null,
    );
    expect(payloadDe(query).escolhida).toBeNull();
  });

  it('grava a REFERÊNCIA e a preserva quando o turno não manda outra', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    // 1º turno: cliente pediu a Twister → vira referência.
    await salvarCatalogoDaConversa(
      { query } as never,
      'org',
      'conv',
      { motos: [], detalhadas: [], escolhida: null, referencia: null, objecao: null, opcoes: null },
      [TWISTER],
      null,
      undefined,
      TWISTER,
    );
    expect(payloadDe(query).referencia?.nome).toBe('CB 300 F Twister');

    // 2º turno (outra query): sem nova referência → PRESERVA a atual.
    const query2 = vi.fn().mockResolvedValue({ rows: [] });
    await salvarCatalogoDaConversa(
      { query: query2 } as never,
      'org',
      'conv',
      { motos: [TWISTER], detalhadas: [], escolhida: null, referencia: TWISTER, objecao: null, opcoes: null },
      [CB300],
      null,
      undefined,
      undefined,
    );
    expect(payloadDe(query2).referencia?.nome).toBe('CB 300 F Twister');
  });

  it('grava e limpa o estado de OBJEÇÃO (C-071)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await salvarCatalogoDaConversa(
      { query } as never,
      'org',
      'conv',
      { motos: [], detalhadas: [], escolhida: null, referencia: null, objecao: null, opcoes: null },
      [],
      null,
      undefined,
      undefined,
      { moto: 'biz 125', fase: 'persuadir' },
    );
    expect(payloadDe(query).objecao).toEqual({ moto: 'biz 125', fase: 'persuadir' });

    // A ferramenta de semelhantes LIMPA a objeção (null explícito).
    const query2 = vi.fn().mockResolvedValue({ rows: [] });
    await salvarCatalogoDaConversa(
      { query: query2 } as never,
      'org',
      'conv',
      {
        motos: [],
        detalhadas: [],
        escolhida: null,
        referencia: null,
        objecao: { moto: 'biz 125', fase: 'checar' },
        opcoes: null,
      },
      [],
      null,
      undefined,
      undefined,
      null,
    );
    expect(payloadDe(query2).objecao).toBeNull();
  });
});
