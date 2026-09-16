/**
 * Invariante de COBERTURA do vocabulário: nenhum valor de wire do follow-up
 * chega à tela sem tradução.
 *
 * A lista de valores é DERIVADA, nunca copiada: os que existem em runtime saem
 * do próprio schema Zod (`graph-schema.ts`, `api-schemas.ts`); os dois que são
 * união de tipos puros — `EnrollmentStatus` e `EnrollmentOutcome` — saem do
 * texto de `node-handlers.ts`, lido com o parser do TypeScript. Cópia à mão
 * envelhece calada: quem acrescentasse um operador veria o teste verde e a tela
 * mostrando `between` para o dono da clínica.
 *
 * Um extrator quebrado devolve lista vazia, e lista vazia passa em "todo item
 * tem tradução". Por isso cada derivação tem controle de vacuidade, e os dois
 * tipos puros ainda são conferidos contra uma fonte INDEPENDENTE (o enum de
 * `endConfigSchema`, que o motor devolve como desfecho).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import * as ts from "typescript";
import { describe, expect, it } from "vitest";

import { enumsDoFollowup } from "@/tests/support/enums-do-grafo";

import { triggerConfigSchema } from "./api-schemas";
import { conditionLabel } from "./edge-condition-options";
import {
  NO_REPLY_BRANCH_ID,
  RESERVED_BRANCH_IDS,
  actionConfigSchema,
  aiClassifyConfigSchema,
  conditionConfigSchema,
  endConfigSchema,
  waitConfigSchema,
} from "./graph-schema";
import * as vocabulario from "./vocabulario";
import {
  ALVOS_DA_CLASSIFICACAO,
  CAMPOS_DA_CONDICAO,
  COMBINADORES,
  DESFECHOS,
  ESPERA_PELA_RESPOSTA,
  GATILHOS,
  MODOS_DA_ACAO,
  MODOS_DE_ESPERA,
  MODOS_DE_RAMIFICACAO,
  RAMOS_RESERVADOS,
  RAMOS_RESERVADOS_EM_FRASE,
  RESULTADOS_DO_FIM,
  SITUACOES_DO_ACOMPANHAMENTO,
  comparador,
  comparadoresDoCampo,
  fraseDaCondicao,
  fraseDaClasse,
  fraseDaRegraNomeada,
  fraseDaRegraSemNome,
  fraseDoRamo,
  opcoes,
  type CampoDaCondicao,
  type OperadorDaCondicao,
} from "./vocabulario";

// ─── derivação: schemas Zod ──────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any -- introspecção do Zod é
   deliberadamente destipada: o ponto é ler o schema como DADO, não confiar no
   tipo que ele exporta (é justamente o tipo que a sabotagem muda junto). */
const zod = (schema: unknown): any => schema as any;

/** Valores de um `z.enum`, atravessando o `.default()` quando existe. */
function valoresDoEnum(campo: unknown): string[] {
  const s = zod(campo);
  const alvo = typeof s.unwrap === "function" ? s.unwrap() : s;
  const opts = alvo.options;
  if (!Array.isArray(opts) || opts.length === 0) {
    throw new Error("enum sem options — a introspecção do Zod mudou de forma");
  }
  return opts as string[];
}

/** Discriminantes de uma `z.discriminatedUnion` (`mode`, `kind`, …). */
function discriminantes(uniao: unknown, chave: string): string[] {
  const opts = zod(uniao).options;
  if (!Array.isArray(opts) || opts.length === 0) {
    throw new Error(`união sem options ao ler '${chave}' — a introspecção do Zod mudou de forma`);
  }
  return opts.map((o: any) => {
    const valor = o.shape?.[chave]?.value;
    if (typeof valor !== "string") throw new Error(`membro da união sem literal '${chave}'`);
    return valor;
  });
}

const checkShape = zod(conditionConfigSchema).shape.checks.element.shape;

const CAMPOS_NO_SCHEMA = valoresDoEnum(checkShape.field);
const OPERADORES_NO_SCHEMA = valoresDoEnum(checkShape.op);
const COMBINADORES_NO_SCHEMA = valoresDoEnum(zod(conditionConfigSchema).shape.combinator);
const ALVOS_NO_SCHEMA = valoresDoEnum(zod(aiClassifyConfigSchema).shape.target);
const RESULTADOS_NO_SCHEMA = valoresDoEnum(zod(endConfigSchema).shape.outcome);
const MODOS_DE_ESPERA_NO_SCHEMA = discriminantes(waitConfigSchema, "mode");
const MODOS_DA_ACAO_NO_SCHEMA = discriminantes(actionConfigSchema, "mode");
const GATILHOS_NO_SCHEMA = discriminantes(triggerConfigSchema, "kind");
const RAMIFICACAO_NO_SCHEMA = valoresDoEnum(zod(conditionConfigSchema).shape.branching);
/* eslint-enable @typescript-eslint/no-explicit-any */

