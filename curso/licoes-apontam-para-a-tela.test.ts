// A segunda cerca do curso: além do contrato, o DESTINO de cada passo.
//
// `licoes.test.ts` confere a forma (`Modulo.parse`), que `Modulo.tela` existe no
// menu e que os ids não se repetem. Ele NÃO lê `Passo.rota`, nem o alvo de
// `antes: rolar #ancora`, nem os `destaques`: trocar `/admin/sistema` por uma
// rota inventada, ou o alvo de um destaque por um seletor inexistente, deixava
// a suíte verde e só o capturador no app real reclamava. Medido duas vezes, nas
// ondas do #4762 e do #4761.
//
// Esta cerca compara com o REPOSITÓRIO, nunca com uma lista escrita à mão:
// rota contra a árvore `app/` (mais os hrefs de `lib/navigation/catalogo.ts`);
// âncora contra o fonte da tela, resolvido pelo grafo de imports a partir do
// `page.tsx` daquela rota; alvo de destaque, `antes` e `clicar` contra todo o
// fonte de `app/`, `components/` e `lib/` — não só o da tela daquela rota.
//
// O que ela NÃO prova — e por isso está declarado em `divida-de-alvos.json`, com
// motivo por tipo — é o alvo cujo texto é montado em tempo de execução com dado
// semeado (`Acompanhar ${nome}`, `passo-titulo-${i}`): o literal inteiro não
// existe no fonte para ser procurado. Declarar ali não é aprovar: alvo novo que
// não exista no fonte e não esteja na lista reprova — com um teto declarado:
// alvo cujo começo casa o prefixo estático de um template do fonte (`salvar-${x}`
// prova qualquer `salvar-…`) conta como provado. Medido no #4826: 332 alvos só
// passam assim, 296 deles testids.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const PASTA = path.join(__dirname, "licoes");
const DICIONARIO = path.join(RAIZ, "lib", "i18n", "dicionario.ts");
const CATALOGO = path.join(RAIZ, "lib", "navigation", "catalogo.ts");
const DIVIDA = path.join(__dirname, "divida-de-alvos.json");

/** Medido em origin/main 770ce69cee (17/11/2026). Se o curso encolher, o piso
 *  reprova: uma cerca que passa por não ter o que conferir é pior que nenhuma. */
const PISO = {
  modulos: 85,
  licoes: 333,
  passos: 1444,
  passosComRota: 440,
  rotasUnicas: 125,
  rastersDeDestaque: 2888,
  acoesAntes: 1979,
  rolagensComAncora: 8,
  alvosConferidos: 3668,
  alvosEmDivida: 398,
  alvosNoCurso: 5112,
  tokensDeClasse: 55,
};

/** Papéis ARIA 1.2. Um `role` inventado não existe na árvore de acessibilidade
 *  e o capturador procura para sempre — a lista é a do padrão, não a do curso. */
const PAPEIS_ARIA = new Set([
  "alert", "alertdialog", "application", "article", "banner", "blockquote", "button", "caption",
  "cell", "checkbox", "code", "columnheader", "combobox", "complementary", "contentinfo",
  "definition", "deletion", "dialog", "directory", "document", "emphasis", "feed", "figure",
  "form", "generic", "grid", "gridcell", "group", "heading", "img", "insertion", "link", "list",
  "listbox", "listitem", "log", "main", "mark", "marquee", "math", "menu", "menubar", "menuitem",
  "menuitemcheckbox", "menuitemradio", "meter", "navigation", "none", "note", "option",
  "paragraph", "presentation", "progressbar", "radio", "radiogroup", "region", "row", "rowgroup",
  "rowheader", "scrollbar", "search", "searchbox", "separator", "slider", "spinbutton", "status",
  "strong", "subscript", "suggestion", "superscript", "switch", "tab", "table", "tablist",
  "tabpanel", "term", "textbox", "time", "timer", "toolbar", "tooltip", "tree", "treegrid",
  "treeitem",
]);

/** Classes de biblioteca: o CSS da lição usa o nome gerado pelo componente
 *  externo, que não aparece em fonte nossa. Cada uma carrega o porquê. */
