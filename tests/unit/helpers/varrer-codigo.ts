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

import { relativoEmBarraNormal } from "./caminho";

/** Raiz do repo — o vitest roda com cwd na raiz (ver vitest.config.ts). */
export const RAIZ_DO_REPO = process.cwd();

const IGNORADOS = new Set(["node_modules", ".next", "dist", "coverage", ".git"]);

function varrer(dir: string, extensoes: RegExp): string[] {
  let entradas;
  try {
    entradas = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // diretório inexistente — o chamador prova a não-vacuidade
  }
  return entradas.flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return IGNORADOS.has(e.name) ? [] : varrer(p, extensoes);
    if (!extensoes.test(e.name)) return [];
    return /\.test\./.test(e.name) ? [] : [p];
  });
}

/**
 * Arquivos de PRODUÇÃO (sem `.test.`) sob as raízes pedidas, em caminho
 * absoluto.
 *
 * `extensoes` existe porque nem toda catraca olha só TypeScript: a do host da
 * Graph (`graph-host-configuravel.test.ts`) precisa alcançar os `.mjs` de
 * `scripts/`, que é onde um endereço de fornecedor já se escondeu. O padrão é o
 * de sempre, então nenhum chamador antigo muda de comportamento.
 */
export function arquivosDeCodigo(
  raizes: readonly string[],
  extensoes: RegExp = /\.tsx?$/,
): string[] {
  return raizes.flatMap((r) => varrer(path.join(RAIZ_DO_REPO, r), extensoes));
}

/**
 * O caminho de um arquivo varrido, relativo à raiz e em barra normal.
 *
 * A varredura devolve ABSOLUTO e os três chamadores precisam dele relativo
 * para comparar com uma lista declarada — os três faziam o mesmo `relative`
 * à mão, e no Windows os três erravam junto.
 */
export function caminhoRelativo(absoluto: string): string {
  return relativoEmBarraNormal(RAIZ_DO_REPO, absoluto);
}
