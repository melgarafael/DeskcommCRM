import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * MÓDULO COM FUNÇÃO PURA NÃO PODE EXIGIR AMBIENTE PARA SER IMPORTADO.
 *
 * O defeito que este teste existe para impedir derrubou a main inteira
 * (run 30182066284): `tests/unit/timeline-eixo.test.ts` importava
 * `eixoDoDossie` — função pura, sem I/O nenhum — de um módulo que tinha, no
 * topo, `import { createAdminClient } from "@/lib/supabase/admin"` e
 * `import { isServiceRoleConfigured } from "@/lib/audit"`. Os dois puxam
 * `@/lib/env`, que VALIDA o ambiente ao carregar e LANÇA se faltar variável.
 *
 * No CI não existe `.env` no disco. Resultado: a suíte falhou ao CARREGAR —
 * "Failed Suites 1", 134 passaram, nenhuma asserção do arquivo chegou a rodar.
 * E o modo de falha é traiçoeiro por dois motivos:
 *
 *   1. PASSA NA MÁQUINA DE QUEM ESCREVE. Localmente o `.env.local` existe e o
 *      setup do vitest o carrega — o teste fica verde e vermelho só no CI.
 *   2. QUEBRA QUEM NÃO MEXEU EM NADA. A main vermelha trava todos os PRs
 *      abertos, e o autor do PR bloqueado não tem relação com o arquivo.
 *
 * ⚠️ ESTE TESTE NÃO PODE RODAR NO MESMO PROCESSO DA SUÍTE: o setup do vitest
 * já carregou o `.env` para dentro de `process.env`, e qualquer import daqui
 * encontraria o ambiente completo — o teste passaria SEMPRE, medindo nada. Por
 * isso ele abre um processo filho com o ambiente LIMPO. É a diferença entre
 * verificar e parecer que verificou.
 */

const RAIZ = join(__dirname, "..", "..");

/**
 * Os módulos vigiados: os que um teste unitário importa por causa de função
 * pura. A lista é explícita porque a alternativa (varrer tudo) acusaria os
 * módulos que PRECISAM de env — e um teste que acusa o correto é pior que
 * teste nenhum: some por ruído.
 */
const MODULOS_PUROS = ["@/lib/leads/timeline-query"] as const;

/**
 * Mensagem que `@/lib/env` lança quando o Zod reprova o ambiente (`lib/env.ts`).
 * O controle positivo abaixo exige ESTA mensagem, não um erro qualquer — ver lá
 * o porquê.
 */
const FALHA_ESPERADA_DO_ENV = "Variáveis de ambiente inválidas";

/**
 * Importa o módulo num processo filho SEM as variáveis do app.
 *
 * Invoca o Node DIRETO (`process.execPath`) com o loader do tsx via `--import`,
 * e NÃO `npx tsx`: no Windows o `npx` só existe como `npx.cmd`, e o
 * `execFileSync` sem `shell: true` devolve ENOENT pra `npx` e EINVAL pra
 * `npx.cmd` (mitigação do CVE-2024-27980, Node ≥18.20/20.12/22). O teste ficava
 * vermelho na máquina de quem desenvolve no Windows por defeito do APARATO, não
 * do módulo vigiado — e o controle positivo passava pelo motivo errado, porque
 * ENOENT também dá `ok:false`.
 *
 * `shell: true` mataria o ENOENT e traria coisa pior: o `script` abaixo tem
 * aspas, e mandá-lo por interpretador de shell é escaping esperando pra falhar.
 * `process.execPath` é caminho absoluto — nem depende do PATH pra resolver.
 */
