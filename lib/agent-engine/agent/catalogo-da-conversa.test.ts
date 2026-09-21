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
});

describe('carregarCatalogoDaConversa', () => {
  it('lê o metadata e filtra entradas inválidas', async () => {
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [{ agent_catalogo: { motos: [TWISTER, { nome: 'x' }], detalhadas: ['CB 300', 7] } }],
      }),
    } as never;
    const estado = await carregarCatalogoDaConversa(db, 'org', 'conv');
    expect(estado.motos).toHaveLength(1);
    expect(estado.motos[0]?.nome).toBe('CB 300 F Twister');
    expect(estado.detalhadas).toEqual(['CB 300']);
  });

  it('ausência/erro ⇒ vazio (nunca lança)', async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error('boom')) } as never;
    expect(await carregarCatalogoDaConversa(db, 'org', 'conv')).toEqual({
      motos: [],
      detalhadas: [],
    });
  });
});

describe('salvarCatalogoDaConversa', () => {
  it('faz merge: motos novas primeiro, dedup e marca a detalhada', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await salvarCatalogoDaConversa(
      { query } as never,
      'org',
      'conv',
      { motos: [TWISTER], detalhadas: [] },
      [CB300, TWISTER],
      'CB 300 F Twister',
    );
    expect(query).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(query.mock.calls[0]![1]![2] as string) as {
      motos: { nome: string }[];
      detalhadas: string[];
    };
    expect(payload.motos.map((m) => m.nome)).toEqual(['CB 300', 'CB 300 F Twister']);
    expect(payload.detalhadas).toEqual(['cb 300 f twister']);
  });
});
