import { describe, expect, it } from 'vitest';

import { catalogConfigSchema, CATALOG_CONFIG_DEFAULT, parseCatalogConfig } from './catalog-config';

describe('catalogConfigSchema', () => {
  it('defaults preservam o comportamento atual (determinística DESLIGADA)', () => {
    expect(CATALOG_CONFIG_DEFAULT.similaridade_deterministica).toBe(false);
    expect(CATALOG_CONFIG_DEFAULT.similares_qtd).toBe(3);
    expect(CATALOG_CONFIG_DEFAULT.criterio).toEqual(['cilindrada', 'preco']);
  });

  it('recusa quantidade fora da faixa e critério vazio', () => {
    expect(catalogConfigSchema.safeParse({ similares_qtd: 0 }).success).toBe(false);
    expect(catalogConfigSchema.safeParse({ similares_qtd: 9 }).success).toBe(false);
    expect(catalogConfigSchema.safeParse({ criterio: [] }).success).toBe(false);
  });
});

describe('parseCatalogConfig (runtime tolerante)', () => {
  it('bloco ausente/nulo/estranho → default', () => {
    expect(parseCatalogConfig(undefined)).toEqual(CATALOG_CONFIG_DEFAULT);
    expect(parseCatalogConfig(null)).toEqual(CATALOG_CONFIG_DEFAULT);
    expect(parseCatalogConfig('texto')).toEqual(CATALOG_CONFIG_DEFAULT);
  });

  it('bloco parcial mantém o que veio e usa default no resto', () => {
    const cfg = parseCatalogConfig({ similaridade_deterministica: true, similares_qtd: 5 });
    expect(cfg.similaridade_deterministica).toBe(true);
    expect(cfg.similares_qtd).toBe(5);
    expect(cfg.criterio).toEqual(['cilindrada', 'preco']);
  });

  it('nunca lança com campo inválido', () => {
    expect(() => parseCatalogConfig({ similares_qtd: 999 })).not.toThrow();
  });
});
