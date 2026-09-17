/**
 * O CLI DO SUPABASE NOS WORKFLOWS TEM DE ESTAR EM VERSÃO EXATA.
 *
 * ## O defeito
 *
 * `.github/workflows/e2e.yml` instalava o CLI com `version: latest`. O run
 * deixava de ser determinístico: o `latest` do registry no minuto do run é
 * quem decide qual stack sobe — PostgREST, GoTrue, Storage, Realtime — e o e2e
 * exercita exatamente esse stack. Uma release upstream muda o produto sob
 * teste sem commit nosso, e o vermelho aparece no PR de quem passou por ali,
 * com um diff que não tem nada a ver.
 *
 * MEDIDO EM 2026-09-14, porque a issue #833 deixou esta pergunta em aberto:
 *   - `latest` no npm era **2.117.0** (publicada em 2026-09-07); `beta` era
 *     2.118.0-beta.37 e `hotfix`, 1.142.2 — três refs vivas no mesmo registry;
 *   - o template de stack DESTA versão (`supabase/cli`, tag `v2.117.0`,
 *     `apps/cli-go/pkg/config/templates/Dockerfile`, sha256 `d9b2e12d…`) sobe
 *     `postgrest/postgrest:v16.2`, `supabase/gotrue:v2.196.0`,
 *     `supabase/realtime:v2.130.0` e `supabase/storage-api:v1.72.1`.
 *   Ou seja: o PostgREST que o CI exercita não estava pinado em lugar nenhum —
 *   estava pinado *dentro da versão do CLI que o run escolhesse*.
 *
 * ## O que se guarda
 *
 * A FORMA, nunca o número. O teste não conhece a versão em uso: ele reprova
 * qualquer workflow que instale o CLI sem versão exata — `version: latest`,
 * faixa (`^2.117.0`, `~2`, `2.x`), versão parcial (`2.117`) ou instalação por
 * shell que resolve o `latest` no run (`npx supabase`, `npm i -g supabase`,
 * `brew install supabase/tap/supabase`). `supabase upgrade` também reprova: é
 * o pino se movendo sozinho, depois do run já ter começado.
 *
 * Repetir a versão aqui criaria uma segunda fonte da mesma verdade, que
 * envelhece sozinha — a doutrina de packaging (`docs/doctrine/packaging.md`)
 * já pede "tag fixa" para dependência upstream e é o mesmo raciocínio.
 *
 * A régua é a mesma que `tests/unit/packaging-artefato-do-cliente.test.ts` já
 * aplica às imagens upstream ("nunca :latest nem tag implícita"). O artefato,
 * porém, é outro — o CLI que o CI instala — e por isso a varredura mora num
 * arquivo próprio, em vez de dentro daquele.
 *
 * ## O que fica de fora, de propósito
 *
 * `scripts/gerar-env-e2e.sh` tem um `npx supabase` de reserva para a máquina
 * de quem desenvolve, quando não há CLI no PATH. É outro ambiente, com outro
 * dono, e mexer nele não é o fix desta issue — mas está nomeado aqui para não
 * passar por esquecimento.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = path.resolve(__dirname, "../..");
const DIR_WORKFLOWS = path.join(RAIZ, ".github/workflows");

/** Versão exata: três números e nada mais. `v2.117.0` passa; `latest`, `^2.117.0`, `2.117` e `2.x` não. */
const VERSAO_EXATA = /^v?\d+\.\d+\.\d+$/;

/** Ação de marketplace que instala o CLI. */
const ACAO_DO_CLI = /^uses:\s*supabase\/setup-cli@/;

/**
 * Comandos que instalam o CLI, ou o resolvem, em tempo de run. O primeiro
 * token tem de ser o instalador: assim um `echo "rode npx supabase start"`
 * dentro de um `run:` não é confundido com instalação — falso positivo em
 * catraca custa caro, porque ensina o time a ignorá-la.
 */
const COMANDOS_INSTALADORES =
  /^\s*(?:-\s+)?(?:sudo\s+)?(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?<cmd>npx|npm|pnpm|yarn|bun|bunx|brew|corepack)\b(?<resto>.*)$/;

/** O CLI se auto-atualizando no meio do run: o pino se move sem commit. */
const AUTO_UPGRADE = /^\s*(?:-\s+)?supabase\s+upgrade\b/;

