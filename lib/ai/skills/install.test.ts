import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';

import { importSkillPackage, installPlatformSkill } from './install';
import { ALFABETO_DO_NOME_NO_STORAGE } from './package';
import type { ParsedSkillPackage } from './package';

const ORG = '11111111-0000-4000-8000-000000000001';

/** Mesmo padrão de mock do pool usado em org-memory.test.ts: fila de respostas em ordem de chamada. */
function poolSeq(responses: Array<{ rows?: unknown[]; rowCount?: number }>): pg.Pool {
  const query = vi.fn();
  for (const r of responses) query.mockResolvedValueOnce(r);
  return { query } as unknown as pg.Pool;
}

function stubAdmin(opts?: { failPath?: string }) {
  const uploaded: string[] = [];
  const upload = vi.fn(async (path: string) => {
    if (opts?.failPath === path) return { data: null, error: { message: 'boom' } };
    uploaded.push(path);
    return { data: { path }, error: null };
  });
  const remove = vi.fn(async (paths: string[]) => ({ data: paths.map((p) => ({ name: p })), error: null }));
  const admin = { storage: { from: () => ({ upload, remove }) } } as unknown as SupabaseClient;
  return { admin, upload, remove };
}

function makePkg(overrides: Partial<ParsedSkillPackage> = {}): ParsedSkillPackage {
  return {
    name: 'frete-gratis',
    description: 'Explica a política de frete grátis.',
    matcher: { any_keywords: ['frete'] },
    body: 'Quando o cliente perguntar sobre frete, confirme o CEP.',
    files: [
      {
        path: 'references/tabela.md',
        bytes: new TextEncoder().encode('# tabela de frete'),
        entry: { path: 'references/tabela.md', size: 18, sha256: 'a'.repeat(64), kind: 'reference' },
      },
    ],
    ...overrides,
  };
}

