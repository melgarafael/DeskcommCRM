/**
 * As skills embutidas têm UMA fonte e um espelho.
 *
 * Fonte: `.agents/skills/<nome>/` — a pasta do padrão aberto "Agent Skills",
 * que Codex, Cursor, OpenCode e Antigravity leem sozinhos (medido nas docs
 * oficiais e nos binários em 2026-09-10). Espelho: `.claude/skills/<nome>/` —
 * o Claude Code só lê aqui e não lê `.agents/`.
 *
 * ## Por que cópia vigiada, e não link simbólico nem duas cópias à mão
 *
 * Duas cópias à mão já divergiram neste repo por 35 dias: a de Claude foi
 * reescrita em 2026-08-04 (#123) e a de Codex continuou sendo a gerada
 * automaticamente em julho — que ensinava `snake_case` e imports relativos,
 * o contrário da base — com invocação implícita ligada. Nenhum teste comparava.
 *
 * Link simbólico resolveria a divergência e criaria outra: o git só reproduz
 * o link onde `core.symlinks` está ligado, e no Windows (o instalador padrão
 * desliga) o link vira um ARQUIVO de texto com o caminho dentro — a skill some
 * do Claude Code em silêncio, sem erro. Cópia é o único formato que chega
 * igual em todo clone; o preço é precisar de um gate, e ele existe em
 * `tests/unit/skills-embutidas.test.ts`.
 *
 * `agents/openai.yaml` fica só na fonte: é metadado de interface do Codex
 * (nome de exibição, prompt sugerido); no espelho seria ruído.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative, sep } from "node:path";

export const FONTE = ".agents/skills";
export const ESPELHO = ".claude/skills";
/** Nomes de PRIMEIRO nível da skill que não viajam para o espelho. */
export const SO_NA_FONTE: readonly string[] = ["agents"];

/** As skills da fonte: todo diretório de `.agents/skills` que tem `SKILL.md`. */
export function listarSkills(raiz: string): string[] {
  const dir = join(raiz, FONTE);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => existsSync(join(dir, n, "SKILL.md")))
    .sort();
}

/**
 * Todos os arquivos de um diretório, como caminhos relativos com `/`,
 * ordenados — ignorando os nomes de primeiro nível em `ignorar`.
 */
export function arquivosDe(dir: string, ignorar: readonly string[] = []): string[] {
  const saida: string[] = [];
  const andar = (atual: string) => {
    for (const nome of readdirSync(atual).sort()) {
      const caminho = join(atual, nome);
      const rel = relative(dir, caminho).split(sep).join("/");
      if (!rel.includes("/") && ignorar.includes(rel)) continue;
      if (statSync(caminho).isDirectory()) andar(caminho);
      else saida.push(rel);
    }
  };
  if (existsSync(dir)) andar(dir);
  return saida;
}

/**
 * O que difere entre a fonte e o espelho de UMA skill. Vazio = espelho fiel.
 * Cada linha diz o arquivo e o motivo, para a mensagem do gate ser acionável.
 */
export function divergencias(raiz: string, nome: string): string[] {
  const fonte = join(raiz, FONTE, nome);
  const espelho = join(raiz, ESPELHO, nome);
  if (!existsSync(espelho)) return [`${ESPELHO}/${nome}: espelho ausente (rode pnpm skills:sync)`];

  const daFonte = arquivosDe(fonte, SO_NA_FONTE);
  const doEspelho = arquivosDe(espelho);
  const saida: string[] = [];

  for (const rel of daFonte) {
    const alvo = join(espelho, rel);
    if (!existsSync(alvo)) {
      saida.push(`${rel}: falta no espelho`);
      continue;
    }
    if (!readFileSync(join(fonte, rel)).equals(readFileSync(alvo))) {
      saida.push(`${rel}: conteúdo diferente entre fonte e espelho`);
    }
  }
  for (const rel of doEspelho) {
    if (!daFonte.includes(rel)) saida.push(`${rel}: sobra no espelho (não existe na fonte)`);
  }
  return saida;
}

/** Regrava o espelho de UMA skill a partir da fonte, apagando o que sobrou. */
export function espelhar(raiz: string, nome: string): void {
  const fonte = join(raiz, FONTE, nome);
  const espelho = join(raiz, ESPELHO, nome);
  const daFonte = arquivosDe(fonte, SO_NA_FONTE);

  for (const rel of arquivosDe(espelho)) {
    if (!daFonte.includes(rel)) rmSync(join(espelho, rel));
  }
  for (const rel of daFonte) {
    const alvo = join(espelho, rel);
    mkdirSync(join(alvo, ".."), { recursive: true });
    copyFileSync(join(fonte, rel), alvo);
  }
}

/**
 * Diretórios RASTREADOS pelo git em `.claude/skills` que não têm fonte.
 *
 * Só os rastreados: `.claude/skills/` também abriga skills locais de outros
 * apps (o `.gitignore` explica), e essas não são órfãs — são de quem clonou.
 */
export function orfasNoEspelho(raiz: string): string[] {
  const rastreados = execFileSync("git", ["ls-files", ESPELHO], { cwd: raiz, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((f) => f.split("/")[2])
    .filter((n): n is string => Boolean(n));
  const fonte = new Set(listarSkills(raiz));
  return [...new Set(rastreados)].filter((n) => !fonte.has(n)).sort();
}
