import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * TODA RELEASE APARECE NA PÁGINA DE CHANGELOG DA LP — E O CI CONFERE.
 *
 * ## A regra
 *
 * `docs/doctrine/versionamento.md`, seção "A vitrine". A LP (repositório
 * `deskcomm-site`) tem uma página de changelog em pt-BR, en e es que lê o
 * `CHANGELOG.md` da `main`. Ninguém escreve release no site: a versão chega lá
 * sozinha, e o último passo do job `cortar-tag` confere que chegou.
 *
 * ## Por que um teste de FORMA
 *
 * O comportamento só existe num corte de release real, e quem o prova é o próprio
 * passo, que falha alto quando a LP não lista a versão. Aqui se guarda o que torna
 * aquele passo verdadeiro — ele existir, rodar DEPOIS das imagens, só no corte e
 * só no repositório oficial, e reprovar em vez de avisar — e o contrato que a LP
 * lê: o formato do cabeçalho de cada seção do CHANGELOG.
 *
 * A exceção é o diagnóstico do ramo de erro, que é EXECUTADO com um curl falso:
 * o que ele promete — dizer se cada página que faltou respondeu 404 ou 200 — é
 * uma saída, e forma nenhuma do YAML a prova.
 *
 * O contrato mora nos dois lados de propósito. O leitor da LP
 * (`deskcomm-site/lib/changelog.ts`) usa esta mesma expressão; se alguém mudar o
 * cabeçalho do CHANGELOG aqui, este teste reprova ANTES de a LP perder a versão
 * em silêncio.
 */
const RAIZ = process.cwd();
const release = readFileSync(join(RAIZ, ".github/workflows/release.yml"), "utf8");
const doutrina = readFileSync(join(RAIZ, "docs/doctrine/versionamento.md"), "utf8");
const changelog = readFileSync(join(RAIZ, "CHANGELOG.md"), "utf8");

const PASSO_IMAGENS = "- name: As três imagens existem nesta versão?";
const PASSO_LP = "- name: A versão aparece na página de changelog da LP?";

/** O bloco de um passo, do `- name:` até o próximo passo ou o fim do job. */
function passo(nome: string): string {
  const i = release.indexOf(nome);
  if (i === -1) return "";
  const resto = release.slice(i + nome.length);
  const fim = resto.search(/\n {6}- (name|uses):/);
  return nome + (fim === -1 ? resto : resto.slice(0, fim));
}

/**
 * Executa o `run:` do passo da LP contra respostas escolhidas, sem rede e sem espera.
 *
 * O bash é o do arquivo que o CI usa, como em `guarda-da-release-reconhece-o-corte.test.ts`. À frente
 * dele vão `curl` e `sleep` como FUNÇÕES, que o bash procura antes do PATH — e não como executáveis
 * falsos: um cenário que reprova chama o curl 105 vezes (35 tentativas × 3 páginas). Medido no macOS,
 * sozinho, o caso levou de 3,4 a 6,3 s com um processo por chamada e ~0,2 s com funções, contra um
 * `testTimeout` de 15 s que vale para a suíte inteira rodando em paralelo.
 *
 * Cada resposta é o status e o HTML de um caminho; caminho sem resposta responde 404, e o status
 * `000` imita o site fora do ar (o curl sai com 7). O `LP` é uma porta local fechada: se uma mudança
 * no passo contornar a função, o curl de verdade é recusado na hora em vez de sair para a rede.
 */