// ─── derivação: uniões de tipo puro em node-handlers.ts ──────────────────

// `import.meta.url` sob jsdom não é `file://` — o caminho sai da raiz do
// projeto (o vitest roda com o cwd nela) e é conferido na hora, para que um
// arquivo movido reprove alto em vez de derivar lista vazia.
const NODE_HANDLERS = join(process.cwd(), "lib/followup/node-handlers.ts");
if (!existsSync(NODE_HANDLERS)) {
  throw new Error(`node-handlers.ts não está em ${NODE_HANDLERS} (cwd=${process.cwd()}) — derivação impossível`);
}

/**
 * Membros de `export type X = "a" | "b"`. Levanta — em vez de devolver vazio —
 * quando o alias some, muda de forma ou deixa de ser união de literais: um
 * extrator mudo devolveria `[]` e o teste passaria sem ter medido nada.
 */
function literaisDaUniao(arquivo: string, nome: string): string[] {
  const fonte = ts.createSourceFile(arquivo, readFileSync(arquivo, "utf8"), ts.ScriptTarget.Latest, true);
  let achado: string[] | null = null;
  fonte.forEachChild((no) => {
    if (!ts.isTypeAliasDeclaration(no) || no.name.text !== nome) return;
    if (!ts.isUnionTypeNode(no.type)) throw new Error(`'${nome}' em ${arquivo} não é união de literais`);
    achado = no.type.types.map((membro) => {
      if (ts.isLiteralTypeNode(membro) && ts.isStringLiteral(membro.literal)) return membro.literal.text;
      throw new Error(`'${nome}' tem membro que não é literal de string`);
    });
  });
  if (achado === null) throw new Error(`type alias '${nome}' não encontrado em ${arquivo}`);
  return achado;
}

const SITUACOES_NO_TIPO = literaisDaUniao(NODE_HANDLERS, "EnrollmentStatus");
const DESFECHOS_NO_TIPO = literaisDaUniao(NODE_HANDLERS, "EnrollmentOutcome");


/**
 * Todo par (valor de wire -> texto que o usuário lê) EXPORTADO pelo módulo, e
 * todo mapa, colhidos dos exports em vez de listados aqui.
 *
 * A lista escrita à mão que isto substitui já estava incompleta no dia em que
 * foi escrita: `MODOS_DE_RAMIFICACAO` e `RAMOS_RESERVADOS` entraram no
 * dicionário e nenhuma varredura os alcançou. É o mesmo ponto cego que a regra
 * do underscore tinha, um nível acima — a guarda cobria o que alguém lembrou de
 * inscrever nela.
 */
function mapasExportados(): Array<[string, Record<string, unknown>]> {
  // Sem predicado de tipo: `Object.entries` de um módulo devolve a UNIÃO dos
  // tipos exportados, e estreitar essa união para `Record<string, unknown>` não
  // compila (as chaves literais de cada mapa não são atribuíveis a `string`
  // genérico). Coletar e converter por entrada é o que o TypeScript aceita.
  const mapas: Array<[string, Record<string, unknown>]> = [];
  for (const [nome, valor] of Object.entries(vocabulario) as Array<[string, unknown]>) {
    if (typeof valor === "object" && valor !== null && !Array.isArray(valor)) {
      mapas.push([nome, valor as Record<string, unknown>]);
    }
  }
  return mapas;
}

function rotulosExportados(): Array<[string, string]> {
  const pares: Array<[string, string]> = [];
  for (const [, mapa] of mapasExportados()) {
    for (const [chave, conteudo] of Object.entries(mapa)) {
      if (typeof conteudo === "string") pares.push([chave, conteudo]);
      else if (
        conteudo !== null &&
        typeof conteudo === "object" &&
        typeof (conteudo as { rotulo?: unknown }).rotulo === "string"
      ) {
        pares.push([chave, (conteudo as { rotulo: string }).rotulo]);
      }
    }
  }
  return pares;
}