interface Instalacao {
  arquivo: string;
  linha: number;
  forma: "ação" | "shell";
  comando: string;
  /** O que o workflow declara como versão — `null` quando não declara nada. */
  versao: string | null;
}

function ehComentario(linha: string): boolean {
  return /^\s*#/.test(linha);
}

function recuo(linha: string): number {
  return linha.length - linha.trimStart().length;
}

/**
 * O bloco do passo: da linha do `uses:` até a primeira linha (vazia ou não)
 * com recuo menor ou igual. Parser deliberadamente pequeno — o alvo é achar o
 * `version:` do `with:` deste passo, não entender YAML.
 */
function blocoDoPasso(linhas: string[], i: number): string[] {
  const primeira = linhas[i];
  if (primeira === undefined) return [];
  const base = recuo(primeira);
  const bloco = [primeira];
  for (let j = i + 1; j < linhas.length; j++) {
    const atual = linhas[j];
    if (atual === undefined) continue;
    if (atual.trim() === "") continue;
    if (recuo(atual) > base) {
      bloco.push(atual);
      continue;
    }
    break;
  }
  return bloco;
}

function versaoDoBloco(bloco: string[]): string | null {
  for (const linha of bloco) {
    const m = /^\s*version:\s*(?<valor>.+?)\s*$/.exec(linha);
    const valor = m?.groups?.valor;
    if (valor === undefined) continue;
    return valor.replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "");
  }
  return null;
}

/**
 * O corpo da linha, sem o ruído de YAML: tira o `- ` do item de sequência e o
 * `run:` do passo. Sem isto, `- uses: …` e `- run: npx supabase` nunca casam —
 * foi assim que a primeira versão desta catraca nasceu morta, e a guarda de
 * vacuidade é quem acusou.
 */
function corpoDaLinha(linha: string): string {
  return linha
    .trim()
    .replace(/^-\s+/, "")
    .replace(/^run:\s*/, "");
}

