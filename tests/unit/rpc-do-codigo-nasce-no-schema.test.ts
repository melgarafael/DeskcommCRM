/**
 * TODO `.rpc("nome")` DO CÓDIGO TEM DE NASCER NO SCHEMA VERSIONADO.
 *
 * ## O defeito que este gate fecha
 *
 * O nome da RPC é uma STRING. `typecheck`, `lint`, `test:unit`, `invariants`,
 * `build` e `e2e` passam todos com um nome que o banco não conhece — e o defeito
 * só aparece no clique, quando o PostgREST devolve `PGRST202` e o tratamento de
 * erro do chamador quase nunca previu esse código. Foi assim que a "zona de
 * perigo" de Configurações › Organização ficou com um botão que só sabia
 * responder `db_error` (issue #564, filha do #556).
 *
 * ## Por que aqui, em `tests/unit`, e não em `pnpm test:db`
 *
 * A checagem é ESTÁTICA: texto de código × arquivos `.sql` versionados. Não abre
 * conexão, não toca banco. O job `verify` do CI roda `pnpm test:unit` sem
 * Postgres nenhum — é exatamente onde um gate de nome órfão pega o PR.
 *
 * ## As duas armadilhas, medidas (não são hipótese)
 *
 * 1. COMENTÁRIO. Sem descartar comentário o gate nasce VERMELHO por falso
 *    ausente: `fn_admin_ai_budget_warning_count` aparece em
 *    `app/api/v1/admin/dashboard/kpis/route.ts:81` só como `//`, a chamada saiu
 *    no 4aa65590e e a função não existe (zero ocorrências em `supabase/` e zero
 *    em `lib/database.types.ts`). A segunda menção é comentário de bloco, já
 *    inofensiva: `fn_encrypt_oauth` em
 *    `app/api/v1/agenda/google/callback/route.ts:12` (a função EXISTE, em
 *    `supabase/baseline.sql:295`) — mas se o gate não descartasse o bloco, o
 *    nome entraria na varredura como chamada viva. Os dois casos têm controle
 *    próprio abaixo.
 * 2. IDENTIFICADOR CITADO. O `pg_dump` escreve
 *    `CREATE OR REPLACE FUNCTION "public"."fn_x"(`. Um extrator que só entenda
 *    `public.fn_x(` perde a forma citada e devolve falso ausente em massa — é a
 *    forma que o baseline usa aos montes. O extrator aqui aceita as três, e o
 *    controle abaixo ASSERTA que a forma citada continua sendo exercitada, para
 *    que uma migração futura não possa apagar a cobertura em silêncio.
 *
 * ## Fora do escopo, de propósito
 *
 * Nome passado por VARIÁVEL fica fora: `.rpc(nome, ...)` não tem literal para
 * cruzar. Hoje são 3 sítios — `app/api/v1/cron/data-retention/route.ts:128`,
 * `app/api/v1/cron/data-retention/route.ts:244` e
 * `lib/agenda/google/sync-store.ts:62`. Cobri-los exigiria análise de fluxo; o
 * gate prefere dizer o que não vê a fingir que vê. Os quatro nomes que a união
 * de `data-retention` pode passar (`fn_podar_fila_de_jobs`,
 * `fn_expurgar_auditoria_vencida`, `fn_expurgar_espelho_da_agenda`,
 * `fn_expurgar_nonces_de_oauth`) estão declarados no schema — sem buraco vivo
 * hoje, apenas sem rede.
 *
 * ## O gate não nasce vazio
 *
 * Um gate que varre e não acha nada é indistinguível de um gate quebrado. Por
 * isso: controle positivo do lado do código (dois nomes chamados de verdade),
 * controle positivo do lado do SQL (três nomes declarados de verdade), controle
 * do caso multi-linha (`.rpc(` e o nome em linhas diferentes — o formato exato
 * do sítio do #556), controle das duas armadilhas e a partição de caracteres do
 * scanner (`código | comentário | string`, todo caractere exatamente uma vez).
 */

import { readdirSync, readFileSync, type Dirent } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Onde o gate olha
// ─────────────────────────────────────────────────────────────────────────────