const CLASSES_DE_BIBLIOTECA: Record<string, string> = {
  "recharts-default-tooltip": "classe interna do Recharts, gerada pelo gráfico em tempo de execução",
  "recharts-surface": "classe interna do Recharts no SVG do gráfico",
  "react-flow__node": "classe interna do React Flow, montada pelo canvas de fluxo",
  andrade: "sufixo que vem do dado semeado (nome de empresa), não do nosso CSS",
};

type Alvo = {
  testid?: string;
  role?: string;
  nome?: string;
  rotulo?: string;
  placeholder?: string;
  texto?: string;
  css?: string;
  regex?: boolean;
};
type Acao = { acao: string; alvo?: Alvo };
type Passo = { id: string; rota?: string; antes?: Acao[]; destaques?: { alvo: Alvo }[]; clicar?: Alvo };
type Licao = { id: string; passos: Passo[] };
type Modulo = { id: string; licoes: Licao[] };

const modulos: Modulo[] = readdirSync(PASTA)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(path.join(PASTA, f), "utf8")) as Modulo);

const passos: Passo[] = modulos.flatMap((m) => m.licoes.flatMap((l) => l.passos));

/** Extensões de fonte que podem conter uma tela. */
const EXTS = [".tsx", ".ts", ".js", ".jsx"];

function arquivosDeFonte(raiz: string): string[] {
  const saida: string[] = [];
  const pilha = [raiz];
  while (pilha.length > 0) {
    const dir = pilha.pop()!;
    for (const entrada of readdirSync(dir, { withFileTypes: true })) {
      if (entrada.name === "node_modules" || entrada.name.startsWith(".")) continue;
      const cheio = path.join(dir, entrada.name);
      if (entrada.isDirectory()) pilha.push(cheio);
      else if (EXTS.some((e) => entrada.name.endsWith(e))) saida.push(cheio);
    }
  }
  return saida;
}

/** Índice de literais do produto: `app/`, `components/`, `lib/`.
 *  `curso/` fica FORA de propósito — procurar o texto da lição dentro da
 *  própria lição provaria só que o JSON é igual a si mesmo. */
type Indice = { literais: Set<string>; prefixos: Set<string>; texto: string };