/** Toda instalação do CLI num arquivo de workflow, com o que ela declara de versão. */
function instalacoes(arquivo: string, linhas: string[]): Instalacao[] {
  const achados: Instalacao[] = [];

  linhas.forEach((linha, idx) => {
    if (ehComentario(linha)) return;
    const numero = idx + 1;
    const corpo = corpoDaLinha(linha);

    if (ACAO_DO_CLI.test(corpo)) {
      achados.push({
        arquivo,
        linha: numero,
        forma: "ação",
        comando: linha.trim(),
        versao: versaoDoBloco(blocoDoPasso(linhas, idx)),
      });
      return;
    }

    if (AUTO_UPGRADE.test(corpo)) {
      achados.push({ arquivo, linha: numero, forma: "shell", comando: linha.trim(), versao: null });
      return;
    }

    const m = COMANDOS_INSTALADORES.exec(corpo);
    const resto = m?.groups?.resto;
    if (resto === undefined) return;
    if (!/\bsupabase\b/.test(resto)) return;

    achados.push({
      arquivo,
      linha: numero,
      forma: "shell",
      comando: linha.trim(),
      versao: /\bsupabase@(?<ref>[^\s'"]+)/.exec(resto)?.groups?.ref ?? null,
    });
  });

  return achados;
}

function lerWorkflows(): { arquivo: string; linhas: string[] }[] {
  return fs
    .readdirSync(DIR_WORKFLOWS)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => ({
      arquivo: `.github/workflows/${f}`,
      linhas: fs.readFileSync(path.join(DIR_WORKFLOWS, f), "utf8").split("\n"),
    }));
}

function descrever(a: Instalacao): string {
  return `${a.arquivo}:${a.linha} — ${a.comando} (versão declarada: ${a.versao ?? "nenhuma"})`;
}

/**
 * O juízo da catraca, num lugar só: instalação sem versão declarada, ou com
 * ref que não seja três números, é violação. As três contraprovas usam ESTA
 * função — no dia em que o critério mudar, muda aqui e as provas acompanham.
 */
function ehViolacao(a: Instalacao): boolean {
  return a.versao === null || !VERSAO_EXATA.test(a.versao);
}

describe("o CLI do Supabase é instalado em versão exata nos workflows", () => {
  const workflows = lerWorkflows();
  const todas = workflows.flatMap((w) => instalacoes(w.arquivo, w.linhas));

  it("a catraca mede alguma coisa (guarda de vacuidade)", () => {
    // Sem esta guarda, um diretório vazio, um `readdir` errado ou um regex que
    // envelheceu dariam verde — e o teste viraria peso morto que ninguém nota.
    expect(workflows.length, "workflows lidos em .github/workflows").toBeGreaterThan(0);
    expect(
      todas.length,
      "nenhuma instalação do CLI encontrada: se o CI deixou de instalar o CLI, ajuste esta guarda DE PROPÓSITO",
    ).toBeGreaterThan(0);
    expect(
      todas.some((a) => a.arquivo === ".github/workflows/e2e.yml"),
      "o e2e é quem sobe o stack local da suíte; ele tem de instalar o CLI em algum lugar",
    ).toBe(true);
  });

  it("nenhum workflow instala o CLI sem versão exata", () => {
    const soltas = todas.filter(ehViolacao);

    expect(
      soltas.map(descrever),
      "instalação do CLI sem versão exata: o `latest` do registry no minuto do run escolhe o stack " +
        "sob teste (PostgREST, GoTrue, Storage, Realtime) sem commit nosso (#833). " +
        "Declare a versão exata no workflow — subir o pino é ato deliberado, com data e razão no comentário",
    ).toEqual([]);
  });

  it("nenhum workflow deixa o CLI se auto-atualizar no meio do run", () => {
    const upgrades = todas.filter((a) => AUTO_UPGRADE.test(a.comando));
    expect(
      upgrades.map(descrever),
      "`supabase upgrade` troca a versão depois do run ter começado — o pino deixa de valer",
    ).toEqual([]);
  });

  it("todos os workflows falam da mesma versão do CLI", () => {
    // Duas versões do CLI convivendo é a divergência de ambiente de volta, só
    // que interna: dois jobs medindo produtos diferentes. A doutrina pede tag
    // fixa, não "cada arquivo com a sua".
    const versoes = [...new Set(todas.map((a) => a.versao).filter((v): v is string => v !== null))];

    expect(
      versoes.length,
      `versões diferentes do CLI convivem nos workflows: ${versoes.join(", ")} — escolha uma e use em todos`,
    ).toBeLessThanOrEqual(1);
  });

  it("a catraca reprova o que tem de reprovar (contraprova)", () => {
    // Contraprova sintética: prova que o instrumento MORDE, sem depender de
    // mutar os arquivos de verdade. Cada entrada aqui é um jeito conhecido de
    // perder o determinismo.
    const morde = [
      "      - uses: supabase/setup-cli@v3",
      "      - uses: supabase/setup-cli@v3\n        with:\n          version: latest",
      "      - uses: supabase/setup-cli@v3\n        with:\n          version: ^2.117.0",
      "      - uses: supabase/setup-cli@v3\n        with:\n          version: 2.117",
      "      - uses: supabase/setup-cli@v3\n        with:\n          version: 2.x",
      "        run: npx supabase start",
      "        run: npm i -g supabase",
      "        run: npm install -g supabase@latest",
      "        run: pnpm dlx supabase@beta db push",
      "        run: brew install supabase/tap/supabase",
      "        run: supabase upgrade",
      "        run: pnpm install && npx supabase start",
    ];

    const escaparam = morde.filter((texto) => {
      const achados = instalacoes("sintetico.yml", texto.split("\n"));
      return !achados.some(ehViolacao);
    });

    expect(
      escaparam,
      "estes casos passariam pela catraca e não deveriam — o regex envelheceu",
    ).toEqual([]);
  });

  it("a catraca não reprova o que está certo (contraprova do falso positivo)", () => {
    const passa = [
      "      - uses: supabase/setup-cli@v3\n        with:\n          version: 2.117.0",
      '      - uses: supabase/setup-cli@v3\n        with:\n          version: "2.117.0" # pino do CI',
      "        run: npx supabase@2.117.0 start",
      "        run: npm i -g supabase@2.117.0",
      "        run: supabase start",
      "        run: supabase status -o env",
      '        run: echo "rode npx supabase start antes"',
      "      # npx supabase sobe o stack na sua máquina",
    ];

    const acusados = passa.flatMap((texto) =>
      instalacoes("sintetico.yml", texto.split("\n"))
        .filter(ehViolacao)
        .map(descrever),
    );

    expect(
      acusados,
      "catraca acusando quem está certo — falso positivo ensina o time a ignorá-la",
    ).toEqual([]);
  });
});
