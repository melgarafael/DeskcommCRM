import { beforeEach, describe, expect, it, vi } from 'vitest';

import { abrirAcesso } from '@/lib/external-db/acesso';
import { colunasDoCatalogo, type CatalogoMapeamento } from '@/lib/external-db/catalogo';
import { colunasDaTabela } from '@/lib/external-db/introspeccao';
import { lerTabela } from '@/lib/external-db/leitura';

import type { MotoDoCatalogo } from './fotos-do-catalogo';
import { carregarCatalogoDoBanco, mesclarMotos } from './catalogo-do-banco';

vi.mock('@/lib/external-db/acesso', () => ({ abrirAcesso: vi.fn() }));
vi.mock('@/lib/external-db/introspeccao', () => ({ colunasDaTabela: vi.fn() }));
vi.mock('@/lib/external-db/leitura', () => ({ lerTabela: vi.fn() }));

const MAPEAMENTO: CatalogoMapeamento = {
  connectionId: 'c1',
  schemaName: 'public',
  tableName: 'motos',
  colNome: 'nome',
  colVersao: null,
  colAno: 'ano',
  colCor: 'cor',
  colKm: 'quilometragem',
  colPreco: 'preco',
  colImagem: 'imagem_url',
  colEstoque: null,
  colCilindrada: 'cilindrada',
  colTipo: 'categoria',
  buscaOperador: 'contem',
  similaridadeDeterministica: true,
  similaresQtd: 3,
  colunas: [
    { coluna: 'nome', comparar: true, ordem: 1, compoeNome: true },
    { coluna: 'cilindrada', comparar: true, ordem: 2 },
    { coluna: 'preco', comparar: true, ordem: 4 },
  ],
  colSimilares: 'moto_similar',
};

function moto(nome: string): MotoDoCatalogo {
  return { nome, fotos: [`http://x/${nome}.jpg`] };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('mesclarMotos', () => {
  it('junta sem repetir pelo nome (ordem das listas)', () => {
    const r = mesclarMotos([moto('A'), moto('B')], [moto('B'), moto('C')]);
    expect(r.map((m) => m.nome)).toEqual(['A', 'B', 'C']);
  });
});

describe('carregarCatalogoDoBanco', () => {
  it('lê o banco e devolve as motos com os valores das colunas', async () => {
    vi.mocked(abrirAcesso).mockResolvedValue({
      ok: true,
      conexao: { maxRows: 100 },
      pool: {},
    } as never);
    vi.mocked(colunasDaTabela).mockResolvedValue(
      new Set(['nome', 'imagem_url', 'preco', 'cilindrada', 'categoria', 'moto_similar']),
    );
    vi.mocked(lerTabela).mockResolvedValue({
      colunas: ['nome', 'imagem_url', 'preco', 'cilindrada', 'categoria', 'moto_similar'],
      linhas: [
        {
          nome: 'Biz 125',
          imagem_url: 'http://x/1.jpg',
          preco: '14500',
          cilindrada: '125',
          categoria: 'Street',
          moto_similar: 'Pop 110, CG 160',
        },
      ],
      limite: 100,
      offset: 0,
    });

    const motos = await carregarCatalogoDoBanco({} as never, 'org', MAPEAMENTO, colunasDoCatalogo(MAPEAMENTO));
    expect(motos.map((m) => m.nome)).toEqual(['Biz 125']);
    expect(motos[0]?.valores?.moto_similar).toBe('Pop 110, CG 160');
    expect(motos[0]?.valores?.preco).toBe('14500');
  });

  it('acesso negado → lista vazia (não lança)', async () => {
    vi.mocked(abrirAcesso).mockResolvedValue({ ok: false, motivo: 'sem_conexao' } as never);
    const motos = await carregarCatalogoDoBanco({} as never, 'org', MAPEAMENTO, colunasDoCatalogo(MAPEAMENTO));
    expect(motos).toEqual([]);
  });

  it('tabela inexistente → lista vazia', async () => {
    vi.mocked(abrirAcesso).mockResolvedValue({
      ok: true,
      conexao: { maxRows: 100 },
      pool: {},
    } as never);
    vi.mocked(colunasDaTabela).mockResolvedValue(null);
    const motos = await carregarCatalogoDoBanco({} as never, 'org', MAPEAMENTO, colunasDoCatalogo(MAPEAMENTO));
    expect(motos).toEqual([]);
  });

  it('falha de leitura → lista vazia (fallback do chamador)', async () => {
    vi.mocked(abrirAcesso).mockResolvedValue({
      ok: true,
      conexao: { maxRows: 100 },
      pool: {},
    } as never);
    vi.mocked(colunasDaTabela).mockResolvedValue(new Set(['nome', 'imagem_url']));
    vi.mocked(lerTabela).mockRejectedValue(new Error('banco fora'));
    const motos = await carregarCatalogoDoBanco({} as never, 'org', MAPEAMENTO, colunasDoCatalogo(MAPEAMENTO));
    expect(motos).toEqual([]);
  });
});