let cacheIndice: Indice | undefined;
function indice(): Indice {
  if (cacheIndice) return cacheIndice;
  const literais = new Set<string>();
  const prefixos = new Set<string>();
  const pedacos: string[] = [];
  // Uma cadeia de fonte: aspa simples, dupla ou crase, com escape.
  const CADEIA = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
  for (const raiz of ["app", "components", "lib"]) {
    for (const arquivo of arquivosDeFonte(path.join(RAIZ, raiz))) {
      const fonte = readFileSync(arquivo, "utf8");
      pedacos.push(fonte);
      CADEIA.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CADEIA.exec(fonte)) !== null) {
        const valor = m[2]!;
        literais.add(valor);
        // `id={`passo-titulo-${i}`}` só é provável pelo prefixo estático.
        if (m[1] === "`" && valor.includes("${")) {
          const prefixo = valor.slice(0, valor.indexOf("${"));
          if (prefixo.length > 3) prefixos.add(prefixo);
        }
      }
    }
  }
  for (const linha of readFileSync(DICIONARIO, "utf8").split("\n")) {
    for (const m of linha.matchAll(/(["'])((?:\\.|(?!\1)[^\\\n])*)\1/g)) literais.add(m[2]!);
  }
  cacheIndice = { literais, prefixos, texto: pedacos.join("\n") };
  return cacheIndice;
}

function existeNoFonte(valor: string): boolean {
  const { literais, prefixos } = indice();
  if (literais.has(valor)) return true;
  for (const p of prefixos) if (valor.startsWith(p)) return true;
  return false;
}

/** Rotas que o produto realmente serve: cada `page.tsx` sob `app/app` e
 *  `app/admin`. Grupo de rota `(protected)` não é segmento; `_pasta` não é
 *  rota; `[id]` é coringa de um segmento. Lido do disco, nunca de lista. */
function padroesDeRota(): string[] {
  const padroes: string[] = [];
  for (const [raiz, prefixo] of [
    [path.join(RAIZ, "app", "app"), "/app"],
    [path.join(RAIZ, "app", "admin"), "/admin"],
  ] as const) {
    const pilha: Array<[string, string[]]> = [[raiz, []]];
    while (pilha.length > 0) {
      const [dir, partes] = pilha.pop()!;
      for (const entrada of readdirSync(dir, { withFileTypes: true })) {
        const cheio = path.join(dir, entrada.name);
        if (entrada.isDirectory()) {
          if (entrada.name.startsWith("_") || entrada.name === "node_modules") continue;
          if (entrada.name.startsWith("(")) pilha.push([cheio, partes]);
          else pilha.push([cheio, [...partes, entrada.name]]);
        } else if (entrada.name === "page.tsx") {
          padroes.push(prefixo + (partes.length > 0 ? `/${partes.join("/")}` : ""));
        }
      }
    }
  }
  for (const m of readFileSync(CATALOGO, "utf8").matchAll(/href:\s*"([^"]+)"/g)) {
    padroes.push(m[1]!);
  }
  return [...new Set(padroes)].sort();
}

function casaRota(rota: string, padrao: string): boolean {
  const a = rota.replace(/\?.*$/, "").replace(/\/+$/, "").split("/").filter(Boolean);
  const b = padrao.replace(/\?.*$/, "").replace(/\/+$/, "").split("/").filter(Boolean);
  if (a.length !== b.length) return false;
  return b.every((segmento, i) => segmento.startsWith("[") || segmento === a[i]);
}

const PADROES = padroesDeRota();

function paginaDaRota(rota: string): string | undefined {
  const alvo = rota.replace(/\?.*$/, "").replace(/\/+$/, "") || "/";
  const partes = alvo.split("/").filter(Boolean);
  for (const [raiz, prefixo] of [
    [path.join(RAIZ, "app", "app"), "/app"],
    [path.join(RAIZ, "app", "admin"), "/admin"],
  ] as const) {
    if (!alvo.startsWith(prefixo)) continue;
    const relativo = partes.slice(prefixo.split("/").filter(Boolean).length);
    // Procura no disco o diretório cujo caminho casa segmento a segmento.
    const candidatos: Array<[string, string[]]> = [[raiz, []]];
    while (candidatos.length > 0) {
      const [dir, caminho] = candidatos.pop()!;
      if (caminho.length === relativo.length && existsSync(path.join(dir, "page.tsx"))) {
        if (caminho.every((seg, i) => seg === relativo[i] || seg.startsWith("["))) {
          return path.join(dir, "page.tsx");
        }
      }
      if (caminho.length >= relativo.length) continue;
      for (const entrada of readdirSync(dir, { withFileTypes: true })) {
        if (!entrada.isDirectory() || entrada.name.startsWith("_")) continue;
        const cheio = path.join(dir, entrada.name);
        candidatos.push([cheio, entrada.name.startsWith("(") ? caminho : [...caminho, entrada.name]]);
      }
    }
  }
  return undefined;
}

/** Fonte de uma tela: o `page.tsx` da rota mais o que ele importa, seguindo
 *  `@/` e caminho relativo. O grafo para em 200 arquivos — o suficiente para
 *  componentes da tela, sem arrastar o app inteiro. */
const IMPORTACAO = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;

function resolverModulo(base: string): string | undefined {
  for (const e of EXTS) if (existsSync(base + e)) return base + e;
  for (const e of EXTS) if (existsSync(path.join(base, "index" + e))) return path.join(base, "index" + e);
  return undefined;
}

function fonteDaTela(pagina: string): string[] {
  const vistos: string[] = [];
  const fila = [pagina];
  while (fila.length > 0 && vistos.length < 200) {
    const arquivo = fila.shift()!;
    if (vistos.includes(arquivo) || !existsSync(arquivo)) continue;
    vistos.push(arquivo);
    const fonte = readFileSync(arquivo, "utf8");
    IMPORTACAO.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORTACAO.exec(fonte)) !== null) {
      const especificador = m[1]!;
      let alvo: string | undefined;
      if (especificador.startsWith("@/")) alvo = resolverModulo(path.join(RAIZ, especificador.slice(2)));
      else if (especificador.startsWith("."))
        alvo = resolverModulo(path.resolve(path.dirname(arquivo), especificador));
      if (alvo && !vistos.includes(alvo)) fila.push(alvo);
    }
  }
  return vistos;
}