const RAIZ = process.cwd();
// `scripts` entra porque hoje é de graça (zero `.rpc(` lá) e amanhã não seria: um
// script que chame uma função inexistente falha na mão de quem opera, longe de
// qualquer gate. Medido ao integrar: `git grep -c '\.rpc(' -- scripts/` → 0.
const DIRS_DE_CODIGO = ["app", "lib", "workers", "components", "hooks", "scripts"];
const SUPABASE = "supabase";
const BASELINE = "supabase/baseline.sql";

// ─────────────────────────────────────────────────────────────────────────────
// As três chamadas congeladas: existem no código, NÃO existem no schema
// ─────────────────────────────────────────────────────────────────────────────
//
// Toda entrada precisa do motivo escrito e do `arquivo:linha` do CAMINHO DE
// DEGRADAÇÃO — o ponto onde a chamada falha e o produto segue de pé. A lista só
// encolhe: se o nome virar função de verdade numa migração, o teste fica
// vermelho pedindo a remoção daqui (é o `it` abaixo que faz isso).

const CONGELADAS: Record<string, { degradacao: string; porque: string }> = {
  decrypt_cpf: {
    degradacao: "app/api/v1/contacts/_handler.ts:324",
    porque:
      "A chamada já está prevista para não existir: se o erro volta, o handler " +
      "loga `decrypt_cpf RPC unavailable` e a resposta segue SEM CPF — o contato " +
      "não quebra. Criar a RPC no banco é decisão de produto, não deste gate.",
  },
  encrypt_cpf: {
    degradacao: "lib/contacts/cpf.ts:36",
    porque:
      "O caminho de degradação está escrito na própria função: sem a RPC, loga " +
      "`encrypt_cpf RPC unavailable — storing cpf_hash only` e devolve `null`, e " +
      "o contato é gravado só com o hash. Mesma decisão de produto, fora do gate.",
  },
  jsonb_set_last_alarm_at: {
    degradacao: "lib/lgpd/sla-alarm.ts:203",
    porque:
      "Existe fallback explícito no mesmo `try`: com erro na RPC, o alarme de SLA " +
      "faz o `update` cru em `lgpd_requests` com o filtro de organização na query. " +
      "A chamada é opcional por desenho — o gate não força a criação dela.",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Controles: nomes que a varredura TEM de ver, senão ela não vê nada
// ─────────────────────────────────────────────────────────────────────────────

const CONTROLES_NO_CODIGO = [
  "fn_user_role_in_org", // app/api/v1/contacts/_handler.ts
  "fn_conversation_assign", // app/api/v1/conversations/[id]/assign/route.ts
];

const CONTROLES_NO_SCHEMA = [
  ...CONTROLES_NO_CODIGO,
  // Sem chamada literal no código (é um dos nomes que o sítio dinâmico de
  // `data-retention` pode passar), mas com obrigação de continuar declarada:
  "fn_expurgar_auditoria_vencida",
];

// ─────────────────────────────────────────────────────────────────────────────
// Scanner: separa código, comentário e string num passe só
// ─────────────────────────────────────────────────────────────────────────────
//
// Três projeções de MESMO tamanho que o original; cada caractere vive em
// exatamente uma delas (o `it` da partição confere isso). O passe é por
// caractere e não por linha de propósito: cortar `//` de forma ingênua decapita
// `https://` dentro de string — há 126 linhas com `https://` nos diretórios
// varridos hoje, e nenhuma delas tem `.rpc(` junto, mas a linha de amanhã não
// tem essa obrigação.

type Projecoes = { codigo: string; comentario: string; texto: string };

type Modo = "codigo" | "linha" | "bloco" | "simples" | "dupla" | "crase" | "dolar";

// `ts` entende `//`, `/* */` e as três aspas. `sql` entende `--`, `/* */`,
// literal entre `'` (com `''` de escape) e corpo entre `$tag$…$tag$`; e NÃO
// trata `"` como string: em SQL a aspa dupla delimita IDENTIFICADOR, e é
// exatamente a forma que o `pg_dump` usa para declarar função
// (`CREATE OR REPLACE FUNCTION "public"."fn_x"(`). Tratar `"` como string ali
// apaga o nome da função e o lado do schema nasce vazio.
type Linguagem = "ts" | "sql";

function projetar(fonte: string, linguagem: Linguagem = "ts"): Projecoes {
  const codigo = fonte.split("");
  const comentario = new Array<string>(fonte.length).fill(" ");
  const texto = new Array<string>(fonte.length).fill(" ");
  let modo: Modo = "codigo";
  let fechaDolar = "";

  for (let i = 0; i < fonte.length; i += 1) {
    const c = fonte.charAt(i);
    const prox = fonte.charAt(i + 1);

    if (modo === "codigo") {
      const abreLinha = linguagem === "sql" ? c === "-" && prox === "-" : c === "/" && prox === "/";
      if (abreLinha) {
        codigo[i] = " ";
        codigo[i + 1] = " ";
        comentario[i] = c;
        comentario[i + 1] = prox;
        modo = "linha";
        i += 1;
        continue;
      }
      if (c === "/" && prox === "*") {
        codigo[i] = " ";
        codigo[i + 1] = " ";
        comentario[i] = c;
        comentario[i + 1] = prox;
        modo = "bloco";
        i += 1;
        continue;
      }
      if (linguagem === "sql") {
        if (c === "$") {
          const fecha = /^\$[A-Za-z0-9_]*\$/.exec(fonte.slice(i))?.[0];
          if (fecha) {
            fechaDolar = fecha;
            modo = "dolar";
            for (let k = 0; k < fecha.length; k += 1) {
              texto[i + k] = fecha.charAt(k);
              codigo[i + k] = " ";
            }
            i += fecha.length - 1;
            continue;
          }
        }
        if (c === "'") {
          modo = "simples";
          codigo[i] = " ";
          texto[i] = c;
        }
        continue; // `"` continua em `codigo`: identificador, não string
      }
      if (c === "'") modo = "simples";
      else if (c === '"') modo = "dupla";
      else if (c === "`") modo = "crase";
      if (modo !== "codigo") {
        // O próprio delimitador pertence à string. Se ele ficasse em `codigo`,
        // a aspa de ABERTURA de um sítio casaria com a aspa de abertura do
        // sítio seguinte e todo o trecho entre os dois viraria "nome" — é
        // assim que um extrator por regex nasce falso-ausente em massa.
        codigo[i] = " ";
        texto[i] = c;
      }
      continue;
    }

    if (modo === "linha") {
      if (c === "\n") {
        modo = "codigo";
        continue;
      }
      codigo[i] = " ";
      comentario[i] = c;
      continue;
    }

    if (modo === "bloco") {
      if (c === "*" && prox === "/") {
        codigo[i] = " ";
        codigo[i + 1] = " ";
        comentario[i] = c;
        comentario[i + 1] = prox;
        i += 1;
        modo = "codigo";
        continue;
      }
      // Inclusive `\n`: sem apagar em `codigo` o caractere nasce em DUAS
      // projeções e a partição do teste seguinte fica vermelha.
      codigo[i] = " ";
      comentario[i] = c;
      continue;
    }

    if (modo === "dolar") {
      if (fonte.startsWith(fechaDolar, i)) {
        for (let k = 0; k < fechaDolar.length; k += 1) {
          texto[i + k] = fechaDolar.charAt(k);
          codigo[i + k] = " ";
        }
        i += fechaDolar.length - 1;
        modo = "codigo";
        fechaDolar = "";
        continue;
      }
      texto[i] = c;
      codigo[i] = " ";
      continue;
    }

    // Dentro de string: o caractere pertence ao texto. Em `ts` a barra
    // invertida escapa o delimitador seguinte; em SQL quem escapa é `''`.
    texto[i] = c;
    codigo[i] = " ";
    if (c === "\\" && linguagem === "ts") {
      const escapado = fonte.charAt(i + 1);
      if (escapado) {
        texto[i + 1] = escapado;
        codigo[i + 1] = " ";
        i += 1;
      }
      continue;
    }
    if (linguagem === "sql" && c === "'" && prox === "'") {
      texto[i + 1] = prox;
      codigo[i + 1] = " ";
      i += 1;
      continue;
    }
    if ((modo === "simples" && c === "'") || (modo === "dupla" && c === '"') || (modo === "crase" && c === "`")) {
      modo = "codigo";
    }
  }

  return { codigo: codigo.join(""), comentario: comentario.join(""), texto: texto.join("") };
}

// ─────────────────────────────────────────────────────────────────────────────
// Coleta
// ─────────────────────────────────────────────────────────────────────────────

function listar(dir: string, extensao: RegExp): string[] {
  const achados: string[] = [];
  let entradas: Dirent[];
  try {
    entradas = readdirSync(path.join(RAIZ, dir), { withFileTypes: true });
  } catch {
    return achados; // o diretório pode não existir no checkout — não é erro do gate
  }
  for (const entrada of entradas) {
    if (entrada.name.startsWith(".") || entrada.name === "node_modules") continue;
    const relativo = `${dir}/${entrada.name}`;
    if (entrada.isDirectory()) achados.push(...listar(relativo, extensao));
    else if (extensao.test(entrada.name)) achados.push(relativo);
  }
  return achados;
}

function ler(relativo: string): string {
  return readFileSync(path.join(RAIZ, relativo), "utf8");
}

function linhaEm(texto: string, posicao: number): number {
  return texto.slice(0, posicao).split("\n").length;
}

type Chamada = { nome: string; arquivo: string; linha: number; linhaDaChamada: number };

// `.rpc(` é procurado SÓ na projeção de código: comentário e string já são
// espaço ali, então um nome que existe apenas em comentário
// (`fn_admin_ai_budget_warning_count` em
// `app/api/v1/admin/dashboard/kpis/route.ts`) não entra na conta.
//
// O nome, porém, NÃO se lê da projeção — a projeção apaga o conteúdo da string
// de propósito. Ele é lido do ARQUIVO, na posição para onde a projeção aponta.
// É isso que permite `.rpc(` no fim de uma linha e o nome na seguinte (o sítio
// do #556) sem que o extrator invente nome: quando o que vem depois de `(` não
// é literal, a chamada é classificada como dinâmica, nunca como ausente.
const RE_ABRE = /\.rpc\s*\(/g;

const DELIMITADORES = ["'", '"', "`"];

// Lê o literal que começa em `inicio` DO ARQUIVO. Devolve `null` quando não é
// literal (variável, chamada, template com interpolação) ou quando o literal
// não fecha: nome de RPC não atravessa linha.
function lerLiteral(fonte: string, inicio: number): string | null {
  const delim = fonte.charAt(inicio);
  if (!DELIMITADORES.includes(delim)) return null;
  let nome = "";
  for (let i = inicio + 1; i < fonte.length; i += 1) {
    const c = fonte.charAt(i);
    if (c === "\\") {
      nome += fonte.charAt(i + 1);
      i += 1;
      continue;
    }
    if (c === delim) return nome.includes("${") ? null : nome;
    if (c === "\n") return null;
    nome += c;
  }
  return null;
}

// Pula um comentário que esteja entre o `(` e o literal (`.rpc(/* c */ "nome")`).
// Sem isto a chamada cairia em `dinamicas` e o gate ficaria falso-verde.
function pularComentario(fonte: string, posicao: number): number {
  if (fonte.startsWith("//", posicao)) {
    const fim = fonte.indexOf("\n", posicao);
    return fim === -1 ? fonte.length : fim + 1;
  }
  if (fonte.startsWith("/*", posicao)) {
    const fim = fonte.indexOf("*/", posicao + 2);
    return fim === -1 ? fonte.length : fim + 2;
  }
  return posicao;
}

function varrerCodigo(): { chamadas: Chamada[]; dinamicas: Chamada[]; cruas: number } {
  const chamadas: Chamada[] = [];
  const dinamicas: Chamada[] = [];
  let cruas = 0;

  for (const arquivo of DIRS_DE_CODIGO.flatMap((d) => listar(d, /\.(ts|tsx)$/))) {
    const fonte = ler(arquivo);
    const { codigo } = projetar(fonte);
    cruas += codigo.match(RE_ABRE)?.length ?? 0;

    for (const m of codigo.matchAll(RE_ABRE)) {
      const inicio = m.index ?? 0;
      const linhaDaChamada = linhaEm(fonte, inicio);

      // Pula espaço REAL: a posição precisa ser branca na projeção E no
      // arquivo, senão um trecho de string/comentário (branco na projeção, com
      // conteúdo no arquivo) seria atravessado.
      let j = inicio + m[0].length;
      for (;;) {
        while (j < fonte.length && /\s/.test(fonte.charAt(j)) && /\s/.test(codigo.charAt(j))) j += 1;
        const depoisDoComentario = pularComentario(fonte, j);
        if (depoisDoComentario === j) break;
        j = depoisDoComentario;
      }

      const nome = lerLiteral(fonte, j);
      if (nome === null) {
        dinamicas.push({ arquivo, nome: "(dinâmico)", linha: linhaEm(fonte, j), linhaDaChamada });
        continue;
      }
      chamadas.push({ arquivo, nome, linha: linhaEm(fonte, j), linhaDaChamada });
    }
  }

  return { chamadas, dinamicas, cruas };
}

type Declaracoes = {
  nomes: Set<string>;
  citada: Set<string>;
  colada: Set<string>;
  semEsquema: Set<string>;
  foraDePublic: Set<string>;
};

// O `pg_dump` escreve (1) `"public"."fn_x"(`, (2) `public.fn_x(` e, nas
// migrações escritas à mão, (3) `fn_x(`. As três contam. Declaração em schema
// que NÃO é `public` fica de fora: o `.rpc()` resolve no schema exposto.
const RE_DECLARACAO = /create\s+(?:or\s+replace\s+)?function\s+([A-Za-z0-9_".]+)\s*\(/gi;

function varrerSchema(): Declaracoes {
  const arquivos = [BASELINE, ...listar(`${SUPABASE}/migrations`, /\.sql$/)];
  const d: Declaracoes = {
    nomes: new Set(),
    citada: new Set(),
    colada: new Set(),
    semEsquema: new Set(),
    foraDePublic: new Set(),
  };

  for (const arquivo of arquivos) {
    const { codigo } = projetar(ler(arquivo), "sql");
    for (const m of codigo.matchAll(RE_DECLARACAO)) {
      const bruto = m[1] ?? "";
      const partes = bruto.split(".").map((p) => p.replace(/"/g, ""));
      const nome = partes[partes.length - 1] ?? "";
      if (!nome) continue;
      if (partes.length > 1 && (partes[0] ?? "") !== "public") {
        d.foraDePublic.add(bruto.replace(/"/g, ""));
        continue;
      }
      d.nomes.add(nome);
      if (partes.length === 1) d.semEsquema.add(nome);
      else if (bruto.includes('"')) d.citada.add(nome);
      else d.colada.add(nome);
    }
  }

  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
// O gate
// ─────────────────────────────────────────────────────────────────────────────

const { chamadas, dinamicas } = varrerCodigo();
const schema = varrerSchema();

describe("todo `.rpc(\"nome\")` do código nasce no schema versionado", () => {
  it("controle positivo: a varredura do código acha as chamadas que existem", () => {
    expect(chamadas.length).toBeGreaterThan(100);

    const nomes = new Set(chamadas.map((c) => c.nome));
    for (const controle of CONTROLES_NO_CODIGO) {
      expect(
        nomes.has(controle),
        `a varredura não viu \`${controle}\`, que é chamada literal no código — o extrator quebrou`,
      ).toBe(true);
    }
  });

  it("controle positivo: a varredura do schema acha as declarações que existem", () => {
    expect(schema.nomes.size).toBeGreaterThan(100);

    for (const controle of CONTROLES_NO_SCHEMA) {
      expect(
        schema.nomes.has(controle),
        `\`${controle}\` não foi vista no schema — o extrator do .sql quebrou (ou a função foi removida)`,
      ).toBe(true);
    }
  });

  it("controle: nome entre `.rpc(` e a linha seguinte continua sendo lido (sítio do #556)", () => {
    const multiLinha = chamadas.filter((c) => c.linha !== c.linhaDaChamada);
    expect(
      multiLinha.length,
      "nenhuma chamada multi-linha foi reconhecida: o `.rpc(` e o nome em linhas diferentes é o formato do #556 e não pode ficar invisível",
    ).toBeGreaterThan(0);
  });

  it("armadilha (1): menção em comentário não conta como chamada — `//` e `/* */`", () => {
    const nomes = new Set(chamadas.map((c) => c.nome));

    // `//` — a menção existe no arquivo e NÃO pode virar chamada.
    const linha = ler("app/api/v1/admin/dashboard/kpis/route.ts").split("\n")[80] ?? "";
    expect(linha, "a menção de controle mudou de lugar — atualize este teste e o cabeçalho").toContain(
      "fn_admin_ai_budget_warning_count",
    );
    expect(linha).toContain("//");
    expect(nomes.has("fn_admin_ai_budget_warning_count")).toBe(false);
    expect(schema.nomes.has("fn_admin_ai_budget_warning_count")).toBe(false);

    // `/* */` — a menção existe no arquivo, em bloco, e também não pode contar.
    const bloco = ler("app/api/v1/agenda/google/callback/route.ts");
    expect(bloco).toContain("fn_encrypt_oauth");
    const semBloco = projetar(bloco).codigo;
    expect(semBloco).not.toContain("fn_encrypt_oauth");
  });

  it("armadilha (2): identificador citado (`\"public\".\"fn_x\"`) segue sendo exercitado", () => {
    expect(
      schema.citada.size,
      "nenhuma declaração na forma citada do pg_dump: um extrator que só entenda `public.fn_x(` volta a nascer falso-ausente",
    ).toBeGreaterThan(0);
    expect(schema.colada.size).toBeGreaterThan(0);
  });

  it("o scanner não come código: `//` dentro de string com URL sobrevive", () => {
    const citados: { arquivo: string; linha: number; conteudo: string }[] = [];
    for (const arquivo of DIRS_DE_CODIGO.flatMap((d) => listar(d, /\.(ts|tsx)$/))) {
      if (citados.length >= 5) break;
      const { texto, comentario } = projetar(ler(arquivo));
      const linhasDeComentario = comentario.split("\n");
      for (const [i, conteudo] of texto.split("\n").entries()) {
        const url = /https:\/\/[^\s"'`)]+/.exec(conteudo)?.[0];
        if (url === undefined) continue;
        // Se o `//` da URL tivesse aberto comentário, o corpo da URL estaria na
        // projeção de comentário — e o resto do arquivo teria sido comido.
        expect(
          (linhasDeComentario[i] ?? "").includes(url),
          `${arquivo}:${i + 1} — o \`//\` da URL dentro de string virou abertura de comentário`,
        ).toBe(false);
        citados.push({ arquivo, linha: i + 1, conteudo });
        break;
      }
    }

    expect(citados.length, "nenhuma URL em string para servir de controle").toBeGreaterThan(0);
    for (const { arquivo, linha, conteudo } of citados) {
      expect(
        conteudo.includes("://"),
        `${arquivo}:${linha} — o corte descartou o corpo da string`,
      ).toBe(true);
    }
  });

  it("partição de caracteres: código, comentário e string cobrem o arquivo uma vez cada", () => {
    const amostra = [
      ...DIRS_DE_CODIGO.flatMap((d) => listar(d, /\.(ts|tsx)$/)).slice(0, 40),
      BASELINE,
      `${SUPABASE}/migrations/${(listar(`${SUPABASE}/migrations`, /\.sql$/)[0] ?? "").split("/").pop() ?? ""}`,
    ];

    for (const arquivo of amostra) {
      const fonte = ler(arquivo);
      const { codigo, comentario, texto } = projetar(fonte, arquivo.endsWith(".sql") ? "sql" : "ts");
      expect(codigo.length).toBe(fonte.length);
      expect(comentario.length).toBe(fonte.length);
      expect(texto.length).toBe(fonte.length);

      let perdidos = 0;
      let duplicados = 0;
      for (let i = 0; i < fonte.length; i += 1) {
        const c = fonte.charAt(i);
        if (c === " " || c === "\n" || c === "\t") continue;
        const donos = [codigo, comentario, texto].filter((p) => p.charAt(i) === c).length;
        if (donos === 0) perdidos += 1;
        if (donos > 1) duplicados += 1;
      }
      expect(`${perdidos}/${duplicados}`, `${arquivo}: 0/0 — caractere perdido ou contado duas vezes no scanner`).toBe(
        "0/0",
      );
    }
  });

  it("nenhum nome chamado fica órfão do schema (fora da allowlist)", () => {
    const orfas = chamadas.filter((c) => !schema.nomes.has(c.nome) && !(c.nome in CONGELADAS));
    if (orfas.length === 0) return;

    const porNome = new Map<string, string[]>();
    for (const o of orfas) {
      const sítios = porNome.get(o.nome) ?? [];
      sítios.push(`${o.arquivo}:${o.linha}`);
      porNome.set(o.nome, sítios);
    }

    const relatorio = [...porNome.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([nome, sítios]) => `  ${nome}  (${sítios.join(", ")})`)
      .join("\n");

    throw new Error(
      `\n\n${porNome.size} nome(s) de \`.rpc()\` sem declaração em \`${BASELINE}\` nem em \`${SUPABASE}/migrations/\`:\n\n` +
        `${relatorio}\n\n` +
        "O PostgREST responde `PGRST202` no clique (function not found) e o erro quase nunca é tratado.\n" +
        "Conserte de um dos dois lados:\n" +
        "  · crie/renomeie a função numa migração, ou\n" +
        "  · aponte a chamada para o nome que existe no schema, ou\n" +
        `  · se a ausência é deliberada e o caminho de degradação está escrito, adicione a entrada em CONGELADAS\n` +
        `    neste arquivo com o motivo e o \`arquivo:linha\` da degradação.\n`,
    );
  });

  it("a allowlist só encolhe: cada congelada ainda é chamada, ainda falta, e ainda tem motivo", () => {
    for (const [nome, entrada] of Object.entries(CONGELADAS)) {
      const sítios = chamadas.filter((c) => c.nome === nome);
      expect(
        sítios.length,
        `\`${nome}\` está na allowlist mas não é mais chamada no código (${DIRS_DE_CODIGO.join("|")}) — entrada morta, remova`,
      ).toBeGreaterThan(0);

      expect(
        schema.nomes.has(nome),
        `\`${nome}\` virou função de verdade no schema — remova a entrada da allowlist (ela só encolhe)`,
      ).toBe(false);

      expect(
        entrada.porque.trim().length,
        `\`${nome}\`: motivo escrito é obrigatório na allowlist, com o motivo e o caminho de degradação`,
      ).toBeGreaterThan(30);

      const citado = /^([\w./[\]-]+\.tsx?):(\d+)$/.exec(entrada.degradacao);
      expect(
        citado,
        `\`${nome}\`: degradação precisa ser \`arquivo:linha\` (recebido: ${entrada.degradacao})`,
      ).not.toBeNull();
      const arquivo = citado?.[1] ?? "";
      const linha = Number(citado?.[2] ?? "0");

      expect(
        sítios.some((s) => s.arquivo === arquivo),
        `\`${nome}\`: a degradação citada está em ${arquivo}, que não é um dos arquivos que chamam o nome (${sítios
          .map((s) => s.arquivo)
          .join(", ")})`,
      ).toBe(true);

      const total = ler(arquivo).split("\n").length;
      expect(
        linha,
        `\`${nome}\`: ${entrada.degradacao} passou do fim do arquivo (${total} linhas) — a citação envelheceu`,
      ).toBeLessThanOrEqual(total);
      expect(linha).toBeGreaterThan(0);
    }
  });

  it("o gate declara o que não vê: nome dinâmico continua fora do escopo", () => {
    expect(
      dinamicas.length,
      "nenhuma chamada dinâmica foi classificada: o extrator pode estar lendo variável como literal, ou o sítio documentado no cabeçalho saiu",
    ).toBeGreaterThan(0);
  });
});
