/**
 * `pnpm skills:sync` — regrava `.claude/skills/<nome>/` a partir de
 * `.agents/skills/<nome>/`, para cada skill embutida.
 *
 * Edite SEMPRE a fonte (`.agents/skills`). O porquê da cópia — e por que não
 * é link simbólico — está em `scripts/skills-embutidas/espelho.ts`. O gate que
 * reprova espelho desatualizado é `tests/unit/skills-embutidas.test.ts`; este
 * script é o conserto que a mensagem dele manda rodar.
 *
 *   pnpm skills:sync            # regrava os espelhos
 *   pnpm skills:sync --check    # só lista divergências; exit 1 se houver
 */
import { divergencias, espelhar, listarSkills, orfasNoEspelho } from "./skills-embutidas/espelho";

const raiz = process.cwd();
const soConferir = process.argv.includes("--check");
const skills = listarSkills(raiz);

if (skills.length === 0) {
  console.error("nenhuma skill encontrada em .agents/skills — rodou na raiz do repositório?");
  process.exit(2);
}

let problemas = 0;
for (const nome of skills) {
  const antes = divergencias(raiz, nome);
  if (antes.length === 0) {
    console.info(`= ${nome}: espelho fiel`);
    continue;
  }
  if (soConferir) {
    problemas += antes.length;
    console.info(`≠ ${nome}:\n   ${antes.join("\n   ")}`);
    continue;
  }
  espelhar(raiz, nome);
  console.info(`✎ ${nome}: espelho regravado (${antes.length} diferença(s))`);
}

const orfas = orfasNoEspelho(raiz);
if (orfas.length > 0) {
  problemas += orfas.length;
  console.info(
    `! rastreadas em .claude/skills sem fonte em .agents/skills: ${orfas.join(", ")}\n` +
      `  (apague com git rm -r, ou crie a fonte — a fonte é .agents/skills)`,
  );
}

process.exit(problemas > 0 ? 1 : 0);