/** `id="x"`, `id={'x'}`, `id={`prefixo-${…}`}` — o que o `#ancora` do CSS casa. */
function idsDaTela(pagina: string): { exatos: Set<string>; prefixos: Set<string> } {
  const exatos = new Set<string>();
  const prefixos = new Set<string>();
  for (const arquivo of fonteDaTela(pagina)) {
    for (const m of readFileSync(arquivo, "utf8").matchAll(/(?<![\w-])id=\{?["'`]([^"'`]*)["'`]\}?/g)) {
      const valor = m[1]!;
      if (valor.includes("${")) prefixos.add(valor.slice(0, valor.indexOf("${")));
      else exatos.add(valor);
    }
  }
  return { exatos, prefixos };
}

/** Rota efetiva de cada passo: o passo herda a rota do último passo que abriu
 *  uma. Sem isso, `antes: rolar #x` de um passo sem `rota` não teria tela. */
function rotaEfetiva(): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const modulo of modulos) {
    for (const licao of modulo.licoes) {
      let atual: string | undefined;
      for (const passo of licao.passos) {
        if (passo.rota) atual = passo.rota;
        if (atual) mapa.set(`${modulo.id}::${licao.id}::${passo.id}`, atual);
      }
    }
  }
  return mapa;
}

type AlvoClassificado = { tipo: string; valor: string };

/** Tipo e literal de um alvo, na mesma ordem de preferência do contrato. */
function classificar(alvo: Alvo): AlvoClassificado | undefined {
  for (const tipo of ["testid", "rotulo", "placeholder", "texto"] as const) {
    const valor = alvo[tipo];
    if (typeof valor === "string") return { tipo, valor };
  }
  if (alvo.role !== undefined) {
    const nome = alvo.nome;
    return typeof nome === "string" ? { tipo: "role-nome", valor: nome } : undefined;
  }
  const css = alvo.css;
  if (typeof css === "string") {
    const id = /#([A-Za-z0-9_-]+)/.exec(css);
    if (id) return { tipo: "css-id", valor: id[1]! };
    const texto = /:text-is\('([^']*)'\)/.exec(css);
    if (texto) return { tipo: "css-texto", valor: texto[1]! };
  }
  return undefined;
}

const efetiva = rotaEfetiva();

type Pendencia = { chave: string; motivo: string };

type AlvoDoCurso = { chave: string; modulo: string; licao: string; passo: string; campo: string; indice: number; alvo: Alvo };

/** A chave leva a LIÇÃO: os ids de passo (`p2`, `p3`…) se repetem entre as
 *  lições de um módulo, e sem ela uma entrada de dívida de uma lição escondia
 *  alvo quebrado de outra (medido no #4826: 398 entradas cobriam 1.034 alvos). */
function chaveDoAlvo(a: { modulo: string; licao: string; passo: string; campo: string; indice: number }): string {
  return `${a.modulo}::${a.licao}::${a.passo}::${a.campo}::${a.indice}`;
}

function alvosDoCurso(): AlvoDoCurso[] {
  const lista: AlvoDoCurso[] = [];
  for (const modulo of modulos) {
    for (const licao of modulo.licoes) {
      for (const passo of licao.passos) {
        const empurrar = (campo: string, indice: number, alvo: Alvo | undefined) => {
          if (!alvo) return;
          const ref = { modulo: modulo.id, licao: licao.id, passo: passo.id, campo, indice };
          lista.push({
            ...ref,
            chave: chaveDoAlvo(ref),
            alvo,
          });
        };
        passo.destaques?.forEach((d, i) => empurrar("destaque", i, d.alvo));
        passo.antes?.forEach((a, i) => empurrar("antes", i, a.alvo));
        empurrar("clicar", 0, passo.clicar);
      }
    }
  }
  return lista;
}

const ALVOS = alvosDoCurso();

const divida = JSON.parse(readFileSync(DIVIDA, "utf8")) as {
  motivos: Record<string, string>;
  alvos: Array<{ modulo: string; licao: string; passo: string; campo: string; indice: number; tipo: string }>;
};
const CHAVES_DA_DIVIDA = divida.alvos.map(chaveDoAlvo);
const CHAVES_EM_DIVIDA = new Set(CHAVES_DA_DIVIDA);

/** O literal que o fonte teria de conter, quando o alvo é conferível e o fonte
 *  NÃO o contém; `undefined` quando o alvo está provado ou fora do alcance da
 *  cerca (sem literal classificável, ou `regex`). Papel ARIA fica à parte. */
function semProvaNoFonte(alvo: Alvo): AlvoClassificado | undefined {
  const classificado = classificar(alvo);
  if (!classificado || alvo.regex) return undefined;
  return existeNoFonte(classificado.valor) ? undefined : classificado;
}

describe("toda lição do curso aponta para uma tela que existe", () => {
  it("leu o curso inteiro — o piso que impede o verde vazio", () => {
    const comRota = passos.filter((p) => p.rota !== undefined);
    const destaques = passos.reduce((n, p) => n + (p.destaques?.length ?? 0), 0);
    const antes = passos.reduce((n, p) => n + (p.antes?.length ?? 0), 0);
    const rolagens = passos.reduce(
      (n, p) => n + (p.antes ?? []).filter((a) => a.acao === "rolar" && /#[A-Za-z0-9_-]+/.test(a.alvo?.css ?? "")).length,
      0,
    );
    expect(modulos.length).toBeGreaterThanOrEqual(PISO.modulos);
    expect(modulos.reduce((n, m) => n + m.licoes.length, 0)).toBeGreaterThanOrEqual(PISO.licoes);
    expect(passos.length).toBeGreaterThanOrEqual(PISO.passos);
    expect(comRota.length).toBeGreaterThanOrEqual(PISO.passosComRota);
    expect(new Set(comRota.map((p) => p.rota!)).size).toBeGreaterThanOrEqual(PISO.rotasUnicas);
    expect(destaques).toBeGreaterThanOrEqual(PISO.rastersDeDestaque);
    expect(antes).toBeGreaterThanOrEqual(PISO.acoesAntes);
    expect(rolagens).toBeGreaterThanOrEqual(PISO.rolagensComAncora);
    expect(PADROES.length).toBeGreaterThan(50);
    expect(ALVOS.length).toBeGreaterThanOrEqual(PISO.alvosNoCurso);
  });

  it("todo Passo.rota existe na árvore app/ ou no catálogo de navegação", () => {
    const comRota = passos.filter((p) => p.rota !== undefined);
    const quebradas = comRota
      .filter((p) => !PADROES.some((padrao) => casaRota(p.rota!, padrao)))
      .map((p) => `${p.rota} (passo ${p.id})`);
    expect(quebradas, `rotas citadas por lições e ausentes do app:\n${quebradas.slice(0, 20).join("\n")}`).toEqual([]);
  });

  it("toda rolagem por #ancora encontra o id no fonte da tela daquela rota", () => {
    const quebradas: string[] = [];
    for (const modulo of modulos) {
      for (const licao of modulo.licoes) {
        for (const passo of licao.passos) {
          const rota = efetiva.get(`${modulo.id}::${licao.id}::${passo.id}`);
          const pagina = rota ? paginaDaRota(rota) : undefined;
          for (const acao of passo.antes ?? []) {
            if (acao.acao !== "rolar") continue;
            const ancora = /#([A-Za-z0-9_-]+)/.exec(acao.alvo?.css ?? "");
            if (!ancora) continue;
            const id = ancora[1]!;
            if (!pagina) {
              quebradas.push(`${modulo.id}/${passo.id}: rota "${rota ?? "?"}" não tem page.tsx`);
              continue;
            }
            const { exatos, prefixos } = idsDaTela(pagina);
            const achou = exatos.has(id) || [...prefixos].some((p) => p.length > 3 && id.startsWith(p));
            if (!achou) quebradas.push(`${modulo.id}/${passo.id}: #${id} não existe em ${path.relative(RAIZ, pagina)}`);
          }
        }
      }
    }
    expect(quebradas, `âncoras sem id na tela:\n${quebradas.slice(0, 20).join("\n")}`).toEqual([]);
  });

  it("todo destaque, ação e clique aponta para um alvo que existe no fonte", () => {
    const semProva: Pendencia[] = [];
    let conferidos = 0;
    for (const { chave, campo, alvo } of ALVOS) {
      if (alvo.role !== undefined && !PAPEIS_ARIA.has(alvo.role)) {
        semProva.push({ chave, motivo: `role "${alvo.role}" não é papel ARIA` });
        continue;
      }
      if (!classificar(alvo) || alvo.regex) continue;
      const classificado = semProvaNoFonte(alvo);
      if (!classificado) {
        conferidos += 1;
        continue;
      }
      if (CHAVES_EM_DIVIDA.has(chave)) continue;
      semProva.push({
        chave: `${chave} (${campo})`,
        motivo: `${classificado.tipo} "${classificado.valor}" não aparece em app/, components/ nem lib/`,
      });
    }
    expect(semProva, `alvos que não existem no fonte e não estão declarados em divida-de-alvos.json:\n${semProva.slice(0, 20).map((p) => `${p.chave}: ${p.motivo}`).join("\n")}`).toEqual([]);
    expect(conferidos).toBeGreaterThanOrEqual(PISO.alvosConferidos);
  });

  it("todo seletor css usa classe que existe no nosso fonte", () => {
    const { texto } = indice();
    const ausentes = new Set<string>();
    const vistas = new Set<string>();
    for (const { alvo } of ALVOS) {
      const css = alvo.css;
      if (typeof css !== "string") continue;
      for (const m of css.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)) {
        const classe = m[1]!;
        vistas.add(classe);
        if (CLASSES_DE_BIBLIOTECA[classe]) continue;
        if (!texto.includes(classe)) ausentes.add(classe);
      }
    }
    expect(vistas.size).toBeGreaterThanOrEqual(PISO.tokensDeClasse);
    expect([...ausentes], `classes de css que não existem no fonte nem estão declaradas: ${[...ausentes].join(", ")}`).toEqual([]);
  });

  it("a dívida declarada tem motivo por tipo e não esconde alvo novo", () => {
    expect(divida.alvos.length).toBeLessThanOrEqual(PISO.alvosEmDivida);
    const semMotivo = divida.alvos.filter((a) => !divida.motivos[a.tipo]);
    expect(semMotivo).toEqual([]);
    const tipos = new Set(divida.alvos.map((a) => a.tipo));
    for (const tipo of tipos) expect(divida.motivos[tipo]?.length ?? 0).toBeGreaterThan(20);
    // Entrada repetida conta duas vezes no teto e cobre um alvo só.
    expect(new Set(CHAVES_DA_DIVIDA).size).toBe(divida.alvos.length);
    // Entrada velha (alvo apagado, ou que passou a existir no fonte) abre vaga
    // no teto para um alvo quebrado novo entrar sem ninguém ver.
    const porChave = new Map(ALVOS.map((a) => [a.chave, a.alvo]));
    const velhas = divida.alvos
      .filter((a) => {
        const alvo = porChave.get(chaveDoAlvo(a));
        return !alvo || semProvaNoFonte(alvo)?.tipo !== a.tipo;
      })
      .map(chaveDoAlvo);
    expect(velhas, `entradas de divida-de-alvos.json sem alvo correspondente, ou cujo alvo já existe no fonte:\n${velhas.slice(0, 20).join("\n")}`).toEqual([]);
  });
});
