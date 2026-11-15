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

  it('lê matcher.any_tags do frontmatter: a etiqueta do pacote não se perde na importação', () => {
    const comEtiqueta = `---
name: prospec-odonto
description: Abordagem para dentistas.
matcher:
  any_keywords: [dentista, odontologia]
  any_tags: [odonto, clinica]
---
Apresente-se e pergunte sobre a agenda.`;
    const out = parseSkillPackage(makeZip({ 'SKILL.md': comEtiqueta }));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.pkg.matcher.any_keywords).toEqual(['dentista', 'odontologia']);
      expect(out.pkg.matcher.any_tags).toEqual(['odonto', 'clinica']);
    }
  });

  it('pacote sem any_tags segue sem o campo', () => {
    const out = parseSkillPackage(makeZip({ 'SKILL.md': validSkillMd }));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.pkg.matcher.any_tags).toBeUndefined();
  });

  it('SKILL.md ausente → erro de ensino', () => {
    const out = parseSkillPackage(makeZip({ 'leia.txt': 'oi' }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('skill_md_missing');
  });

  // #4458: o formato que o ecossistema publica (blader/humanizer e a maioria das
  // skills de frontmatter solto) NÃO traz matcher. Sem matcher a skill não entra
  // por palavra no turno — ela só roda quando o roteiro a puxa pelo nome.
  it('#4458: SKILL.md sem matcher (formato do ecossistema) importa, com matcher vazio', () => {
    const semMatcher = `---
name: reescreve-prosa
description: |
  Reescreve texto com cara de IA para soar como a pessoa que escreveu.
  Use ao revisar ou editar prosa.
license: MIT
metadata:
  version: "1.0.0"
---
# Passo a passo
Reescreva o texto mantendo o que ele diz.`;
    const out = parseSkillPackage(makeZip({ 'humanizer-main/SKILL.md': semMatcher }));
    expect(out.ok).toBe(true);
    if (out.ok) {
      // matcher vazio: nenhuma palavra-chave, nenhuma etiqueta — fora do roteamento automático.
      expect(out.pkg.matcher).toEqual({});
      expect(out.pkg.matcher.any_keywords).toBeUndefined();
      expect(out.pkg.body).toContain('Reescreva o texto');
      // `description: |` é bloco: o texto multilinha vira a descrição do índice, não "|".
      expect(out.pkg.description).toBe(
        'Reescreve texto com cara de IA para soar como a pessoa que escreveu. Use ao revisar ou editar prosa.',
      );
    }
  });

  it('#4458: matcher: {} no frontmatter é ausência de matcher (uso explícito), não erro', () => {
    const soCorpo = `---\nname: x\ndescription: y\nmatcher: {}\n---\ncorpo`;
    const out = parseSkillPackage(makeZip({ 'SKILL.md': soCorpo }));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.pkg.matcher).toEqual({});
  });

  it('#4458: matcher REALMENTE inválido (item vazio na lista) segue recusado nomeando o campo', () => {
    const itemVazio = `---\nname: x\ndescription: y\nmatcher:\n  any_keywords: [""]\n---\ncorpo`;
    const out = parseSkillPackage(makeZip({ 'SKILL.md': itemVazio }));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('skill_frontmatter_invalid');
      expect(out.error.message).toContain('any_keywords');
    }
  });

  it('#4458: matcher REALMENTE inválido (lista vazia declarada) segue recusado com o campo no nome', () => {
    const listaVazia = `---\nname: x\ndescription: y\nmatcher:\n  any_keywords: []\n---\ncorpo`;
    const out = parseSkillPackage(makeZip({ 'SKILL.md': listaVazia }));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('skill_frontmatter_invalid');
      expect(out.error.message).toContain('any_keywords');
    }
  });

  it('#4458: chave desconhecida dentro do matcher é erro (typo não vira "sem matcher")', () => {
    const typo = `---\nname: x\ndescription: y\nmatcher:\n  any_tag: [odonto]\n---\ncorpo`;
    const out = parseSkillPackage(makeZip({ 'SKILL.md': typo }));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('skill_frontmatter_invalid');
      expect(out.error.message).toContain('any_tag');
    }
  });

  it('#4458: matcher em linha (YAML válido que o parser não lê) é recusado, não vira matcher vazio', () => {
    const emLinha = `---\nname: x\ndescription: y\nmatcher: { any_keywords: [frete] }\n---\ncorpo`;
    const out = parseSkillPackage(makeZip({ 'SKILL.md': emLinha }));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('skill_frontmatter_invalid');
      expect(out.error.message).toContain('em bloco');
    }
  });

  it('#4458: linha em branco depois de matcher: não esconde as palavras-chave', () => {
    const comBranco = `---\nname: x\ndescription: y\nmatcher:\n\n  any_keywords: [frete]\n---\ncorpo`;
    const out = parseSkillPackage(makeZip({ 'SKILL.md': comBranco }));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.pkg.matcher.any_keywords).toEqual(['frete']);
  });

  it('#4458: matcher ausente e matcher: {} seguem importando com matcher vazio', () => {
    for (const fm of ['', 'matcher: {}\n', 'matcher: { }\n']) {
      const out = parseSkillPackage(makeZip({ 'SKILL.md': `---\nname: x\ndescription: y\n${fm}---\ncorpo` }));
      expect(out.ok, fm).toBe(true);
      if (out.ok) expect(out.pkg.matcher).toEqual({});
    }
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

  // #4203: o "Download ZIP" do GitHub embrulha tudo num diretório de topo. O
  // SKILL.md está na raiz DESSE diretório, não na raiz do zip — e o parser
  // respondia "precisa de um arquivo SKILL.md na raiz", que era falso.
  it('pacote embrulhado num diretório de topo (humanizer-main/SKILL.md) é aceito', () => {
    const out = parseSkillPackage(
      makeZip({
        'humanizer-main/SKILL.md': validSkillMd,
        'humanizer-main/references/tabela.md': '# Tabela de frete\nSP: grátis',
      }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.pkg.name).toBe('frete-gratis');
      // O caminho no manifest é o DA SKILL, não o do embrulho: a chave no
      // Storage é {org}/{nome}/{versão}/{caminho} e não pode carregar o nome
      // que o GitHub deu ao diretório na hora do download.
      expect(out.pkg.files.map((f) => f.path)).toEqual(['references/tabela.md']);
      expect(out.pkg.files[0]?.entry.kind).toBe('reference');
    }
  });

  it('embrulho de repositório: a mobília do repo (README, LICENSE, .github/) não vira erro nem arquivo da skill', () => {
    const out = parseSkillPackage(
      makeZip({
        'humanizer-main/SKILL.md': validSkillMd,
        'humanizer-main/README.md': '# humanizer',
        'humanizer-main/LICENSE': 'MIT',
        'humanizer-main/.github/workflows/validate.yml': 'on: push',
        'humanizer-main/references/tabela.md': '# Tabela de frete\nSP: grátis',
        'README.md': 'fora do embrulho também é mobília',
      }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.pkg.files.map((f) => f.path)).toEqual(['references/tabela.md']);
  });

  it('dois diretórios de topo com SKILL.md → recusa com o MESMO code, sem adivinhar qual', () => {
    const out = parseSkillPackage(
      makeZip({
        'humanizer-main/SKILL.md': validSkillMd,
        'outra-skill/SKILL.md': validSkillMd,
      }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('skill_md_missing');
      // A mensagem nomeia os candidatos: quem enviou escolhe, o parser não.
      expect(out.error.message).toContain('humanizer-main');
      expect(out.error.message).toContain('outra-skill');
    }
  });
});
