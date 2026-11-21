/**
 * A ESTEIRA NÃO PUBLICA IMAGEM CUJO SERVIDOR E ESTÁTICOS VÊM DE BUILDS DIFERENTES.
 *
 * A 1.118.0 saiu do `build-and-push` com `.next/BUILD_ID` `L0Ae8OxIf-v2KzwJoCU0E`
 * e `.next/static/` de `K2qYwFMofIRXoOdBpIUbx` — o HTML pedia chunks que não
 * existiam na imagem, e `/login`, `/app/inbox` e Funis morriam com ChunkLoadError.
 * O container subia normal e o `/health` respondia: nada que o pipeline olhava
 * enxergava o defeito.
 *
 * Duas coisas tinham de existir juntas, e é isso que esta cerca trava:
 *
 *   1. DIAGNÓSTICO — o passo que mede os dois ids na imagem construída. Sem ele,
 *      a próxima montagem trocada viaja em silêncio de novo.
 *   2. ESTRUTURA — `.next/static` dentro do MESMO diretório copiado do build.
 *      Enquanto servidor e estáticos forem dois `COPY --from=build` distintos, o
 *      BuildKit pode servir um do cache e o outro do build novo (foi o que
 *      aconteceu: `blob … not found` no restore, `pnpm build` reexecutado por
 *      262,7 s, um `COPY` em 6,3 s e o outro em 1,7 s). Aí o passo de cima só
 *      reprova — não impede.
 *
 * A cerca compara o REPO, não uma cópia de referência: quem voltar a separar o
 * `COPY` do static, ou apagar o passo, é reprovado no PR em que faz isso.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const WORKFLOW = ".github/workflows/publish-image.yml";
const DOCKERFILE = "Dockerfile";
const yml = readFileSync(WORKFLOW, "utf8");
const dockerfile = readFileSync(DOCKERFILE, "utf8");

/** O trecho de um job, do cabeçalho até o próximo job (`recorte` por LINHA). */
function recorteDoJob(texto: string, nome: string): string {
  const linhas = texto.split("\n");
  const iJobs = linhas.findIndex((l) => /^jobs:\s*$/.test(l));
  const i = linhas.findIndex((l, n) => n > iJobs && l === `  ${nome}:`);
  if (iJobs === -1 || i === -1) return "";
  const fim = linhas.findIndex((l, n) => n > i && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l));
  return linhas.slice(i, fim === -1 ? linhas.length : fim).join("\n");
}

describe("o BUILD_ID do servidor é conferido contra o de .next/static (#4967)", () => {
  it("o script da verificação existe e é executável", () => {
    const script = readFileSync("scripts/verifica-build-id.sh", "utf8");
    // rc 1 é o veredito de divergência; se o script terminasse 0 em tudo, o passo
    // do pipeline seria decorativo.
    expect(script).toMatch(/exit 1/);
    expect(script).toMatch(/exit 2/);
  });

  it("o job que constrói o app em PR roda a verificação ANTES do boot", () => {
    const job = recorteDoJob(yml, "imagem-do-app-sobe");
    expect(job, "job imagem-do-app-sobe sumiu").not.toBe("");

    const iVerifica = job.indexOf("scripts/verifica-build-id.sh");
    const iBoot = job.indexOf("O container chega a servir?");
    expect(iVerifica, "imagem-do-app-sobe não chama scripts/verifica-build-id.sh").toBeGreaterThan(-1);
    expect(iBoot, "o passo de boot sumiu — a cerca perdeu a referência").toBeGreaterThan(-1);
    // Antes do boot: a imagem da #4967 sobe perfeitamente, então medir depois não
    // mediria o defeito.
    expect(iVerifica).toBeLessThan(iBoot);
  });

  it("o job que PUBLICA mede o digest que acabou de empurrar", () => {
    const job = recorteDoJob(yml, "build-and-push");
    expect(job, "job build-and-push sumiu").not.toBe("");

    expect(job).toContain("scripts/verifica-build-id.sh");
    // Pelo digest, não por tag: tag pode ter sido movida por outro run entre o
    // push e a leitura, e aí a sonda mediria outra imagem.
    expect(job).toMatch(/steps\.build\.outputs\.digest/);
    // Só o app tem `next build`.
    expect(job).toMatch(/matrix\.name == 'deskcommcrm'/);
  });

  it("os dois passos preservam o teto de heap do repo", () => {
    for (const nome of ["imagem-do-app-sobe", "build-and-push"]) {
      const job = recorteDoJob(yml, nome);
      const trecho = job.slice(Math.max(0, job.indexOf("verifica-build-id.sh") - 600));
      expect(trecho, `${nome} perdeu o teto de heap no passo novo`).toContain(
        "--max-old-space-size=6144",
      );
    }
  });

  it("`.next/static` sai do MESMO COPY do standalone (a mistura deixa de ser representável)", () => {
    // O invariante estrutural: um único `COPY --from=build` do standalone carrega
    // servidor E estáticos. Um `COPY` separado de `/app/.next/static` reintroduz
    // exatamente a montagem de dois builds da 1.118.0.
    const copiasDoStatic = dockerfile
      .split("\n")
      .filter((l) => /^COPY --from=build .*\/app\/\.next\/static/.test(l.trim()));
    expect(copiasDoStatic, `o Dockerfile voltou a copiar .next/static à parte:\n${copiasDoStatic.join("\n")}`).toEqual([]);

    // E o static entra no standalone dentro do estágio de build, senão a imagem
    // sai sem CSS/JS (o 404 do "app sem estilo").
    expect(dockerfile).toMatch(/cp -a \.next\/static \.next\/standalone\/\.next\/static/);
  });
});