describe('importSkillPackage', () => {
  it('insere a versão primeiro, sobe os arquivos em {org}/{skill}/{versionId}/... e move o ponteiro', async () => {
    const pool = poolSeq([
      {
        rows: [
          { id: 'ver-1', organization_id: ORG, name: 'frete-gratis', description: 'd', body: 'b', matcher: {}, created_at: new Date() },
        ],
      }, // insertSkillVersion
      { rowCount: 1 }, // setSkillPointer
    ]);
    const { admin, upload } = stubAdmin();
    const pkg = makePkg();

    const out = await importSkillPackage({ db: pool, admin }, { organizationId: ORG, pkg, createdBy: 'user-1' });

    expect(out).toEqual({ versionId: 'ver-1', name: 'frete-gratis' });
    expect(upload).toHaveBeenCalledWith(
      `${ORG}/frete-gratis/ver-1/references/tabela.md`,
      expect.anything(),
      { upsert: false },
    );
    const insertValues = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    expect(insertValues).toContain(JSON.stringify(pkg.files.map((f) => f.entry)));
  });

  it('org_id nunca vem do pkg — sempre input.organizationId', async () => {
    const pool = poolSeq([
      { rows: [{ id: 'ver-2', organization_id: ORG, name: 'x', description: 'd', body: 'b', matcher: {}, created_at: new Date() }] },
      { rowCount: 1 },
    ]);
    const { admin } = stubAdmin();
    // pkg "malicioso" com um campo organization_id estranho — install.ts não pode olhar pra ele.
    const pkg = { ...makePkg(), organizationId: 'org-evil' } as ParsedSkillPackage;

    await importSkillPackage({ db: pool, admin }, { organizationId: ORG, pkg, createdBy: null });

    const insertValues = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    expect(insertValues[0]).toBe(ORG);
  });

  it('upload falho: remove os já subidos e lança — a versão órfã fica no banco (ponteiro não move)', async () => {
    const pkg = makePkg({
      files: [
        { path: 'a.md', bytes: new TextEncoder().encode('a'), entry: { path: 'a.md', size: 1, sha256: 'a'.repeat(64), kind: 'reference' } },
        { path: 'b.md', bytes: new TextEncoder().encode('b'), entry: { path: 'b.md', size: 1, sha256: 'b'.repeat(64), kind: 'reference' } },
      ],
    });
    const pool = poolSeq([
      {
        rows: [
          { id: 'ver-3', organization_id: ORG, name: pkg.name, description: pkg.description, body: pkg.body, matcher: pkg.matcher, created_at: new Date() },
        ],
      }, // só o insert — upload falha antes do setSkillPointer
    ]);
    const { admin, remove } = stubAdmin({ failPath: `${ORG}/${pkg.name}/ver-3/b.md` });

    await expect(
      importSkillPackage({ db: pool, admin }, { organizationId: ORG, pkg, createdBy: null }),
    ).rejects.toThrow();

    expect(remove).toHaveBeenCalledWith([`${ORG}/${pkg.name}/ver-3/a.md`]);
    expect((pool.query as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1); // setSkillPointer nunca chamado
  });

  it('toda chave que cruza para o Storage obedece ao alfabeto de lá (forma, não estabilidade)', async () => {
    const pool = poolSeq([
      {
        rows: [
          { id: 'ver-4', organization_id: ORG, name: 'frete gratis', description: 'd', body: 'b', matcher: {}, created_at: new Date() },
        ],
      },
      { rowCount: 1 },
    ]);
    const { admin, upload } = stubAdmin();
    const pkg = makePkg({
      name: 'frete gratis',
      files: [
        {
          path: 'references/tabela de frete.md',
          bytes: new TextEncoder().encode('# x'),
          entry: { path: 'references/tabela de frete.md', size: 3, sha256: 'a'.repeat(64), kind: 'reference' },
        },
        {
          path: 'assets/capa.png',
          bytes: new TextEncoder().encode('x'),
          entry: { path: 'assets/capa.png', size: 1, sha256: 'b'.repeat(64), kind: 'asset' },
        },
      ],
    });

    await importSkillPackage({ db: pool, admin }, { organizationId: ORG, pkg, createdBy: null });

    const chaves = upload.mock.calls.map((c) => c[0] as string);
    expect(chaves).toHaveLength(2);
    for (const chave of chaves) {
      for (const segmento of chave.split('/')) expect(segmento).toMatch(ALFABETO_DO_NOME_NO_STORAGE);
    }
  });
});

describe('installPlatformSkill', () => {
  it('copia a skill_version de plataforma (por name) pra org com forked_from_version_id + move o ponteiro', async () => {
    const pool = poolSeq([
      {
        rows: [
          { id: 'plat-1', name: 'frete-gratis', description: 'd', body: 'b', matcher: { any_keywords: ['frete'] }, manifest: [] },
        ],
      }, // select da plataforma
      {
        rows: [
          { id: 'org-ver-1', organization_id: ORG, name: 'frete-gratis', description: 'd', body: 'b', matcher: { any_keywords: ['frete'] }, created_at: new Date() },
        ],
      }, // insertSkillVersion (org)
      { rowCount: 1 }, // setSkillPointer
    ]);

    const out = await installPlatformSkill({ db: pool }, { organizationId: ORG, name: 'frete-gratis', createdBy: 'user-1' });

    expect(out).toEqual({ versionId: 'org-ver-1' });
    const insertValues = (pool.query as ReturnType<typeof vi.fn>).mock.calls[1]![1] as unknown[];
    expect(insertValues[0]).toBe(ORG); // tenantId é a org, nunca null
    expect(insertValues).toContain('plat-1'); // forked_from_version_id aponta pra origem
  });

  it('skill de plataforma inexistente → lança (nada pra instalar)', async () => {
    const pool = poolSeq([{ rows: [] }]);
    await expect(
      installPlatformSkill({ db: pool }, { organizationId: ORG, name: 'sumida', createdBy: null }),
    ).rejects.toThrow();
  });
});
