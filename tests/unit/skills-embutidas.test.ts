/**
 * AS SKILLS EMBUTIDAS CHEGAM IGUAIS EM TODO CLI — E EM TODO CLONE.
 *
 * O repo embute skills para quem instala, monta um cliente, analisa métricas,
 * afina o prompt do agente ou contribui, usando Claude Code, Codex, Cursor,
 * OpenCode ou Antigravity. A fonte é `.agents/skills/<nome>/` (padrão aberto,
 * lido por quatro dos cinco); `.claude/skills/<nome>/` é espelho gerado por
 * `pnpm skills:sync` (o Claude Code só lê ali). O porquê da cópia está em
 * `scripts/skills-embutidas/espelho.ts`.
 *
 * ## Os defeitos que este arquivo existe para pegar
 *
 * 1. **Espelho divergente.** Medido em 2026-09-08: a cópia de Codex da skill de
 *    doutrina ficou 35 dias sendo a versão gerada em julho — que ensinava
 *    `snake_case` e imports relativos, o contrário da base — enquanto a de
 *    Claude tinha sido reescrita. Nenhum gate comparava as duas.
 * 2. **Skill escondida pelo `.gitignore`.** `.claude/skills/*` é ignorado com
 *    allowlist; uma skill nova ali sobe só no espelho de Codex e o `git add`
 *    não avisa. Por isso aqui se pergunta ao git, não ao disco.
 * 3. **Cabeçalho que o CLI recusa.** O padrão aberto exige `name` em
 *    minúsculas-e-hífen igual ao diretório e `description` de 1 a 1024
 *    caracteres; Cursor e Codex validam isso e uma skill fora do padrão some
 *    sem erro.
 * 4. **Orçamento do Codex estourado.** O Codex lista skills em no máximo 2% da
 *    janela (ou 8.000 caracteres) e, quando estoura, ENCURTA E DEPOIS REMOVE as
 *    descrições — aí nenhuma skill aciona sozinha. Medido nesta máquina em
 *    2026-09-08 com ~45 skills globais. O repo não pode ser quem consome esse
 *    orçamento por um leigo.
 * 5. **Skill dentro da imagem Docker.** `.dockerignore` não excluía o harness e
 *    a imagem do worker (`COPY . .`) carregava tudo isso.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ESPELHO,
  FONTE,
  divergencias,
  listarSkills,
  orfasNoEspelho,
} from "../../scripts/skills-embutidas/espelho";

const RAIZ = process.cwd();
const SKILLS = listarSkills(RAIZ);

/** Regras do padrão aberto Agent Skills (agentskills.io/specification). */
const NOME_VALIDO = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NOME_MAX = 64;
const DESCRICAO_MAX = 1024;
const CORPO_MAX_LINHAS = 500;
/**
 * O Codex lista skills em até 8.000 caracteres quando não conhece a janela.
 * O repo fica com 6.000 no máximo — a sobra é para as skills do próprio
 * usuário, que nenhum teste daqui enxerga.
 */
const ORCAMENTO_DESCRICOES = 6000;

function lerSkill(nome: string) {
  const texto = readFileSync(join(RAIZ, FONTE, nome, "SKILL.md"), "utf8");
  const linhas = texto.split("\n");
  expect(linhas[0], `${nome}: SKILL.md não abre com '---'`).toBe("---");
  const fim = linhas.indexOf("---", 1);
  expect(fim, `${nome}: frontmatter sem '---' de fechamento`).toBeGreaterThan(0);
  const cabecalho = linhas.slice(1, fim);
  const campo = (chave: string) =>
    cabecalho.find((l) => l.startsWith(`${chave}:`))?.slice(chave.length + 1).trim() ?? "";
  return { name: campo("name"), description: campo("description"), corpo: linhas.slice(fim + 1) };
}

function rastreado(caminho: string): boolean {
  const saida = execFileSync("git", ["ls-files", "--", caminho], { cwd: RAIZ, encoding: "utf8" });
  return saida.trim().length > 0;
}

