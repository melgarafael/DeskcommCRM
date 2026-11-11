/**
 * NENHUMA TELA ALCANÇÁVEL É ALIMENTADA POR DADO DE MENTIRA.
 *
 * ## O defeito, e por que ele é pior do que soa
 *
 * A tela da Agenda (`app/app/agenda/_client.tsx`) nasceu importando
 * `components/agenda/dados-de-mentira` — deliberadamente, porque a API ainda não
 * existia e o maestro autorizou começar pelo que não depende do banco. O
 * problema não era existir; era estar ALCANÇÁVEL: a rota tinha porta no
 * `lib/navigation/registry.ts`, e nada — nenhuma flag, nenhum "em breve",
 * nenhum `disabled` — a escondia.
 *
 * O que transforma isso de sujeira em risco é o FORMATO do dado. Os nomes são
 * plausíveis: "Ana Prado", "Marina Alves", "Família Souza", "Visita ao imóvel"
 * — brasileiros, críveis, nos nichos que este produto atende.
 *
 * **Num produto multi-tenant, dado falso plausível é indistinguível de
 * vazamento.** O relato que chega não é "tem dado de teste na tela"; é "estou
 * vendo paciente de outra clínica na minha agenda". E aí o time queima horas
 * caçando um furo de RLS que não existe, enquanto o cliente perde a confiança
 * na única propriedade que um CRM multi-tenant precisa ter.
 *
 * Achado do QAVivo na revisão da Wave 1; decisão 18 do maestro.
 *
 * ## A inversão que este teste NÃO deve apagar
 *
 * O mesmo dado plausível é ACERTO na vitrine (`app/vitrine-agenda`): é ele que
 * faz o desenho ser julgável — uma grade com "Fulano 1" e "Evento 2" não deixa
 * ninguém avaliar densidade, truncamento ou contraste de verdade. Mesmo dado,
 * valor oposto conforme onde está pendurado.
 *
 * Por isso o escopo é `app/app/**` (a área do tenant, atrás da navegação) e
 * NÃO o repositório inteiro.
 *
 * ## O que este gate ALCANÇA, e o que ele NÃO alcança
 *
 * A primeira versão olhava só os imports DIRETOS da tela. O QAVivo replicou a
 * lógica e rodou três casos contra ela:
 *
 *   1. a tela importa a fixture direto                → pegava
 *   2. um COMPONENTE importa, e a tela importa ele    → passava VERDE
 *   3. o dado mora INLINE na tela, sem import nenhum   → passava VERDE
 *
 * O caso 2 não é exótico — é o caminho MAIS PROVÁVEL, e por causa desta mesma
 * decisão 18: quem quiser manter a demonstração viva depois de a tela cair no
 * estado vazio tem um gesto natural à mão, que é mover o `AGENDAMENTOS` para
 * dentro de `GradeDaAgenda.tsx` como default. A tela fica limpa, o gate fica
 * verde, e o dado plausível volta para a área do tenant pela porta de trás.
 * Fechado abaixo: a varredura segue os imports LOCAIS transitivamente.
 *
 * Depois veio um quarto caminho, também do QAVivo: o BARREL. Uma tela importa
 * `@/components/agenda`, e o `index.ts` de lá faz `export * from
 * "./dados-de-mentira"`. Não há import nenhum no barrel, então a cadeia morria
 * ali. Fechado: a varredura casa `export ... from` junto com `import`.
 *
 * O caso 3 continua ABERTO, e está escrito aqui porque ponto cego não declarado
 * é pior que gate ausente — dá confiança que o gate não sustenta. Pegá-lo exige
 * inspecionar CONTEÚDO (um array literal de objetos com cara de pessoa) em vez
 * de import, e aí a heurística passa a errar nos dois sentidos: reprova seed de
 * `<select>` e deixa passar dado disfarçado. Custo alto, precisão baixa; não
 * perseguido de propósito.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { relativoEmBarraNormal } from "./helpers/caminho";

const RAIZ = process.cwd();
const AREA_DO_TENANT = path.join(RAIZ, "app/app");

/**
 * Módulos que só existem para alimentar tela sem banco. `mock`/`stub` entram
 * porque são o nome que a próxima pessoa vai usar quando `dados-de-mentira`
 * estiver vigiado — o gate tem de mirar na categoria, não no nome de hoje.
 */
const PROIBIDOS = /(dados-de-mentira|fixtures?|mock|stub|dados-falsos|seed-de-tela)/i;

/**
 * Exceção precisa de MOTIVO ESCRITO, e o teste cobra o motivo — allowlist sem
 * razão vira depósito, e depósito não é exceção, é a regra desmontada.
 */
const PERMITIDOS: Record<string, string> = {};

function arquivosDeTela(dir: string): string[] {
  const achados: string[] = [];
  for (const entrada of readdirSync(dir)) {
    const completo = path.join(dir, entrada);
    if (statSync(completo).isDirectory()) {
      achados.push(...arquivosDeTela(completo));
    } else if (/\.tsx?$/.test(entrada)) {
      achados.push(completo);
    }
  }
  return achados;
}

