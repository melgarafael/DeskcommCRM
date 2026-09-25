import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { parseSkillPackage } from './package';

function makeZip(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [p, c] of Object.entries(files)) entries[p] = strToU8(c);
  return zipSync(entries);
}

const validSkillMd = `---
name: frete-gratis
description: Explica a política de frete grátis ao cliente.
matcher:
  any_keywords: [frete, entrega]
  probe_keywords: [envio]
---
Quando o cliente perguntar sobre frete, explique a regra e confirme o CEP.`;

describe('parseSkillPackage', () => {
  it('lê SKILL.md (frontmatter → matcher/name/description, corpo) + references', () => {
    const zip = makeZip({ 'SKILL.md': validSkillMd, 'references/tabela.md': '# Tabela de frete\nSP: grátis' });
    const out = parseSkillPackage(zip);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.pkg.name).toBe('frete-gratis');
      expect(out.pkg.matcher.any_keywords).toEqual(['frete', 'entrega']);
      expect(out.pkg.body).toContain('confirme o CEP');
      expect(out.pkg.body).not.toContain('---'); // frontmatter removido
      const ref = out.pkg.files.find((f) => f.path === 'references/tabela.md');
      expect(ref?.entry.kind).toBe('reference');
      expect(ref?.entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('SKILL.md ausente → erro de ensino', () => {
    const out = parseSkillPackage(makeZip({ 'leia.txt': 'oi' }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('skill_md_missing');
  });

  it('frontmatter inválido (sem any_keywords) → erro de ensino', () => {
    const bad = `---\nname: x\ndescription: y\nmatcher: {}\n---\ncorpo`;
    const out = parseSkillPackage(makeZip({ 'SKILL.md': bad }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('skill_frontmatter_invalid');
  });

  it('path traversal é recusado', () => {
    const out = parseSkillPackage(makeZip({ 'SKILL.md': validSkillMd, '../evil.md': 'x' }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('skill_unsafe_path');
  });

  it('excesso de arquivos é recusado', () => {
    const files: Record<string, string> = { 'SKILL.md': validSkillMd };
    for (let i = 0; i < 65; i++) files[`references/f${i}.md`] = 'x';
    const out = parseSkillPackage(makeZip(files));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('skill_too_many_files');
  });

  it('extensão de asset fora da whitelist é recusada', () => {
    const out = parseSkillPackage(makeZip({ 'SKILL.md': validSkillMd, 'assets/x.html': '<p>oi</p>' }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('skill_asset_extension_invalid');
  });

  it('caminho fora de references/ e assets/ é recusado', () => {
    const out = parseSkillPackage(makeZip({ 'SKILL.md': validSkillMd, 'docs/readme.md': '# oi' }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('skill_unexpected_path');
  });

  it('zip-bomb (entrada declara >1MB descompactado) é recusado ANTES de inflar', () => {
    const zip = makeZip({ 'SKILL.md': validSkillMd, 'references/big.md': 'a'.repeat(1_100_000) });
    const out = parseSkillPackage(zip);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('skill_file_too_large');
  });

  it('frontmatter com palavra entre aspas vira palavra sem aspas', () => {
    const withQuotes = `---
name: frete-gratis
description: Explica a política de frete grátis ao cliente.
matcher:
  any_keywords: ["frete", 'entrega']
---
corpo`;
    const out = parseSkillPackage(makeZip({ 'SKILL.md': withQuotes }));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.pkg.matcher.any_keywords).toEqual(['frete', 'entrega']);
  });

  it('nome de arquivo fora do alfabeto do Storage é recusado (a chave cruza para o terceiro)', () => {
    const out = parseSkillPackage(makeZip({ 'SKILL.md': validSkillMd, 'assets/ícone.png': 'x' }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('skill_storage_name_invalid');
  });

  it('nome da skill fora do alfabeto do Storage é recusado', () => {
    const comAcento = validSkillMd.replace('name: frete-gratis', 'name: Relatório de vendas');
    const out = parseSkillPackage(makeZip({ 'SKILL.md': comAcento }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('skill_storage_name_invalid');
  });

  it('o alfabeto aceito é o do Storage, não um slug: espaço, ponto e hífen passam', () => {
    const comEspaco = validSkillMd.replace('name: frete-gratis', 'name: frete gratis');
    const out = parseSkillPackage(makeZip({ 'SKILL.md': comEspaco, 'assets/capa do produto.png': 'x' }));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.pkg.files.map((f) => f.path)).toEqual(['assets/capa do produto.png']);
  });
});