function rodarPassoLp(respostas: Record<string, { status: string; html?: string }>) {
  const bloco = passo(PASSO_LP);
  const iRun = bloco.indexOf("run: |");
  expect(iRun, "o passo da LP não tem bloco run").toBeGreaterThan(-1);
  const corpo: string[] = [];
  for (const l of bloco.slice(iRun + "run: |".length).split("\n").slice(1)) {
    if (l.trim() !== "" && !l.startsWith("          ")) break;
    corpo.push(l.slice(10));
  }
  const falsos = [
    "curl() {",
    '  local url="" corpo="-" formato="" falha_http="" status=404 html=""',
    "  while [ $# -gt 0 ]; do",
    '    case "$1" in',
    '      -o) corpo="$2"; shift ;;',
    '      -w) formato="$2"; shift ;;',
    "      --max-time) shift ;;",
    "      -*f*) falha_http=1 ;;",
    "      -*) ;;",
    '      *) url="$1" ;;',
    "    esac",
    "    shift",
    "  done",
    '  local pasta="$CENARIO${url#"$LP"}"',
    '  if [ -f "$pasta/status" ]; then read -r status < "$pasta/status"; fi',
    '  if [ "$status" = 000 ]; then if [ -n "$formato" ]; then printf 000; fi; return 7; fi',
    '  if [ -n "$falha_http" ] && [ "$status" -ge 400 ]; then return 22; fi',
    '  if [ "$corpo" = "-" ] && [ -f "$pasta/html" ]; then IFS= read -r html < "$pasta/html"; printf "%s\\n" "$html"; fi',
    '  if [ -n "$formato" ]; then printf "%s" "$status"; fi',
    "}",
    "sleep() { :; }",
  ].join("\n");

  const cenario = mkdtempSync(join(tmpdir(), "passo-lp-"));
  try {
    // O cenário espelha a URL em diretórios: `/en/changelog` → `<cenario>/en/changelog/{status,html}`.
    for (const [caminho, r] of Object.entries(respostas)) {
      const pasta = join(cenario, caminho);
      mkdirSync(pasta, { recursive: true });
      writeFileSync(join(pasta, "status"), `${r.status}\n`);
      if (r.html !== undefined) writeFileSync(join(pasta, "html"), `${r.html}\n`);
    }
    const env = { ...process.env, LP, VERSAO, CENARIO: cenario };
    try {
      const saida = execFileSync("bash", ["-c", `${falsos}\n${corpo.join("\n")}`], {
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { exit: 0, saida };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { exit: e.status ?? -1, saida: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  } finally {
    rmSync(cenario, { recursive: true, force: true });
  }
}

const LP = "http://127.0.0.1:9";
const VERSAO = "1.2.3";
const lista = (p: string, versao: string) => `<ul><li><a href="${p}/${versao}">v${versao}</a></li></ul>`;

/** A linha de erro que nomeia `url` (a página, não a da versão) junto com `codigo`. */
function nomeia(saida: string, url: string, codigo: string): boolean {
  return saida
    .split("\n")
    .some((l) => l.startsWith("::error::") && new RegExp(`${url.replaceAll(".", "\\.")}(\\s|$)`).test(l) && new RegExp(`\\b${codigo}\\b`).test(l));
}

describe("a release chega à página de changelog da LP", () => {
  it("o passo existe no job cortar-tag, depois da conferência das imagens", () => {
    const iJob = release.indexOf("\n  cortar-tag:");
    const iImagens = release.indexOf(PASSO_IMAGENS);
    const iLp = release.indexOf(PASSO_LP);
    expect(iJob, "o job cortar-tag sumiu").toBeGreaterThan(-1);
    expect(iLp, "o passo que confere a LP sumiu do release.yml").toBeGreaterThan(iJob);
    // Antes das imagens, a LP poderia listar uma versão que o parque ainda não consegue instalar.
    expect(iLp).toBeGreaterThan(iImagens);
  });

  it("roda só num corte de release, e só no repositório oficial", () => {
    const bloco = passo(PASSO_LP);
    const condicao = /\n\s+if: (.+)/.exec(bloco)?.[1] ?? "";
    expect(condicao).toContain("steps.pendente.outputs.cortar == 'sim'");
    expect(condicao).toContain("github.repository == 'melgarafael/DeskcommCRM'");
    // `always()` rodaria depois de uma falha nas imagens e mascararia a causa.
    expect(condicao).not.toContain("always()");
  });

  it("confere os três idiomas e reprova — não só avisa", () => {
    const bloco = passo(PASSO_LP);
    for (const p of ["/changelog", "/en/changelog", "/es/changelog"]) expect(bloco).toContain(p);
    expect(bloco).toContain("https://www.deskcomm.com.br");
    // Todo ramo que anuncia erro precisa sair com 1. Contar "existe um exit 1" não basta: o passo
    // tem dois ramos de erro (a lista e a página da versão), e a sabotagem que tirou só o
    // primeiro passou verde com essa régua.
    const ramos = [...bloco.matchAll(/\n(\s+)if \[[^\n]*\]; then\n([\s\S]*?)\n\1fi\b/g)].map((m) => m[2] ?? "");
    const ramosDeErro = ramos.filter((r) => r.includes("::error::"));
    expect(ramosDeErro.length, "o passo deixou de ter os dois ramos de erro").toBe(2);
    for (const r of ramosDeErro) expect(r, "ramo de erro que não reprova o job").toMatch(/\n\s+exit 1(\n|$)/);
    expect(bloco).not.toContain("continue-on-error");
    // A sonda procura o LINK da versão: o número solto casa "1.2.1" dentro de "1.2.10".
    expect(bloco).toContain('href=\\"${p}/${VERSAO}\\"');
    // E procura sem pipeline. Sob `pipefail`, `printf "$html" | grep -q` dá a versão como faltando
    // quando o HTML tem quebra de linha depois do link: o grep sai no primeiro casamento e o printf
    // morre de SIGPIPE (141).
    //
    // O `changelog.html` que o site gera hoje vem em UMA linha só e NÃO dispara isso — a medição
    // INJETOU uma quebra logo depois do link para alcançar o defeito. Ela vale mesmo assim porque
    // o formato do HTML é do gerador, não do contrato: ele ganha quebra sem avisar ninguém daqui.
    // Medido contra as TRÊS páginas do build do `deskcomm-site`
    // (`.next/server/app/{,en/,es/}changelog.html`), cada uma com `wc -l` = 0 — o tamanho em bytes
    // muda a cada release e por isso não está escrito aqui; a propriedade que importa é a ausência
    // de quebra, e ela se confere com `wc -l`. 20 rodadas de cada forma, nos três idiomas, em bash
    // 5.2.21/grep 3.11 (ubuntu:24.04) e em bash 5.3.9/BSD grep 2.6.0 (macOS), com o mesmo placar:
    //
    //   arquivo real          pipeline 20/20 listada · [[ ]] 20/20 · grep <<< 20/20
    //   uma quebra injetada   pipeline  0/20 listada · [[ ]] 20/20 · grep <<< 20/20
    const sonda = bloco.split("\n").filter((l) => l.includes('href=\\"${p}/${VERSAO}\\"'));
    expect(sonda, "a sonda do link deixou de ser uma linha só").toHaveLength(1);
    // Duas formas alimentam o grep sem pipeline, e o teste aceita as DUAS: a comparação de padrão
    // do bash e a here-string. Prender uma só faria a outra — que a medição acima mostra igualmente
    // imune — reprovar sem defeito, e vermelho que não aponta defeito ensina a contornar o guarda.
    // O que segue proibido é PIPELINE, e é a asserção logo abaixo que o cobra.
    //
    // Por isso a lista é de PADRÃO e não de string literal: o espaço depois do `<<<` é opcional em
    // bash, as duas grafias são o mesmo redirecionamento, e a que este repositório já usa é a SEM
    // espaço (`grep -c '<<<"' triagem/scripts/complemento.sh` = 4, com espaço = 0; e
    // `triagem/TRIAGEM.md`, achado 61, prescreve literalmente `grep ... <<<"$DIFF"`). Cobrar
    // igualdade de texto reprovava exatamente a grafia da casa.
    const SONDAS_SEM_PIPELINE = [
      /^if \[\[ "\$html" == \*"href=\\"\$\{p\}\/\$\{VERSAO\}\\""\* \]\]; then$/,
      /^if grep -qF "href=\\"\$\{p\}\/\$\{VERSAO\}\\"" <<< ?"\$html"; then$/,
    ];
    expect(
      SONDAS_SEM_PIPELINE.some((forma) => forma.test(sonda[0]?.trim() ?? "")),
      `a sonda virou uma forma que este teste não reconhece como segura:\n  ${sonda[0]?.trim()}`,
    ).toBe(true);
    const codigo = bloco
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    expect(codigo, "a sonda voltou a passar o HTML por pipeline").not.toMatch(/(^|[^|])\|\s*grep\b/m);
  });

  it("quando a LP não lista a versão, o erro nomeia o status de cada página que faltou", () => {
    // O `|| true` da sonda faz um 404 virar HTML vazio, e HTML vazio reprova igual a uma página no
    // ar que não lista a versão. São desfechos opostos — 404 é a vitrine fora do ar, e nenhuma
    // espera conserta; 200 é a versão que não chegou ao CHANGELOG que a LP lê — e só o status os
    // separa. Por isso o passo é EXECUTADO: uma regex sobre o YAML aceitaria um laço que imprime
    // o status da página errada.

    // Controle: com a versão nas três páginas o passo sai 0. Sem isto, um curl falso quebrado
    // reprovaria os casos abaixo pelo motivo errado.
    const presente = rodarPassoLp({
      "/changelog": { status: "200", html: lista("/changelog", VERSAO) },
      "/en/changelog": { status: "200", html: lista("/en/changelog", VERSAO) },
      "/es/changelog": { status: "200", html: lista("/es/changelog", VERSAO) },
      [`/changelog/${VERSAO}`]: { status: "200" },
      [`/en/changelog/${VERSAO}`]: { status: "200" },
      [`/es/changelog/${VERSAO}`]: { status: "200" },
    });
    expect(presente.exit, `com a versão listada o passo devia sair 0:\n${presente.saida}`).toBe(0);

    // pt-BR lista; en não existe; es existe e ainda não lista.
    const misto = rodarPassoLp({
      "/changelog": { status: "200", html: lista("/changelog", VERSAO) },
      "/es/changelog": { status: "200", html: lista("/es/changelog", "1.2.2") },
    });
    expect(misto.exit, misto.saida).toBe(1);
    expect(nomeia(misto.saida, `${LP}/en/changelog`, "404"), `o erro não nomeia o 404 de /en/changelog:\n${misto.saida}`).toBe(true);
    expect(nomeia(misto.saida, `${LP}/es/changelog`, "200"), `o erro não nomeia o 200 de /es/changelog:\n${misto.saida}`).toBe(true);
    // A página que listou não faltou, e não entra no diagnóstico.
    expect(nomeia(misto.saida, `${LP}/changelog`, "200"), `o erro nomeia uma página que não faltou:\n${misto.saida}`).toBe(false);

    // Site fora do ar: o curl do diagnóstico sai com 7, e mesmo assim cada página é nomeada e o
    // passo reprova com 1 — não morre no `set -e` antes de dizer por quê.
    const foraDoAr = rodarPassoLp({
      "/changelog": { status: "000" },
      "/en/changelog": { status: "000" },
      "/es/changelog": { status: "000" },
    });
    expect(foraDoAr.exit, foraDoAr.saida).toBe(1);
    for (const p of ["/changelog", "/en/changelog", "/es/changelog"]) {
      expect(nomeia(foraDoAr.saida, `${LP}${p}`, "000"), `o erro não nomeia o 000 de ${p}:\n${foraDoAr.saida}`).toBe(true);
    }
  });

  it("a doutrina de versionamento declara a vitrine", () => {
    expect(doutrina).toMatch(/^## A vitrine/m);
    expect(doutrina).toContain("deskcomm.com.br/changelog");
    expect(doutrina).toContain("A versão aparece na página de changelog da LP?");
  });

  it("toda seção do CHANGELOG segue o cabeçalho que a LP sabe ler", () => {
    // A mesma expressão de deskcomm-site/lib/changelog.ts (CABECALHO_VERSAO).
    const CABECALHO_VERSAO = /^## \[(\d+\.\d+\.\d+)\]\s*[—–-]\s*(\d{4}-\d{2}-\d{2})\s*$/;
    const cabecalhos = changelog.split("\n").filter((l) => l.startsWith("## "));
    const fora = cabecalhos.filter((l) => !CABECALHO_VERSAO.test(l) && l.trim() !== "## [Não lançado]");
    expect(fora, "seção que a página de changelog da LP não reconheceria").toEqual([]);
    expect(cabecalhos.filter((l) => CABECALHO_VERSAO.test(l)).length).toBeGreaterThan(0);
  });
});