describe("skills embutidas — cabeçalho no padrão que os cinco CLIs aceitam", () => {
  it("a fonte não vem vazia (guarda de vacuidade)", () => {
    expect(SKILLS.length, "nenhuma skill em .agents/skills").toBeGreaterThanOrEqual(2);
  });

  it.each(SKILLS)("%s: name igual ao diretório, minúsculas e hífen", (nome) => {
    const { name } = lerSkill(nome);
    expect(name).toBe(nome);
    expect(name).toMatch(NOME_VALIDO);
    expect(name.length).toBeLessThanOrEqual(NOME_MAX);
  });

  it.each(SKILLS)("%s: description numa linha, de 1 a 1024 caracteres", (nome) => {
    const { description } = lerSkill(nome);
    expect(description.length, `${nome}: description vazia`).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(DESCRICAO_MAX);
  });

  it.each(SKILLS)("%s: corpo cabe em 500 linhas (o resto vai para references/)", (nome) => {
    const { corpo } = lerSkill(nome);
    expect(corpo.length).toBeLessThanOrEqual(CORPO_MAX_LINHAS);
  });

  it("as descrições, somadas, cabem no orçamento que o Codex dá à lista de skills", () => {
    const total = SKILLS.reduce((soma, n) => soma + lerSkill(n).description.length, 0);
    expect(
      total,
      `${total} caracteres de description — acima disso o Codex encurta e depois remove as descrições, e nenhuma skill aciona sozinha`,
    ).toBeLessThanOrEqual(ORCAMENTO_DESCRICOES);
  });

  it.each(SKILLS)("%s: agents/openai.yaml (metadado do Codex) presente e com invocação implícita", (nome) => {
    const caminho = join(RAIZ, FONTE, nome, "agents", "openai.yaml");
    expect(existsSync(caminho), `${nome}: falta agents/openai.yaml`).toBe(true);
    const yaml = readFileSync(caminho, "utf8");
    expect(yaml).toMatch(/^\s*display_name:/m);
    expect(yaml).toMatch(/^\s*short_description:/m);
    // `false` aqui desligaria o acionamento automático no Codex — que é o
    // ponto inteiro de embutir a skill para quem não sabe que ela existe.
    expect(yaml).not.toMatch(/allow_implicit_invocation:\s*false/);
  });

  it.each(SKILLS)("%s: todo references/, scripts/ e assets/ citado no SKILL.md existe", (nome) => {
    const texto = readFileSync(join(RAIZ, FONTE, nome, "SKILL.md"), "utf8");
    const citados = [...texto.matchAll(/(?:references|scripts|assets)\/[A-Za-z0-9_./-]+/g)]
      .map((m) => m[0].replace(/[.,;:)]+$/, ""))
      .filter((c) => !c.endsWith("/"));
    const mortos = [...new Set(citados)].filter((c) => !existsSync(join(RAIZ, FONTE, nome, c)));
    expect(mortos, `${nome} cita arquivo que não existe`).toEqual([]);
  });
});

describe("skills embutidas — o espelho de Claude é fiel à fonte", () => {
  it.each(SKILLS)("%s: .claude/skills é byte a byte igual a .agents/skills", (nome) => {
    expect(
      divergencias(RAIZ, nome),
      `espelho desatualizado — rode: pnpm skills:sync`,
    ).toEqual([]);
  });

  it("nenhuma skill rastreada em .claude/skills ficou sem fonte", () => {
    expect(orfasNoEspelho(RAIZ), "a fonte é .agents/skills; apague ou crie a fonte").toEqual([]);
  });

  it.each(SKILLS)("%s: as duas cópias estão rastreadas pelo git (o .gitignore não escondeu nenhuma)", (nome) => {
    expect(rastreado(`${FONTE}/${nome}/SKILL.md`), `${FONTE}/${nome} fora do git`).toBe(true);
    expect(
      rastreado(`${ESPELHO}/${nome}/SKILL.md`),
      `${ESPELHO}/${nome} fora do git — o .gitignore libera .claude/skills por allowlist; acrescente o padrão`,
    ).toBe(true);
  });
});

describe("skills embutidas — as portas de acionamento conhecem todas as skills", () => {
  // O acionamento automático depende de a descrição estar no contexto (os cinco
  // CLIs fazem isso) E de a doutrina que cada CLI lê apontar para a skill certa:
  // AGENTS.md (Codex, OpenCode, Cursor), CLAUDE.md (Claude Code), a rule
  // sempre-ativa do Cursor e a do Antigravity. Uma skill nova que entre só na
  // pasta fica invisível para quem não sabe que ela existe — que é o leigo.
  const PORTAS = ["AGENTS.md", "CLAUDE.md", ".cursor/rules/deskcomm-guias.mdc", ".agents/rules/deskcomm-guias.md"];
  const guias = SKILLS.filter((n) => n.startsWith("deskcomm-"));

  it.each(PORTAS)("%s cita cada guia deskcomm-*", (porta) => {
    const texto = readFileSync(join(RAIZ, porta), "utf8");
    const ausentes = guias.filter((n) => !texto.includes(n));
    expect(ausentes, `${porta} não menciona: ${ausentes.join(", ")}`).toEqual([]);
  });

  it("a regra do Cursor e a do Antigravity têm o mesmo corpo (só o cabeçalho muda)", () => {
    const corpo = (p: string) => readFileSync(join(RAIZ, p), "utf8").split("\n---\n").slice(1).join("\n---\n").trim();
    expect(corpo(".cursor/rules/deskcomm-guias.mdc")).toBe(corpo(".agents/rules/deskcomm-guias.md"));
  });

  it.each([".claude/settings.json", ".codex/hooks.json"])("%s é JSON válido e aponta para o hook de sessão", (arquivo) => {
    const json = JSON.parse(readFileSync(join(RAIZ, arquivo), "utf8")) as { hooks?: { SessionStart?: unknown[] } };
    expect(json.hooks?.SessionStart?.length ?? 0).toBeGreaterThan(0);
    expect(JSON.stringify(json)).toContain("deskcomm-contribuir/scripts/hooks/sessao.sh");
  });
});

describe("skills embutidas — fora da imagem Docker", () => {
  it(".dockerignore exclui as pastas de harness", () => {
    const linhas = readFileSync(join(RAIZ, ".dockerignore"), "utf8")
      .split("\n")
      .map((l) => l.trim());
    for (const pasta of [".claude", ".agents", ".codex", ".cursor", ".opencode"]) {
      expect(linhas, `${pasta} entra no contexto de build`).toContain(pasta);
    }
  });
});
