import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A ÂNCORA do namespace das imagens publicadas.
 *
 * ── Por que este arquivo existe ────────────────────────────────────────────
 *
 * `tests/shell/update-guard.test.sh` e `hostgator-setup-kit/test-validators.sh`
 * repetiam `ghcr.io/melgarafael` à mão em 31 lugares — fixtures E asserções.
 * Isso amarrava a suíte a UM publicador: um fork que publica as próprias
 * imagens ficava vermelho em 4 casos sem ter quebrado nada, com a mensagem de
 * falha apontando para o valor "certo" do upstream. Derivar tudo de `IMG_NS`
 * conserta isso — e é o que o PR #397 (@Clalber) fez.
 *
 * Só que aquele literal repetido era, sem ninguém ter decidido isso, a ÚNICA
 * canária do repo contra um `IMG_NS` errado. Medido nas duas direções, com a
 * mesma sabotagem (`IMG_NS="ghcr.io/erradissimo"`):
 *
 *   main  → `bash tests/shell/update-guard.test.sh` sai 1, com 4 ✗
 *   #397  → sai 0. Todo o `pnpm test:shell` fica VERDE
 *
 * Derivando em todo lugar, os testes passam a CONCORDAR ENTRE SI sobre o valor
 * errado — a família do teste que mede a si mesmo. A resposta não é desfazer a
 * elegância: é derivar em todos os lugares e ter UM ponto, um só, que assere o
 * valor literal. Este arquivo é esse ponto.
 *
 * ── O que uma âncora precisa ter para valer ────────────────────────────────
 *
 * Asserir o literal contra ele mesmo seria decorativo. Os casos daqui cruzam
 * `IMG_NS` com as OUTRAS declarações independentes do mesmo namespace — o
 * default do compose que o cliente roda, o `.env` de exemplo que ele copia e o
 * workflow que de fato publica —, e a catraca no fim impede que a repetição
 * volte a se espalhar. Sabotado nas quatro direções, com a previsão anotada
 * antes de cada rodada:
 *
 *   IMG_NS trocado só no kit          → 7 ✗  (a âncora + as 6 travessias)
 *   IMG_NS trocado de forma COERENTE  → 1 ✗  (só a âncora — o desenho todo)
 *   uma imagem renomeada só no kit    → 3 ✗  (compose, .env e a matriz do CI)
 *   literal de volta num teste        → 1 ✗  (só a catraca)
 *
 * Roda em `verify` (check obrigatório), sem shell, sem docker.
 */

const RAIZ = process.cwd();

const COMUM = fs.readFileSync(path.join(RAIZ, "hostgator-setup-kit/_common.sh"), "utf8");
const COMPOSE = fs.readFileSync(path.join(RAIZ, "docker-compose.prod.yml"), "utf8");
const PUBLICA = fs.readFileSync(path.join(RAIZ, ".github/workflows/publish-image.yml"), "utf8");
const ENV_EXEMPLO = fs.readFileSync(path.join(RAIZ, ".env.hostgator.example"), "utf8");

/** O valor literal que este repositório publica. A âncora. */
const NAMESPACE_DESTE_REPO = "ghcr.io/founders-br";

/**
 * Um fork que publica as próprias imagens muda `IMG_NS` — e precisa mudar junto
 * os outros dois arquivos que não têm de onde derivar. Esta frase é a que ele lê
 * quando a âncora fica vermelha, para não procurar defeito onde não há: ela diz
 * o que fazer, não que ele errou.
 */
const RECADO_AO_FORK =
  "Publicando as próprias imagens? Troque o namespace em três lugares, e só neles: " +
  "IMG_NS em hostgator-setup-kit/_common.sh, o default das três linhas `image:` de " +
  "docker-compose.prod.yml, e as três *_IMAGE de .env.hostgator.example. Depois " +
  "atualize NAMESPACE_DESTE_REPO neste arquivo. Nenhum OUTRO arquivo do repo " +
  "repete esse valor — todos derivam de IMG_NS, e a catraca no fim deste arquivo " +
  "existe para que continue assim.";

