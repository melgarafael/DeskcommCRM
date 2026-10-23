import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '../obs/logger';
import type { TurnPreview } from './preview';
import type { LoadedSkill } from './skills';
import { etiquetasParaOMatcher } from './etiquetas-do-matcher';

const skill = (name: string, matcher: LoadedSkill['matcher']): LoadedSkill => ({
  versionId: `v-${name}`,
  name,
  description: 'd',
  body: `corpo de ${name}`,
  matcher,
  manifest: [],
});

const semEtiqueta = [skill('frete', { any_keywords: ['frete'] })];
const comEtiqueta = [skill('prospec-odonto', { any_keywords: ['dentista'], any_tags: ['odonto'] })];

function poolCom(query: ReturnType<typeof vi.fn>) {
  return { query } as never;
}

function logFalso() {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger & {
    warn: ReturnType<typeof vi.fn>;
  };
}

describe('etiquetasParaOMatcher', () => {
  it('(a) nenhuma skill com any_tags → não consulta o banco e devolve []', async () => {
    const query = vi.fn();
    const out = await etiquetasParaOMatcher(poolCom(query), 'org-1', 'conv-1', semEtiqueta, undefined, logFalso());
    expect(out).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('(b) preview → não consulta o banco, mesmo com skill que pede etiqueta', async () => {
    const query = vi.fn();
    const preview = {} as TurnPreview;
    const out = await etiquetasParaOMatcher(poolCom(query), 'org-1', 'conv-1', comEtiqueta, preview, logFalso());
    expect(out).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('(c) skill com any_tags → consulta com tenant e conversa, filtrando por organization_id, e devolve as etiquetas', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ tags: ['odonto', 'vip'] }] });
    const out = await etiquetasParaOMatcher(poolCom(query), 'org-1', 'conv-1', comEtiqueta, undefined, logFalso());

    expect(out).toEqual(['odonto', 'vip']);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['org-1', 'conv-1']);
    expect(sql).toContain('cv.organization_id = $1');
    expect(sql).toContain('c.organization_id = cv.organization_id');
  });

  it('(c2) linha sem etiquetas (null) → []', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ tags: null }] });
    const out = await etiquetasParaOMatcher(poolCom(query), 'org-1', 'conv-1', comEtiqueta, undefined, logFalso());
    expect(out).toEqual([]);
  });

  it('(d) consulta lança → devolve [] e registra com log.warn', async () => {
    const query = vi.fn().mockRejectedValue(new Error('conexão caiu'));
    const log = logFalso();
    const out = await etiquetasParaOMatcher(poolCom(query), 'org-1', 'conv-1', comEtiqueta, undefined, log);
    expect(out).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[1]).toEqual({ erro: 'conexão caiu' });
  });
});
