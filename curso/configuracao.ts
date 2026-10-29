/** Metadados e saída do curso; não importa o dicionário da interface. */
import { execFileSync } from "node:child_process";
import path from "node:path";
const raiz = path.dirname(new URL(import.meta.url).pathname);
export type IdiomaDaCaptura = "pt-BR" | "es";

export function idiomaDaCaptura(): IdiomaDaCaptura {
  const idioma = process.env.CURSO_IDIOMA ?? "pt-BR";
  if (idioma !== "pt-BR" && idioma !== "es")
    throw new Error(
      "CURSO_IDIOMA precisa ser pt-BR ou es; a interface inglesa ainda não é servida pelo produto.",
    );
  return idioma;
}

export function pastaDaSaida(): string {
  return process.env.CURSO_SAIDA
    ? path.resolve(process.env.CURSO_SAIDA)
    : path.join(raiz, "saida", ...(idiomaDaCaptura() === "es" ? ["es"] : []));
}

export function commitDaFoto(): string {
  const commit =
    process.env.CURSO_COMMIT_FOTOS ??
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: raiz, encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit))
    throw new Error("CURSO_COMMIT_FOTOS precisa identificar o commit completo do app fotografado.");
  return commit;
}