function imgNs(): string {
  const m = COMUM.match(/^IMG_NS="([^"]+)"$/m);
  // O grupo é obrigatório no padrão, mas `noUncheckedIndexedAccess` não sabe
  // disso — e a checagem explícita é melhor que um `!`: se um dia o padrão
  // ganhar um grupo opcional, a mensagem aqui diz o que aconteceu.
  if (!m?.[1]) throw new Error("não achei a linha IMG_NS= em hostgator-setup-kit/_common.sh");
  return m[1];
}

/** Os três repositórios de imagem, na ordem em que `_common.sh` os declara. */
function reposDoKit(): string[] {
  return ["IMG_APP", "IMG_WORKER", "IMG_SCHEDULER"].map((chave) => {
    const m = COMUM.match(new RegExp(`^${chave}="\\$\\{IMG_NS\\}/([^"]+)"$`, "m"));
    if (!m?.[1]) {
      throw new Error(
        `${chave} não é mais derivada de \${IMG_NS} em _common.sh. ` +
          "Se ela passou a repetir o namespace, a fonte única deixou de existir.",
      );
    }
    return m[1];
  });
}

describe("o namespace das imagens tem uma âncora, e uma só", () => {
  it("IMG_NS é o valor literal que este repositório publica", () => {
    expect(imgNs(), RECADO_AO_FORK).toBe(NAMESPACE_DESTE_REPO);
  });

  it("IMG_NS tem a forma <registry>/<dono> — a única que o GHCR publica", () => {
    // O workflow publica em `${REGISTRY}/${github.repository_owner}/${nome}`:
    // exatamente dois segmentos antes do nome da imagem. Um IMG_NS com três
    // (ou com um) monta uma referência que o registry nunca vai ter, e o
    // sintoma chega só no `docker compose pull` da VPS do cliente.
    expect(imgNs().split("/")).toHaveLength(2);
  });
});

describe("o default do compose diz o mesmo que o kit", () => {
  // Por que isto pega o que a âncora sozinha não pega: `docker-compose.prod.yml`
  // é a SEGUNDA declaração independente de onde as imagens moram, e a única que
  // vale quando `APP_IMAGE` não está no `.env`. YAML não deriva de shell, então
  // as duas só andam juntas se alguém as comparar — é este caso.
  // Os nomes vêm de `reposDoKit()`, não de literais aqui: assim o compose e o
  // `.env` de exemplo são conferidos contra IMG_APP/IMG_WORKER/IMG_SCHEDULER, e
  // renomear uma imagem só no `_common.sh` fica vermelho. Com os nomes fixos
  // neste arquivo, essa renomeação passaria — o teste concordaria com o compose
  // sobre um nome que o kit já não usa.
  //
  // A leitura acontece DENTRO de cada `it`, não no corpo do describe: lá, um
  // `_common.sh` fora de forma derrubava a coleta do arquivo inteiro, e o que
  // chegava ao resumo era "no tests" em vez do caso que reprovou.
  const CHAVES = ["APP_IMAGE", "WORKER_IMAGE", "SCHEDULER_IMAGE"] as const;

  CHAVES.forEach((chave, i) => {
    it(`o default de ${chave} usa o namespace de IMG_NS`, () => {
      const m = COMPOSE.match(new RegExp(`^\\s*image: \\$\\{${chave}:-([^}]+)\\}`, "m"));
      expect(m, `não achei a linha \`image: \${${chave}:-…}\` em docker-compose.prod.yml`)
        .not.toBeNull();
      expect(m![1]).toBe(`${imgNs()}/${reposDoKit()[i]}:stable`);
    });

    // `.env.hostgator.example` é DADO — um template que o operador copia. Não há
    // de onde derivar dentro de um arquivo de env, então ele é a última cópia
    // autorizada do literal, e existe este caso para que ela seja uma cópia
    // CONFERIDA em vez de uma afirmação solta.
    it(`o piso de ${chave} no .env de exemplo usa o namespace de IMG_NS`, () => {
      const m = ENV_EXEMPLO.match(new RegExp(`^${chave}=(\\S+)`, "m"));
      expect(m, `não achei \`${chave}=\` em .env.hostgator.example`).not.toBeNull();
      expect(m![1]).toBe(`${imgNs()}/${reposDoKit()[i]}:stable`);
    });
  });
});