function importaComAmbienteLimpo(modulo: string): { ok: boolean; erro: string } {
  // Nenhuma barra invertida no script: o filho só IMPRIME e quem recorta linha é
  // o pai, logo abaixo. Escapar `\n` através de duas camadas de citação
  // (template literal + linha de comando) é o tipo de coisa que quebra em um
  // sistema operacional só, que é exatamente o defeito que este comentário
  // fecha.
  const script = `import(${JSON.stringify(modulo)}).then(()=>console.log("OK"),(e)=>console.log("ERRO:"+(e && e.message)));`;
  // Só PATH e HOME: PATH porque processo filho sem PATH é campo minado, HOME
  // pro cache do tsx. Nenhuma variável do app — é justamente a ausência delas
  // que o teste mede. `NODE_ENV` fica de fora de propósito; o cast existe porque
  // o tipo do Node o exige e aqui a omissão é o ponto.
  const limpo = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
  } as unknown as NodeJS.ProcessEnv;
  try {
    const saida = execFileSync(process.execPath, ["--import", "tsx", "--eval", script], {
      cwd: RAIZ,
      env: limpo,
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Linha EXATA, não `includes("OK")`: mensagem de erro que por acaso contenha
    // "OK" não pode virar sucesso. O `trim()` também come o `\r` do Windows.
    const linhas = saida
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return { ok: linhas.includes("OK"), erro: linhas.join(" | ").slice(0, 400) };
  } catch (e) {
    return { ok: false, erro: e instanceof Error ? e.message.slice(0, 400) : String(e) };
  }
}

describe("módulo de função pura importa sem ambiente", () => {
  // Timeout explícito: estes dois casos abrem um PROCESSO FILHO (`node --import
  // tsx`), que custa ~5s em máquina livre e mais em máquina carregada — acima do
  // padrão de 5s do vitest. O timeout interno do execFileSync já é 120s; quem
  // estourava era o do vitest, e o teste ficava vermelho por LENTIDÃO, não por
  // defeito. Justamente o estrago que o cabeçalho deste arquivo descreve: main
  // vermelha travando PR de quem não mexeu em nada (aconteceu no PR #81, que só
  // mexia em documentação).
  it("o aparato consegue detectar o defeito (controle positivo)", { timeout: 60_000 }, () => {
    // Sem isto, um processo filho que falhasse por qualquer motivo daria
    // "ok:false" e o teste principal ficaria vermelho pelo motivo errado — ou,
    // pior, um script que sempre imprime OK deixaria tudo verde medindo nada.
    // `@/lib/env` DEVE falhar sem ambiente: é literalmente o trabalho dele.
    const controle = importaComAmbienteLimpo("@/lib/env");
    expect(controle.ok, `esperava @/lib/env FALHAR sem env, veio: ${controle.erro}`).toBe(false);
    // `ok:false` sozinho NÃO é controle: ENOENT do spawn, tsx ausente ou typo no
    // caminho também dão `ok:false`, e aí o aparato estaria quebrado com o
    // controle verde — o "medir nada e ficar verde" que o cabeçalho proíbe. Só a
    // mensagem do Zod prova que o filho SUBIU, importou o módulo e reprovou o
    // ambiente. Se `lib/env.ts` mudar essa mensagem, atualize a constante.
    expect(
      controle.erro,
      `o controle positivo falhou pelo motivo ERRADO: esperava a validação Zod de @/lib/env ` +
        `("${FALHA_ESPERADA_DO_ENV}"), veio: ${controle.erro}. ` +
        `Isso é defeito do APARATO (processo filho não subiu?), não do módulo vigiado — ` +
        `enquanto durar, o caso abaixo não está medindo nada.`,
    ).toContain(FALHA_ESPERADA_DO_ENV);
  });

  it.each(MODULOS_PUROS)("%s importa com ambiente vazio", { timeout: 60_000 }, (modulo) => {
    const r = importaComAmbienteLimpo(modulo);
    expect(
      r.ok,
      `${modulo} não pôde ser importado sem variáveis de ambiente — ` +
        `algum import do TOPO puxa @/lib/env. Mova-o para dentro da função que o usa ` +
        `(import tardio). Saída: ${r.erro}`,
    ).toBe(true);
  });
});

describe("o vigiado não regride pelo caminho estático", () => {
  it("timeline-query não tem import de topo que valide env", () => {
    // Rede de segurança BARATA: o teste acima abre processo (segundos); este
    // lê o arquivo (milissegundos) e pega o caso comum na hora, com mensagem
    // que aponta a linha exata. Os dois cobrem o mesmo defeito por caminhos
    // diferentes — se um for desligado por lentidão, o outro continua.
    const src = readFileSync(join(RAIZ, "lib/leads/timeline-query.ts"), "utf8");
    const topo = src.slice(0, src.indexOf("\nexport "));
    const proibidos = ["@/lib/supabase/admin", "@/lib/audit", "@/lib/env"];
    const achados = proibidos.filter((m) =>
      new RegExp(`^import\\s+(?!type\\b)[^;]*from\\s+["']${m}["']`, "m").test(topo),
    );
    expect(
      achados,
      `import de VALOR no topo de timeline-query.ts: ${achados.join(", ")}. ` +
        `Esses módulos validam env ao carregar e quebram quem importa só a função pura.`,
    ).toEqual([]);
  });
});

describe("a lista de vigiados não mente", () => {
  it("todo módulo vigiado existe no disco", () => {
    // Um caminho com typo viraria "0 módulos vigiados" e o `it.each` passaria
    // sem rodar nada — o verde vazio que a §7.292 proíbe.
    const faltando = MODULOS_PUROS.filter((m) => {
      const rel = m.replace("@/", "") + ".ts";
      const dir = join(RAIZ, rel.slice(0, rel.lastIndexOf("/")));
      const arquivo = rel.slice(rel.lastIndexOf("/") + 1);
      try {
        return !readdirSync(dir).includes(arquivo);
      } catch {
        return true;
      }
    });
    expect(faltando, `módulo vigiado não existe: ${faltando.join(", ")}`).toEqual([]);
    expect(MODULOS_PUROS.length).toBeGreaterThan(0);
  });
});