// ─── controles de vacuidade ──────────────────────────────────────────────

describe("o instrumento está vivo", () => {
  it("toda derivação devolveu valores", () => {
    const derivacoes = {
      CAMPOS_NO_SCHEMA,
      OPERADORES_NO_SCHEMA,
      COMBINADORES_NO_SCHEMA,
      ALVOS_NO_SCHEMA,
      RESULTADOS_NO_SCHEMA,
      MODOS_DE_ESPERA_NO_SCHEMA,
      MODOS_DA_ACAO_NO_SCHEMA,
      GATILHOS_NO_SCHEMA,
      SITUACOES_NO_TIPO,
      DESFECHOS_NO_TIPO,
    };
    for (const [nome, valores] of Object.entries(derivacoes)) {
      expect(valores.length, `${nome} veio vazio — extrator quebrado, não vocabulário completo`).toBeGreaterThan(0);
    }
  });

  it("o extrator de tipo bate com uma fonte independente do próprio arquivo", () => {
    // `processNode` devolve o `outcome` do nó final como desfecho do
    // acompanhamento (caso "end"), então todo resultado do `endConfigSchema`
    // que não seja 'custom' TEM de ser membro de EnrollmentOutcome. As duas
    // listas saem de lugares diferentes (Zod x parser de tipo): se o extrator
    // devolvesse lixo, esta igualdade não fecharia por acaso.
    const doNoFinal = RESULTADOS_NO_SCHEMA.filter((r) => r !== "custom");
    expect(doNoFinal.length).toBeGreaterThan(0);
    for (const resultado of doNoFinal) {
      expect(DESFECHOS_NO_TIPO, `'${resultado}' sai do nó final mas não é EnrollmentOutcome`).toContain(resultado);
    }
  });
});

// ─── cobertura ───────────────────────────────────────────────────────────