/** Só o que é IMPORT — a palavra num comentário explicando a regra não conta. */
function importesDe(fonte: string): string[] {
  const alvos: string[] = [];
  // `export ... from` entra junto com `import`: um barrel (`components/agenda/index.ts`
  // com `export * from "./dados-de-mentira"`) não tem import NENHUM, então a
  // cadeia morria nele e o gate voltava verde. Achado do QAVivo, que replicou a
  // varredura e testou o caminho. É realista pelo mesmo motivo do caso do
  // componente: um index.ts é o próximo passo natural de quem quer limpar
  // imports numa pasta com 8 arquivos, e o re-export entra sem ninguém pensar.
  const re =
    /(?:import[^"']*from\s*|export[^"']*from\s*|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fonte)) !== null) alvos.push(m[1]!);
  return alvos;
}

/** Resolve `@/x` e `./x` para um arquivo do repo. `null` para pacote externo. */
function resolverLocal(especificador: string, deOndeVeio: string): string | null {
  let base: string;
  if (especificador.startsWith("@/")) base = path.join(RAIZ, especificador.slice(2));
  else if (especificador.startsWith(".")) base = path.resolve(path.dirname(deOndeVeio), especificador);
  else return null;

  for (const tentativa of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]) {
    try {
      if (statSync(tentativa).isFile()) return tentativa;
    } catch {
      /* não existe: tenta a próxima extensão */
    }
  }
  return null;
}

/**
 * A cadeia de imports locais a partir de um arquivo, até o fim.
 *
 * Transitivo, e não "um nível": fechar só o primeiro salto empurraria o mesmo
 * gesto um arquivo adiante, e o gate viraria uma corrida contra a profundidade.
 * `vistos` corta ciclo — import circular entre componentes existe e não pode
 * pendurar a suíte.
 */
/**
 * As arestas de UM arquivo, lidas uma vez só.
 *
 * Sem este cache, cada tela relia do disco e repassava a regex em todo arquivo
 * da própria cadeia: o custo era telas × grafo, crescia com o repositório, e a
 * varredura passou dos 15 s do teto no runner (16 s medidos na main em
 * 10/11/2026), reprovando o `verify` de PR que não tocava nada disto. O que é
 * guardado é só o que o arquivo importa; o caminho continua sendo percorrido
 * por tela, com o `vistos` próprio dela, então o resultado é o mesmo.
 */
const ARESTAS = new Map<string, { proibidos: string[]; locais: string[] }>();

function arestasDe(arquivo: string): { proibidos: string[]; locais: string[] } {
  const guardado = ARESTAS.get(arquivo);
  if (guardado) return guardado;
  const arestas = { proibidos: [] as string[], locais: [] as string[] };
  let fonte: string | null = null;
  try {
    fonte = readFileSync(arquivo, "utf8");
  } catch {
    /* não deu para ler: arquivo sem arestas, como antes */
  }
  if (fonte !== null) {
    for (const especificador of importesDe(fonte)) {
      if (PROIBIDOS.test(especificador)) {
        arestas.proibidos.push(`${relativoEmBarraNormal(RAIZ, arquivo)} → ${especificador}`);
        continue;
      }
      const local = resolverLocal(especificador, arquivo);
      if (local) arestas.locais.push(local);
    }
  }
  ARESTAS.set(arquivo, arestas);
  return arestas;
}

function cadeiaDeImports(arquivo: string, vistos = new Set<string>()): string[] {
  if (vistos.has(arquivo)) return [];
  vistos.add(arquivo);
  const { proibidos, locais } = arestasDe(arquivo);
  const achados = [...proibidos];
  for (const local of locais) achados.push(...cadeiaDeImports(local, vistos));
  return achados;
}

describe("tela alcançável não come dado de mentira", () => {
  const arquivos = arquivosDeTela(AREA_DO_TENANT);

  it("a varredura enxerga a área do tenant (senão o verde não vale nada)", () => {
    // Um gate que varre zero arquivo passa sempre. Este número existe para a
    // suíte ficar vermelha se alguém mover `app/app/` e o teste continuar
    // "verde" varrendo o vazio.
    expect(arquivos.length).toBeGreaterThan(50);
  });

  it("nenhuma tela do tenant CHEGA a uma fixture, nem por caminho indireto", () => {
    const infratores: string[] = [];
    for (const arquivo of arquivos) {
      const rel = relativoEmBarraNormal(RAIZ, arquivo);
      if (PERMITIDOS[rel]) continue;
      // A cadeia inteira, não só o import direto: o caminho provável é a tela
      // importar um componente limpo que importa a fixture.
      const proibidos = cadeiaDeImports(arquivo);
      if (proibidos.length > 0) infratores.push(`${rel}: ${[...new Set(proibidos)].join(" | ")}`);
    }
    expect(
      infratores,
      "Tela do tenant alimentada por dado de mentira. Num produto multi-tenant, " +
        "dado falso PLAUSÍVEL é indistinguível de vazamento — o relato que chega é " +
        '"estou vendo paciente de outra clínica na minha agenda". Caia no estado ' +
        "vazio até a API existir, ou tire a porta do registry com justificativa.",
    ).toEqual([]);
  });

  it("toda exceção explica o porquê", () => {
    for (const [rota, motivo] of Object.entries(PERMITIDOS)) {
      expect(motivo.length, `${rota} está na allowlist sem motivo escrito`).toBeGreaterThan(30);
    }
  });
});
