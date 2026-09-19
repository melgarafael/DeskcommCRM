import { describe, expect, it } from 'vitest';

import {
  extrairMotosDoResultado,
  fotosParaAnexar,
  motosCitadasNoTexto,
  normalizarNomeDeMoto,
} from './fotos-do-catalogo';

const RESULTADO = {
  conexao: { id: 'c1', label: 'Allma' },
  schema: 'public',
  tabela: 'motos',
  colunas: ['id', 'nome', 'imagem_url'],
  linhas: [
    { id: 3, nome: 'CB 300 F Twister', imagem_url: 'http://x/cb1.jpg|http://x/cb2.jpg' },
    { id: 7, nome: 'XMax 250', imagem_url: 'http://x/xmax1.jpg' },
    { id: 13, nome: 'XTZ 150 CROSSER', imagem_url: 'http://x/xtz1.jpg' },
    { id: 99, nome: 'Sem Foto', imagem_url: null },
  ],
};

describe('extrairMotosDoResultado', () => {
  it('extrai nome + fotos válidas ignorando linhas sem imagem', () => {
    const motos = extrairMotosDoResultado(RESULTADO);
    expect(motos.map((m) => m.nome)).toEqual(['CB 300 F Twister', 'XMax 250', 'XTZ 150 CROSSER']);
    expect(motos[0]?.fotos).toEqual(['http://x/cb1.jpg', 'http://x/cb2.jpg']);
  });

  it('não lança e devolve [] para shapes desconhecidos', () => {
    expect(extrairMotosDoResultado(null)).toEqual([]);
    expect(extrairMotosDoResultado({})).toEqual([]);
    expect(extrairMotosDoResultado({ erro: 'filtro_sem_valor' })).toEqual([]);
    expect(extrairMotosDoResultado('texto')).toEqual([]);
  });
});

describe('fotosParaAnexar', () => {
  it('anexa a 1ª foto de cada moto citada no texto, na ordem do catálogo', () => {
    const catalogo = extrairMotosDoResultado(RESULTADO);
    const texto =
      'Não temos a CB 250, mas separei a CB 300 F Twister e a XMax 250 pra você.';
    expect(fotosParaAnexar(texto, catalogo)).toEqual(['http://x/cb1.jpg', 'http://x/xmax1.jpg']);
  });

  it('casa ignorando acento, caixa e espaços', () => {
    const catalogo = extrairMotosDoResultado(RESULTADO);
    expect(fotosParaAnexar('olha essa cb300f twister', catalogo)).toEqual(['http://x/cb1.jpg']);
  });

  it('texto sem moto conhecida não inventa foto', () => {
    const catalogo = extrairMotosDoResultado(RESULTADO);
    expect(fotosParaAnexar('Boa tarde! Como posso ajudar?', catalogo)).toEqual([]);
  });

  it('não casa nome curto solto ("CB")', () => {
    const catalogo = [{ nome: 'CB', fotos: ['http://x/cb.jpg'] }];
    expect(motosCitadasNoTexto('tenho interesse em uma CB', catalogo)).toEqual([]);
  });

  it('respeita o limite de fotos', () => {
    const catalogo = extrairMotosDoResultado(RESULTADO);
    const texto = 'CB 300 F Twister, XMax 250 e XTZ 150 CROSSER';
    expect(fotosParaAnexar(texto, catalogo, 2)).toHaveLength(2);
  });
});

describe('normalizarNomeDeMoto', () => {
  it('minúsculas, sem acento, espaços colapsados', () => {
    expect(normalizarNomeDeMoto('  CB  300 F  Twíster ')).toBe('cb 300 f twister');
  });
});
