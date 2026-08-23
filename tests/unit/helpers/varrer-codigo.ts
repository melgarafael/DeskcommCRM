/**
 * Varredura de código-fonte para testes de invariante.
 *
 * Vários testes deste repo checam "o que o código faz" contra "o que uma lista
 * declara" (evento com consumidor, tela com porta, ponto de IA no registro). A
 * varredura em si é a mesma nos três, e é onde mora a armadilha: uma varredura
 * quebrada devolve zero arquivos, e zero é indistinguível de "está tudo em
 * ordem" — o teste passa verde sem ter olhado nada.
 *
 * Por isso ela vive aqui, num lugar só, e todo teste que a usa deve ter um
 * controle positivo (afirmar que ela ENCONTROU algo conhecido) antes de tirar
 * conclusão de uma ausência.
 */
import { readdirSync } from "node:fs";
import path from "node:path";

/** Raiz do repo — o vitest roda com cwd na raiz (ver vitest.config.ts). */
export const RAIZ_DO_REPO = process.cwd();

const IGNORADOS = new Set(["node_modules", ".next", "dist", "coverage", ".git"]);

function varrer(dir: string): string[] {
  let entradas;
  try {
    entradas = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // diretório inexistente — o chamador prova a não-vacuidade
  }
  return entradas.flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return IGNORADOS.has(e.name) ? [] : varrer(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/**
 * Arquivos `.ts`/`.tsx` de PRODUÇÃO (sem `.test.`) sob as raízes pedidas,
 * em caminho absoluto.
 */
export function arquivosDeCodigo(raizes: readonly string[]): string[] {
  return raizes.flatMap((r) => varrer(path.join(RAIZ_DO_REPO, r)));
}

/**
 * Caminho relativo à raiz do repo, SEMPRE com `/`.
 *
 * `path.relative` devolve `lib\ai\log-invocation.ts` num checkout Windows, e toda
 * allowlist deste repo é escrita com `/`. Comparar os dois não dá erro: dá o
 * silêncio errado. Medido em 2026-08-22, com a varredura crua:
 *
 * - `telemetria-tem-um-leitor-so`: o controle positivo falha, a allowlist inteira
 *   parece morta e um arquivo PERMITIDO vira infrator — vermelho sem defeito.
 * - `provedores-x-registry`: o mesmo desencontro deixa a allowlist INERTE, e o
 *   teste segue verde só porque nenhum arquivo isento casa o padrão hoje. É o
 *   modo pior: o gate perde a isenção sem avisar ninguém.
 *
 * Quem compara caminho com literal escrito à mão usa esta função, nunca
 * `path.relative` cru.
 */
export function caminhoRelativo(absoluto: string): string {
  return path.relative(RAIZ_DO_REPO, absoluto).split(path.sep).join("/");
}