describe("todo valor de wire tem tradução", () => {
  const casos: Array<[string, string[], string[]]> = [
    ["campos da condição", CAMPOS_NO_SCHEMA, Object.keys(CAMPOS_DA_CONDICAO)],
    ["combinadores", COMBINADORES_NO_SCHEMA, Object.keys(COMBINADORES)],
    ["alvos da classificação", ALVOS_NO_SCHEMA, Object.keys(ALVOS_DA_CLASSIFICACAO)],
    ["resultados do nó final", RESULTADOS_NO_SCHEMA, Object.keys(RESULTADOS_DO_FIM)],
    ["modos de espera", MODOS_DE_ESPERA_NO_SCHEMA, Object.keys(MODOS_DE_ESPERA)],
    ["modos da ação", MODOS_DA_ACAO_NO_SCHEMA, Object.keys(MODOS_DA_ACAO)],
    ["tipos de gatilho", GATILHOS_NO_SCHEMA, Object.keys(GATILHOS)],
    ["situações do acompanhamento", SITUACOES_NO_TIPO, Object.keys(SITUACOES_DO_ACOMPANHAMENTO)],
    ["desfechos", DESFECHOS_NO_TIPO, Object.keys(DESFECHOS)],
    ["modos de ramificação", RAMIFICACAO_NO_SCHEMA, Object.keys(MODOS_DE_RAMIFICACAO)],
    ["ramos reservados", [...RESERVED_BRANCH_IDS], Object.keys(RAMOS_RESERVADOS)],
  ];

  it.each(casos)("%s: o dicionário cobre exatamente o que o wire define", (_nome, noWire, traduzidos) => {
    // Igualdade nos dois sentidos: falta = valor cru na tela; sobra = tradução
    // órfã de um valor que o wire não usa mais.
    expect([...traduzidos].sort()).toEqual([...noWire].sort());
  });

  it("todo par (campo, operador) tem frase — inclusive o que não se oferece mais", () => {
    for (const campo of CAMPOS_NO_SCHEMA as CampoDaCondicao[]) {
      for (const op of OPERADORES_NO_SCHEMA as OperadorDaCondicao[]) {
        const c = comparador(campo, op);
        expect(c, `par sem tradução: ${campo} + ${op}`).toBeDefined();
        expect(c.rotulo.trim().length).toBeGreaterThan(0);
        expect(fraseDaCondicao(campo, op, "x").trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("todo campo oferece pelo menos um operador, e só operadores que o schema conhece", () => {
    for (const campo of CAMPOS_NO_SCHEMA as CampoDaCondicao[]) {
      const oferecidos = comparadoresDoCampo(campo);
      expect(oferecidos.length, `campo '${campo}' sem operador oferecido`).toBeGreaterThan(0);
      for (const { op } of oferecidos) {
        expect(OPERADORES_NO_SCHEMA).toContain(op);
        expect(comparador(campo, op).oferecido).toBe(true);
      }
    }
  });
});

describe("vocabulário NOVO não entra escondido", () => {
  /**
   * O caso que motivou este bloco: o contrato v2 acrescentou `branching`
   * (`combined`/`per_check`) ao nó de condição, e a suíte continuou verde
   * porque ela conferia os valores das listas que EU tinha enumerado. Aqui a
   * pergunta é outra — existe algum `z.enum` no grafo que nenhum mapa do
   * dicionário cobre? — e ela não depende de eu lembrar da lista.
   */
  const TODOS_OS_MAPAS: Array<Record<string, unknown>> = [
    ...mapasExportados().map(([, mapa]) => mapa),
    Object.fromEntries(OPERADORES_NO_SCHEMA.map((op) => [op, true])),
  ];


  const descobertos = enumsDoFollowup();

  it("a varredura encontra os enums que sabemos existir", () => {
    // Controle: um walker quebrado devolve [] e faria o teste seguinte passar
    // sem ter olhado para nada.
    const todosOsValores = new Set(descobertos.flatMap((e) => e.valores));
    for (const conhecido of ["lead_stage", "eq", "and", "last_reply", "converted", "per_check"]) {
      expect(todosOsValores, `a varredura não achou '${conhecido}' — walker cego`).toContain(conhecido);
    }
  });

  it("todo enum do grafo é coberto por algum mapa do dicionário", () => {
    const descobertas = descobertos.filter(
      (e) => !TODOS_OS_MAPAS.some((mapa) => e.valores.every((v) => v in mapa)),
    );
    expect(
      descobertas.map((e) => `${e.caminho} = [${e.valores.join(", ")}]`),
      "vocabulário de wire sem tradução — traduza ou explique por que não é de tela",
    ).toEqual([]);
  });
});

describe("a tradução não é o valor cru disfarçado", () => {
  /**
   * Só os valores com `_`: `manual`, `custom` e `tag` são palavras legítimas em
   * português e coincidir com o wire ali não é vazamento. `waiting_reply` num
   * rótulo, é.
   */
  const rotulosPorValor: Array<[string, string]> = rotulosExportados();

  it("a colheita de rótulos alcança todos os mapas do módulo", () => {
    // Controle: colher dos exports só vale se a colheita for gorda. Um filtro
    // quebrado devolveria pouca coisa e as varreduras abaixo passariam por
    // omissão — que é exatamente como a lista à mão falhava.
    expect(rotulosPorValor.length).toBeGreaterThan(30);
    for (const esperado of ["Parou por falha", "Uma saída para cada regra", "Convertido", "Etiqueta do contato"]) {
      expect(
        rotulosPorValor.map(([, r]) => r),
        `'${esperado}' não foi colhido — algum mapa ficou fora da varredura`,
      ).toContain(esperado);
    }
  });


  it("nenhum rótulo carrega o token snake_case do wire", () => {
    const comUnderscore = rotulosPorValor.filter(([valor]) => valor.includes("_"));
    expect(comUnderscore.length, "nenhum valor com '_' para checar — o filtro parou de medir").toBeGreaterThan(0);
    for (const [valor, rotulo] of comUnderscore) {
      expect(rotulo.toLowerCase(), `rótulo de '${valor}' devolve o wire cru`).not.toContain(valor);
    }
  });

  it("nenhum rótulo é vazio", () => {
    for (const [valor, rotulo] of rotulosPorValor) {
      expect(rotulo.trim().length, `'${valor}' sem rótulo`).toBeGreaterThan(0);
    }
  });

  /**
   * Coincidências legítimas: palavras que o português usa e que por acaso são
   * iguais ao valor de wire. Cada entrada precisa de razão escrita, senão a
   * allowlist vira o lugar onde os vazamentos vão morar.
   */
  const COINCIDENCIAS_ACEITAS = new Map([
    ["manual", "'Manual' é o português de manual, e é o texto que TriggerConfigControl já mostra e o e2e seleciona."],
  ]);

  it("nenhum rótulo É o valor de wire, mesmo sem underscore", () => {
    // A regra do `_` acima não pega `gte`, `eq` nem `and` — exatamente os
    // comparadores de que o Rafael reclamou. E os rótulos dos COMPARADORES não
    // estavam em varredura nenhuma até aqui: eles não moram num Record simples.
    const tudo: Array<[string, string]> = [
      ...rotulosPorValor,
      ...(CAMPOS_NO_SCHEMA as CampoDaCondicao[]).flatMap((campo) =>
        (OPERADORES_NO_SCHEMA as OperadorDaCondicao[]).map(
          (op) => [`${campo}+${op}`, comparador(campo, op).rotulo] as [string, string],
        ),
      ),
    ];
    const wire = new Set([...CAMPOS_NO_SCHEMA, ...OPERADORES_NO_SCHEMA, ...COMBINADORES_NO_SCHEMA]);

    const crus = tudo.filter(([, rotulo]) => {
      const r = rotulo.trim().toLowerCase();
      return wire.has(r) && !COINCIDENCIAS_ACEITAS.has(r);
    });
    expect(crus.map(([onde, rotulo]) => `${onde} → "${rotulo}"`)).toEqual([]);
  });

  it("a palavra 'grace' não aparece em nada que o usuário lê", () => {
    const tudo = [
      ...rotulosPorValor.map(([, r]) => r),
      ESPERA_PELA_RESPOSTA.rotulo,
      ESPERA_PELA_RESPOSTA.ajuda,
      ...(CAMPOS_NO_SCHEMA as CampoDaCondicao[]).flatMap((campo) =>
        (OPERADORES_NO_SCHEMA as OperadorDaCondicao[]).flatMap((op) => {
          const c = comparador(campo, op);
          return [c.rotulo, c.frase("x"), c.aviso ?? ""];
        }),
      ),
    ];
    for (const texto of tudo) expect(texto).not.toMatch(/grace/i);
  });
});

// ─── as duas exigências nomeadas no briefing ─────────────────────────────

describe("etiqueta é pertinência, não igualdade", () => {
  it("tag + eq lê 'tem a etiqueta'; tag + neq, 'não tem a etiqueta'", () => {
    // `evaluateCheck` em node-handlers.ts trata `tag` como lista: `eq` testa
    // pertinência. "é igual a" prometeria outra coisa.
    expect(comparador("tag", "eq").rotulo).toBe("tem a etiqueta");
    expect(comparador("tag", "neq").rotulo).toBe("não tem a etiqueta");
    expect(fraseDaCondicao("tag", "eq", "vip")).toBe("O contato tem a etiqueta “vip”");
    expect(comparador("tag", "eq").rotulo).not.toMatch(/igual/i);
  });

  it("tag + contains diz o mesmo que eq (o motor não distingue) e não repete no seletor", () => {
    expect(comparador("tag", "contains").frase("vip")).toBe(comparador("tag", "eq").frase("vip"));
    expect(comparadoresDoCampo("tag").map((o) => o.op)).toEqual(["eq", "neq"]);
  });

  it("maior/menor em etiqueta sai do seletor e vem com aviso — o motor nunca satisfaz", () => {
    for (const op of ["gte", "lte"] as const) {
      expect(comparador("tag", op).oferecido).toBe(false);
      expect(comparador("tag", op).aviso).toBeTruthy();
    }
  });
});

describe("o ramo em frase — o registro do dossiê", () => {
  it("os quatro reservados têm frase, e o no_reply mantém o texto que a Fila já escrevia", () => {
    // O risco do v2 é silencioso: `no_reply` deixa de chegar como `class_match`
    // e vira `branch_id`, então a linha que o tratava fica órfã e a frase vira
    // o identificador — sem exceção nenhuma. Este caso é o que reprova nisso.
    expect(fraseDoRamo(NO_REPLY_BRANCH_ID)).toBe("quando ninguém responde");
    for (const ramo of RESERVED_BRANCH_IDS) {
      expect(fraseDoRamo(ramo), `ramo reservado '${ramo}' sem frase`).toBeTruthy();
      expect(fraseDoRamo(ramo) ?? "", `frase de '${ramo}' devolve o id`).not.toContain(ramo);
    }
  });

  it("classe da IA e regra do negócio têm moldes DIFERENTES — um só mentiria em metade dos casos", () => {
    // "quando a resposta é “Tem a etiqueta VIP”" não é resposta de ninguém: é
    // regra do negócio. O molde único obrigaria um dos dois lados a mentir.
    expect(fraseDaClasse("interessado")).toBe("quando a IA classifica a resposta como “interessado”");
    expect(fraseDaRegraNomeada("Cliente VIP")).toBe("quando vale a regra “Cliente VIP”");
    expect(fraseDaClasse("x")).not.toBe(fraseDaRegraNomeada("x"));
  });

  it("regra sem nome vira a condição por extenso, encaixada em minúscula", () => {
    // Sem isto sairia "quando O contato tem…" — maiúscula no meio da frase, que
    // ninguém revisa e todo mundo lê. E jamais o id: `regra-2` na tela é o
    // defeito que este módulo existe para impedir.
    expect(fraseDaRegraSemNome("tag", "eq", "vip")).toBe("quando o contato tem a etiqueta “vip”");
    expect(fraseDaRegraSemNome("steps_taken", "gte", 3)).toBe("quando o fluxo já deu pelo menos 3 passos");
  });

  it("fraseDoRamo devolve null para ramo não reservado, em vez de inventar", () => {
    // Quem chama precisa escolher o molde (classe ou regra) com o contexto do
    // NÓ, que este módulo não tem. Devolver texto aqui seria adivinhar.
    expect(fraseDoRamo("br_7f3a")).toBeNull();
    expect(fraseDoRamo(NO_REPLY_BRANCH_ID)).toBe("quando ninguém responde");
  });

  it("os dois registros dizem a mesma coisa em tons diferentes, e nenhum é cópia do outro", () => {
    for (const ramo of RESERVED_BRANCH_IDS) {
      expect(RAMOS_RESERVADOS[ramo].length, `chip de '${ramo}' vazio`).toBeGreaterThan(0);
      expect(RAMOS_RESERVADOS_EM_FRASE[ramo].length, `frase de '${ramo}' vazia`).toBeGreaterThan(0);
    }
    // Se algum dia os dois registros convergirem palavra por palavra, um dos
    // dois virou peso morto e a distinção que justifica os dois se perdeu.
    const iguais = RESERVED_BRANCH_IDS.filter((r) => RAMOS_RESERVADOS[r] === RAMOS_RESERVADOS_EM_FRASE[r]);
    expect(iguais.length, `${iguais.join(", ")} têm chip e frase idênticos — sobra um registro`).toBeLessThan(
      RESERVED_BRANCH_IDS.length,
    );
  });
});

describe("o antigo 'Grace' virou uma pergunta com consequência", () => {
  it("o mínimo declarado é exatamente o piso do schema", () => {
    const base = { classes: ["x"], target: "last_reply" as const };
    const piso = ESPERA_PELA_RESPOSTA.minimoMinutos * 60_000;
    expect(aiClassifyConfigSchema.safeParse({ ...base, grace_timeout_ms: piso }).success).toBe(true);
    expect(aiClassifyConfigSchema.safeParse({ ...base, grace_timeout_ms: piso - 1 }).success).toBe(false);
  });

  it("a ajuda nomeia o caminho que o fluxo pega, com o texto que a aresta mostra", () => {
    const rotuloDaAresta = conditionLabel({ type: "class_match", value: "no_reply" });
    expect(ESPERA_PELA_RESPOSTA.ajuda).toContain(rotuloDaAresta);
    expect(ESPERA_PELA_RESPOSTA.ajuda).toContain(String(ESPERA_PELA_RESPOSTA.minimoMinutos));
  });
});

describe("rótulos sob contrato de e2e", () => {
  it("o nó final continua dizendo Convertido/Esgotado", () => {
    // tests/e2e/followup-journey.spec.ts escolhe a opção pelo nome e confere o
    // texto no card. Trocar a palavra sem trocar o spec quebra o e2e.
    expect(RESULTADOS_DO_FIM.converted).toBe("Convertido");
    expect(RESULTADOS_DO_FIM.exhausted).toBe("Esgotado");
  });

  it("o gatilho continua dizendo Manual/Silêncio", () => {
    // tests/e2e/followup-builder.spec.ts seleciona as duas opções pelo nome exato.
    expect(GATILHOS.manual).toBe("Manual");
    expect(GATILHOS.silence).toBe("Silêncio");
  });
});

describe("opcoes()", () => {
  it("preserva a ordem de declaração do mapa", () => {
    expect(opcoes(RESULTADOS_DO_FIM)).toEqual([
      { valor: "converted", rotulo: "Convertido" },
      { valor: "exhausted", rotulo: "Esgotado" },
      { valor: "custom", rotulo: "Personalizado" },
    ]);
  });
});
