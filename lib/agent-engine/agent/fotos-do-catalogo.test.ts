import { describe, expect, it } from 'vitest';

import {
  extrairMotosDoResultado,
  formatarPreco,
  fotosComLegenda,
  legendaDaMoto,
  motosCitadasNoTexto,
  normalizarNomeDeMoto,
} from './fotos-do-catalogo';

const RESULTADO = {
  conexao: { id: 'c1', label: 'Allma' },
  schema: 'public',
  tabela: 'motos',
  colunas: ['id', 'nome', 'ano', 'cor', 'preco', 'quilometragem', 'imagem_url'],
  linhas: [
    {
      id: 3,
      nome: 'CB 300 F Twister',
      ano: '2025',
      cor: 'Vermelho',
      preco: '28990.00',
      quilometragem: '4500',
      imagem_url: 'http://x/cb1.jpg|http://x/cb2.jpg',
    },
    { id: 7, nome: 'XMax 250', ano: '2023', cor: 'Vermelho', preco: '31990.00', quilometragem: '12000', imagem_url: 'http://x/xmax1.jpg' },
    { id: 23, nome: 'YS Fazer 250', ano: '2017', cor: 'Vermelho', preco: '17990.00', quilometragem: '82300', imagem_url: 'http://x/fazer1.jpg' },
    { id: 99, nome: 'Sem Foto', imagem_url: null },
  ],
};

describe('extrairMotosDoResultado', () => {
  it('extrai nome, fotos e campos de legenda ignorando linhas sem imagem', () => {
    const motos = extrairMotosDoResultado(RESULTADO);
    expect(motos.map((m) => m.nome)).toEqual(['CB 300 F Twister', 'XMax 250', 'YS Fazer 250']);
    expect(motos[0]?.fotos).toEqual(['http://x/cb1.jpg', 'http://x/cb2.jpg']);
    expect(motos[0]).toMatchObject({ ano: '2025', cor: 'Vermelho', preco: '28990.00', quilometragem: '4500' });
  });

  it('não lança e devolve [] para shapes desconhecidos', () => {
    expect(extrairMotosDoResultado(null)).toEqual([]);
    expect(extrairMotosDoResultado({})).toEqual([]);
    expect(extrairMotosDoResultado({ erro: 'filtro_sem_valor' })).toEqual([]);
    expect(extrairMotosDoResultado('texto')).toEqual([]);
  });
});

describe('fotosComLegenda', () => {
  it('1 foto por moto citada, cada uma com a legenda da PRÓPRIA moto', () => {
    const catalogo = extrairMotosDoResultado(RESULTADO);
    const texto = 'Não temos a CB 250, mas separei a CB 300 F Twister e a YS Fazer 250 pra você.';
    const plano = fotosComLegenda(texto, catalogo);
    expect(plano.map((p) => p.url)).toEqual(['http://x/cb1.jpg', 'http://x/fazer1.jpg']);
    expect(plano[0]?.legenda).toContain('CB 300 F Twister 2025');
    expect(plano[0]?.legenda).toContain('R$ 28.990,00');
    expect(plano[1]?.legenda).toContain('YS Fazer 250 2017');
    expect(plano[1]?.legenda).toContain('R$ 17.990,00');
  });

  it('casa ignorando acento, caixa e espaços', () => {
    const catalogo = extrairMotosDoResultado(RESULTADO);
    expect(fotosComLegenda('olha essa cb300f twister', catalogo).map((p) => p.url)).toEqual([
      'http://x/cb1.jpg',
    ]);
  });

  it('texto sem moto conhecida não inventa foto', () => {
    const catalogo = extrairMotosDoResultado(RESULTADO);
    expect(fotosComLegenda('Boa tarde! Como posso ajudar?', catalogo)).toEqual([]);
  });

  it('não casa nome curto solto ("CB")', () => {
    const catalogo = [{ nome: 'CB', fotos: ['http://x/cb.jpg'] }];
    expect(motosCitadasNoTexto('tenho interesse em uma CB', catalogo)).toEqual([]);
  });

  it('respeita o limite de fotos', () => {
    const catalogo = extrairMotosDoResultado(RESULTADO);
    const texto = 'CB 300 F Twister, XMax 250 e YS Fazer 250';
    expect(fotosComLegenda(texto, catalogo, 2)).toHaveLength(2);
  });
});

describe('legendaDaMoto / formatarPreco', () => {
  it('formata preço brasileiro', () => {
    expect(formatarPreco('28990.00')).toBe('R$ 28.990,00');
    expect(formatarPreco('17990')).toBe('R$ 17.990,00');
  });

  it('monta a legenda com nome/ano, cor, km e preço', () => {
    const legenda = legendaDaMoto({
      nome: 'CB 300 F Twister',
      fotos: ['http://x/1.jpg'],
      ano: '2025',
      cor: 'Vermelho',
      quilometragem: '4500',
      preco: '28990.00',
    });
    expect(legenda).toBe(
      'CB 300 F Twister 2025\nCor: Vermelho\nQuilometragem: 4500 km\nPreço: R$ 28.990,00',
    );
  });

  it('com só o nome, ainda identifica a moto', () => {
    expect(legendaDaMoto({ nome: 'XMax 250', fotos: ['http://x/1.jpg'] })).toBe('XMax 250');
  });
});

describe('normalizarNomeDeMoto', () => {
  it('minúsculas, sem acento, espaços colapsados', () => {
    expect(normalizarNomeDeMoto('  CB  300 F  Twíster ')).toBe('cb 300 f twister');
  });
});