describe("o kit aponta para o que o CI realmente publica", () => {
  it("os defaults de código e os labels de origem apontam para este fork", () => {
    const repo = "https://github.com/founders-br/crm-laura";
    for (const script of ["install.sh", "comecar.sh"]) {
      const texto = fs.readFileSync(path.join(RAIZ, "hostgator-setup-kit", script), "utf8");
      expect(texto).toContain(`REPO_URL="\${REPO_URL:-${repo}.git}"`);
    }
    expect(COMUM).toContain(`local url="\${1:-${repo}.git}" ref`);
    for (const dockerfile of ["Dockerfile", "Dockerfile.worker", "Dockerfile.scheduler"]) {
      expect(fs.readFileSync(path.join(RAIZ, dockerfile), "utf8")).toContain(
        `org.opencontainers.image.source="${repo}"`,
      );
    }
  });

  it.each([undefined, "registry.example/outro-dono"])(
    "ghcr_status consulta token e manifesto no IMG_NS (%s)",
    (namespace) => {
      const ns = namespace ?? imgNs();
      const [registry, owner] = ns.split("/");
      const saida = execFileSync(
        "bash",
        [
          "-c",
          `
        source hostgator-setup-kit/_common.sh
        if [ -n "$1" ]; then IMG_NS="$1"; fi
        curl() {
          local arg
          for arg in "$@"; do
            case "$arg" in
              https://*/token[?]*) printf '%s\\n' "$arg" >> "$log"; printf '{"token":"teste"}'; return;;
              https://*/v2/*) printf '%s\\n' "$arg" >> "$log"; printf '200'; return;;
            esac
          done
          return 1
        }
        log=$(mktemp)
        trap 'rm -f "$log"' EXIT
        # O dublê registra em arquivo porque a função captura stdout do curl.
        ghcr_status deskcommcrm 1.2.3
        printf '\\n'
        cat "$log"
      `,
          "teste",
          namespace ?? "",
        ],
        { cwd: RAIZ, encoding: "utf8" },
      );
      expect(saida.trim().split("\n")).toEqual([
        "200",
        `https://${registry}/token?scope=repository:${owner}/deskcommcrm:pull&service=${registry}`,
        `https://${registry}/v2/${owner}/deskcommcrm/manifests/1.2.3`,
      ]);
    },
  );

  it("o registry do kit é o mesmo do workflow de publicação", () => {
    const m = PUBLICA.match(/^\s*REGISTRY:\s*(\S+)$/m);
    expect(m, "não achei `REGISTRY:` em .github/workflows/publish-image.yml").not.toBeNull();
    expect(imgNs().split("/")[0]).toBe(m![1]);
  });

  it("o workflow ainda deriva o dono do repositório, em vez de fixar um", () => {
    // Se esta linha virar um literal, o namespace passa a ter três donos e um
    // fork perde a única parte que já funcionava sozinha para ele.
    expect(PUBLICA).toContain(
      "images: ${{ env.REGISTRY }}/${{ github.repository_owner }}/${{ matrix.name }}",
    );
  });

  it("as três imagens do kit são exatamente as três que o workflow constrói", () => {
    const naMatriz = [...PUBLICA.matchAll(/^\s{10}- name: (\S+)$/gm)].map((m) => m[1]);
    expect(naMatriz.length, "a matriz de publish-image.yml não tem mais três imagens").toBe(3);
    expect([...naMatriz].sort()).toEqual([...reposDoKit()].sort());
  });
});

/**
 * A catraca que mantém a elegância do #397 de pé.
 *
 * Sem ela, o literal volta a se espalhar — e uma âncora que convive com 30
 * cópias não é âncora, é a primeira de 31 afirmações que podem divergir.
 * A allowlist tem quatro entradas e só encolhe:
 *
 *   _common.sh               a FONTE: o literal nasce aqui
 *   docker-compose.prod.yml  YAML não deriva de shell; conferido acima
 *   .env.hostgator.example   template que o operador copia; conferido acima
 *   este arquivo             a âncora, que precisa do literal para ancorar
 */
describe("catraca: ninguém mais repete o namespace", () => {
  const PERMITIDO = new Set([
    "hostgator-setup-kit/_common.sh",
    "docker-compose.prod.yml",
    ".env.hostgator.example",
    "tests/unit/namespace-das-imagens.test.ts",
  ]);

  /**
   * Varre o DISCO (`grep -r`), não o índice do git: arquivo novo ainda
   * untracked é justamente o que um gate por `git ls-files` não enxerga.
   *
   * `grep -r` (minúsculo) não desce por symlink de diretório — o que mantém
   * `node_modules` de worktree fora do caminho mesmo quando ele é um link.
   *
   * A primeira versão fazia isto com `readdirSync` recursivo + `readFileSync`:
   * levava 8s numa rodada e ESTOUROU o timeout de 15s na seguinte, na mesma
   * máquina. Um gate que reprova por lentidão não distingue defeito de disco
   * ocupado — e o conserto para o qual ele empurra é aumentar o timeout.
   *
   * De fora ficam artefato e PROSA: documentação cita o namespace de propósito
   * (ADR, CHANGELOG, runbooks) e não monta string em runtime. A catraca vale
   * para o que executa.
   */
  function reincidentes(): string[] {
    const excluiDir = [
      ".git",
      "node_modules",
      ".next",
      "docs",
      "coverage",
      "playwright-report",
      "test-results",
      ".superpowers",
      // Prova visual (PNG, trace) e worktrees aninhados — 42 MB e 4,8 s de
      // varredura entre os dois, medido. Nenhum dos dois monta referência de
      // imagem: `evidence/` é artefato de QA e `.claude/worktrees/` são OUTRAS
      // árvores do repo, com o gate delas próprio.
      "evidence",
      ".claude",
    ].map((d) => `--exclude-dir=${d}`);
    // `.bak`/`.orig`/`.rej`/`~` são sobra de editor e de `sed -i.bak`. Sem isto,
    // uma sabotagem local deixa o gate vermelho pelo motivo errado.
    const excluiArq = ["*.md", "*.bak", "*.orig", "*.rej", "*~"].map((g) => `--exclude=${g}`);

    let saida = "";
    try {
      saida = execFileSync(
        "grep",
        ["-rlF", NAMESPACE_DESTE_REPO, ".", ...excluiDir, ...excluiArq],
        { cwd: RAIZ, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      );
    } catch (e) {
      // grep sai 1 quando não casa nada — que aqui é o resultado bom. Qualquer
      // outro código é o INSTRUMENTO quebrado, e ele precisa gritar: um catch
      // que devolvesse [] daria verde com a varredura morta.
      const err = e as { status?: number; stderr?: string };
      if (err.status !== 1) {
        throw new Error(`a varredura do namespace não rodou (grep saiu ${err.status}): ${err.stderr ?? ""}`);
      }
    }
    return saida
      .split("\n")
      .filter(Boolean)
      .map((l) => l.replace(/^\.\//, ""))
      .filter((rel) => !PERMITIDO.has(rel))
      .sort();
  }

  it("a varredura enxerga o literal onde ele está — senão o silêncio não vale nada", () => {
    // O controle do instrumento. Sem ele, um `grep` que devolvesse vazio por
    // qualquer motivo (flag errada, cwd errado) leria como "ninguém repete".
    //
    // O alvo é ESTE arquivo, e não o compose: um fork que renomeia o namespace
    // de forma coerente muda o compose junto, e o controle apontado para lá
    // ficaria vermelho por tabela — dois vermelhos onde o desenho promete um.
    // Aqui o literal existe por construção, em `NAMESPACE_DESTE_REPO`.
    const alvo = "tests/unit/namespace-das-imagens.test.ts";
    const saida = execFileSync("grep", ["-rlF", NAMESPACE_DESTE_REPO, alvo], {
      cwd: RAIZ,
      encoding: "utf8",
    });
    expect(saida.trim()).toBe(alvo);
  });

  it("o literal do namespace só aparece nos arquivos permitidos", () => {
    expect(
      reincidentes(),
      "estes arquivos voltaram a escrever o namespace à mão. Derive de IMG_NS " +
        "(shell: `source _common.sh`, ou leia-o como tests/shell/update-guard.test.sh faz; " +
        "TS: leia-o como este arquivo faz) — senão a âncora deixa de ser única e um " +
        "namespace errado fica verde em todo lugar.",
    ).toEqual([]);
  });
});
