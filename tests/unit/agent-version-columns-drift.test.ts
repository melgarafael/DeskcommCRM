/**
 * A lista de colunas de `ai_agent_versions` está copiada em 7 arquivos (as rotas
 * REST, a server action e a página do agente). Adicionar uma coluna nova em
 * apenas alguns deles não quebra typecheck nem teste nenhum — o sintoma aparece
 * só na tela, como um campo que "se desmarca sozinho" depois do refresh, e o
 * save seguinte grava o valor errado por cima.
 *
 * Foi exatamente o que aconteceu com `cases_enabled` (spec 15, Wave 5): entrou
 * em 2 dos 7 arquivos. Este teste trava a divergência de qualquer coluna futura,
 * não só dessa — enquanto as cópias existirem, elas têm que ser idênticas.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { agentMcpCreateSchema, versionCreateSchema } from "@/lib/ai/agents/validation";

const ROOT = process.cwd();

/** Todo arquivo que carrega uma cópia da lista de colunas de versão. */
const FILES_WITH_VERSION_COLUMNS = [
  "app/app/ai/agents/[id]/_actions.ts",
  "app/app/ai/agents/[id]/page.tsx",
  "app/api/v1/ai/agents/route.ts",
  "app/api/v1/ai/agents/[id]/versions/route.ts",
  "app/api/v1/ai/agents/[id]/versions/[vid]/route.ts",
  // A cópia da rota /duplicate mudou de casa: a implementação agora é
  // compartilhada com o botão "Duplicar" da lista, em lib/ai/agents/duplicate.ts.
  // O arquivo vigiado é onde a lista mora, não onde ela morava.
  "lib/ai/agents/duplicate.ts",
];

/** Extrai o conteúdo da string atribuída a VERSION_COLUMNS. */
function versionColumnsOf(relPath: string): string[] {
  const source = readFileSync(join(ROOT, relPath), "utf8");
  const match = /VERSION_COLUMNS\s*(?::\s*string)?\s*=\s*\n?\s*"([^"]+)"/.exec(source);
  if (match === null) {
    throw new Error(`VERSION_COLUMNS não encontrado em ${relPath}`);
  }
  return (match[1] ?? "").split(",").map((c) => c.trim()).filter((c) => c.length > 0);
}

describe("VERSION_COLUMNS de ai_agent_versions", () => {
  it("é idêntico em todos os arquivos que o copiam", () => {
    const [firstFile, ...restFiles] = FILES_WITH_VERSION_COLUMNS;
    if (firstFile === undefined) throw new Error("lista de arquivos vazia");
    const expected = versionColumnsOf(firstFile);
    expect(expected.length).toBeGreaterThan(10);

    for (const file of restFiles) {
      const columns = versionColumnsOf(file);
      // Compara como conjunto ordenado: ordem no SELECT não importa, presença sim.
      expect({ file, columns: [...columns].sort() }).toEqual({
        file,
        columns: [...expected].sort(),
      });
    }
  });

  it("inclui as flags por-agente que a tela edita", () => {
    // Regressão direta do bug do cases_enabled: uma flag que a tela grava mas o
    // SELECT não devolve volta como `false` no próximo render.
    for (const file of FILES_WITH_VERSION_COLUMNS) {
      const columns = versionColumnsOf(file);
      expect(columns).toContain("handoff_tool_enabled");
      expect(columns).toContain("cases_enabled");
      expect(columns).toContain("split_messages");
      expect(columns).toContain("split_max_chars");
    }
  });
});

/**
 * O SELECT idêntico não basta: o payload do form passa por `versionCreateSchema`,
 * que é `.strict()`. Coluna ausente do schema faz o parse REJEITAR o save inteiro
 * (ou, se fosse não-strict, silenciosamente descartar o campo). Foi o segundo elo
 * quebrado do split de mensagens: a coluna existia no banco e no runtime, mas o
 * schema não a conhecia, então a tela nunca conseguiria gravá-la.
 */
describe("versionCreateSchema aceita as flags por-agente que a tela edita", () => {
  /** Payload mínimo que o schema aceita — fonte única para as provas deste arquivo. */
  const base = {
    system_prompt: "Você é um atendente de testes.",
    provider: "anthropic" as const,
    model: "claude-sonnet-4-6",
    credential_id: "11111111-1111-4111-8111-111111111111",
    channel_session_id: "22222222-2222-4222-8222-222222222222",
  };

  it("preserva split_messages/split_max_chars no parse", () => {
    const parsed = versionCreateSchema.safeParse({
      ...base,
      split_messages: true,
      split_max_chars: 240,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.split_messages).toBe(true);
    expect(parsed.success && parsed.data.split_max_chars).toBe(240);
  });

  it("cai nos defaults da migration 0059 quando omitido", () => {
    const parsed = versionCreateSchema.safeParse(base);
    expect(parsed.success && parsed.data.split_messages).toBe(false);
    expect(parsed.success && parsed.data.split_max_chars).toBe(600);
  });

  it("aceita callback_enabled como opção independente dentro de followup", () => {
    const parsed = versionCreateSchema.safeParse({
      ...base,
      followup: {
        enabled: true,
        flow_pointer_ids: ["33333333-3333-4333-8333-333333333333"],
        callback_enabled: false,
      },
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.followup).toMatchObject({
      enabled: true,
      flow_pointer_ids: ["33333333-3333-4333-8333-333333333333"],
      callback_enabled: false,
    });
  });
});

/**
 * O SELECT e o schema iguais ainda não bastam: cada caminho que grava uma versão
 * monta o INSERT campo a campo. `inbound_debounce_ms` (#1856) entrou só no PATCH
 * de rascunho e ficou fora de três INSERTs; `followup` e `proposal_ai_draft_enabled`
 * também já se perderam pela mesma fenda (#2004); e o INSERT de
 * `lib/ai/apply-proposal.ts` ficou de fora da cerca inteira — a lista de arquivos
 * era escrita à mão (#2126) — e devolvia ao default do banco onze chaves de
 * `versionShapeSchema` em toda proposta aplicada.
 *
 * Por isso ESTE BLOCO NÃO TEM LISTA DE ARQUIVOS: os caminhos são descobertos
 * varrendo `app/` e `lib/`, e as chaves cobradas saem do próprio
 * `versionShapeSchema` (tipado). Arquivo novo que grave versão entra na cerca
 * sozinho; coluna nova no schema passa a ser coberta sem editar este arquivo.
 */

/** Raízes do produto: todo caminho que grava versão mora numa das duas. */
const RAIZES_DE_CODIGO = ["app", "lib"] as const;

/** Jeito 1 de gravar versão: Supabase, `.from(...).insert(...)`. */
const INSERT_SUPABASE = /\.from\("ai_agent_versions"\)\s*\.insert\(/;
/** Jeito 2 de gravar versão: SQL puro no caminho transacional em pg. */
const INSERT_SQL = /insert\s+into\s+ai_agent_versions\s*\(/i;

type Fonte = { rel: string; source: string };

let cacheDeFontes: Fonte[] | null = null;

/** Todas as fontes .ts/.tsx de app/ e lib/ — lidas uma vez por execução. */
function fontesDeCodigo(): Fonte[] {
  if (cacheDeFontes !== null) return cacheDeFontes;
  const fontes: Fonte[] = [];
  const andar = (dir: string): void => {
    for (const entrada of readdirSync(dir, { withFileTypes: true })) {
      const absoluto = join(dir, entrada.name);
      if (entrada.isDirectory()) {
        if (entrada.name !== "node_modules" && entrada.name !== ".next") andar(absoluto);
        continue;
      }
      // Spec e .d.ts não são caminho de produção: um `.insert()` de teste é
      // fixture, não código que grava linha nenhuma.
      if (!/\.tsx?$/.test(entrada.name)) continue;
      if (/\.test\.tsx?$/.test(entrada.name) || entrada.name.endsWith(".d.ts")) continue;
      fontes.push({ rel: relative(ROOT, absoluto), source: readFileSync(absoluto, "utf8") });
    }
  };
  for (const raiz of RAIZES_DE_CODIGO) andar(join(ROOT, raiz));
  cacheDeFontes = fontes;
  return fontes;
}

function fonte(rel: string): string {
  const achada = fontesDeCodigo().find((f) => f.rel === rel);
  if (!achada) throw new Error(`${rel} não está em app/ nem em lib/`);
  return achada.source;
}

/** Arquivo que define `function <nome>` — é onde o corpo de um helper mora. */
function arquivoQueDefine(nome: string): string {
  const alvo = fontesDeCodigo().find((f) =>
    new RegExp(`function\\s+${nome}\\s*\\(`).test(f.source),
  );
  if (!alvo) {
    throw new Error(
      `função ${nome} não foi achada em app/ nem em lib/ — a cerca precisa de um alvo para cobrar as chaves`,
    );
  }
  return alvo.rel;
}

/** Texto entre as chaves que abrem em `inicio` (índice do `{`). */
function corpoDeChaves(source: string, inicio: number): string {
  let nivel = 1;
  let i = inicio + 1;
  for (; i < source.length && nivel > 0; i++) {
    if (source[i] === "{") nivel++;
    else if (source[i] === "}") nivel--;
  }
  return source.slice(inicio, i);
}

/** Corpo de `function <nome>(...) { ... }`. */
function corpoDaFuncao(source: string, nome: string): string {
  const abertura = new RegExp(`function\\s+${nome}\\s*\\([^)]*\\)[^{]*\\{`).exec(source);
  if (!abertura) throw new Error(`corpo da função ${nome} não encontrado`);
  return corpoDeChaves(source, abertura.index + abertura[0].length - 1);
}

/** Corpo da propriedade `nome: { ... }` dentro de um objeto. */
function corpoDaPropriedade(source: string, nome: string): string {
  const casamento = new RegExp(`\\b${nome}\\s*:\\s*\\{`).exec(source);
  if (!casamento) throw new Error(`propriedade ${nome} não encontrada`);
  return corpoDeChaves(source, source.indexOf("{", casamento.index));
}

/**
 * Todo arquivo que grava uma versão — descoberto varrendo o código, não listado
 * à mão. A lista escrita à mão anterior tinha 3 arquivos e deixou o INSERT de
 * `lib/ai/apply-proposal.ts` fora desde que ele existiu (#2126).
 */
function arquivosQueGravamVersao(): string[] {
  return fontesDeCodigo()
    .filter((f) => INSERT_SUPABASE.test(f.source) || INSERT_SQL.test(f.source))
    .map((f) => f.rel)
    .sort();
}

/**
 * A ÚNICA lista à mão que sobrou — e ela justifica por que aquele INSERT não é
 * cobrado chave a chave. Escrita por extenso com o motivo de cada arquivo: uma
 * allowlist sem motivo é a próxima cerca velha. Se um destes dois deixar de ser
 * descoberto, o teste de descoberta reprová.
 */
const INSERTS_FORA_DA_COBRANCA: Record<string, string> = {
  "lib/ai/agents/first-publication.ts":
    "Cria a v1 do zero (onboarding e reconciliação de instalação legada): não existe " +
    "versão de origem de onde copiar — o payload vem de variáveis resolvidas na própria " +
    "função e o resto é default do banco, que é o que o onboarding quer.",
  "lib/ai/agents/create-draft.ts":
    "Grava em SQL puro, com as colunas tiradas de Object.entries(v) — v é o output de " +
    "agentMcpCreateSchema, que é strict e não partial: as chaves de versionShapeSchema " +
    "entram por construção e nenhum objeto literal é escrito à mão aqui.",
};

/**
 * Alvo de cobrança de UM site de `.from("ai_agent_versions").insert(...)`:
 *
 * - objeto literal → o próprio texto do INSERT, porque é ali que as chaves estão
 *   escritas;
 * - expressão (`.insert(records.version)`) → o corpo da propriedade que o helper
 *   devolve, porque a rota só grava o objeto que outro módulo montou;
 * - espalha de `versionPayloadFrom` → o corpo do helper, que é onde as chaves da
 *   cópia moram (lib/ai/agents/duplicate.ts).
 *
 * O que não fechar em alvo JUNTA erro: um caminho novo não pode passar em
 * silêncio só porque a cerca não sabia onde olhar.
 */
function sitesDeInsert(source: string): string[] {
  const alvos: string[] = [];
  const re = /\.from\("ai_agent_versions"\)\s*\.insert\(/g;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    let i = m.index + m[0].length;
    while (i < source.length && /\s/.test(source[i] as string)) i++;

    if (source[i] === "{") {
      const fim = corpoDeChaves(source, i).length + i;
      let alvo = source.slice(m.index, fim);
      // O INSERT que espalha um helper escreve DUAS coisas: o objeto literal e
      // o corpo do helper. Só a união das duas é o que a linha grava — cobrar o
      // literal sozinho reprovaria todo espalha, e o helper sozinho esconderia
      // uma chave que o literal deixou de fora.
      if (alvo.includes("...versionPayloadFrom(")) {
        const helper = arquivoQueDefine("versionPayloadFrom");
        alvo += `\n${corpoDaFuncao(fonte(helper), "versionPayloadFrom")}`;
      }
      alvos.push(alvo);
      continue;
    }

    // Argumento não-literal: achar quem monta `expr` e cobrar o corpo da
    // propriedade que essa função devolve.
    const inicio = i;
    let nivel = 0;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === "(") nivel++;
      else if (c === ")") {
        if (nivel === 0) break;
        nivel--;
      }
    }
    const expr = source.slice(inicio, i).trim();
    const ponto = expr.indexOf(".");
    const variavel = ponto === -1 ? expr : expr.slice(0, ponto);
    const propriedade = ponto === -1 ? null : expr.slice(ponto + 1);
    const atribuicao = new RegExp(
      `const\\s+${variavel}\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*\\(`,
    ).exec(source);
    if (!atribuicao) {
      throw new Error(
        `não achei quem monta \`${expr}\` — a cerca precisa de um alvo para cobrir as chaves deste INSERT`,
      );
    }
    const nome = atribuicao[1] as string;
    const corpo = corpoDaFuncao(fonte(arquivoQueDefine(nome)), nome);
    alvos.push(propriedade === null ? corpo : corpoDaPropriedade(corpo, propriedade));
  }
  return alvos;
}

/**
 * Payload mínimo que o schema aceita — mesma forma que o bloco de testes do
 * `versionCreateSchema` usa lá acima.
 */
const VERSION_DE_PROVA = {
  system_prompt: "Você é um atendente de testes.",
  provider: "anthropic" as const,
  model: "claude-sonnet-4-6",
  credential_id: "11111111-1111-4111-8111-111111111111",
  channel_session_id: "22222222-2222-4222-8222-222222222222",
};

/**
 * Chaves que um INSERT montado pelo schema estrito carrega, provadas em tempo de
 * teste: `agentMcpCreateSchema` não é `.partial()`, então o parse SEMPRE devolve
 * as chaves de `versionShapeSchema` (preenchendo as que vieram vazias com o
 * default). Quem espalha `...input.version` está completo por construção — é
 * esta prova que a cerca aceita no lugar de uma lista de chaves.
 */
function chavesDeVersionParseadas(): string[] {
  const input = agentMcpCreateSchema.parse({
    name: "Prova da cerca",
    version: versionCreateSchema.parse(VERSION_DE_PROVA),
  });
  return Object.keys(input.version);
}

/**
 * Cobertura de um INSERT que espalha o output do schema estrito
 * (`...input.version`): cada nome de `versionShapeSchema` está coberto de uma
 * das duas formas — o parse o devolveu, ou o próprio schema aceita o campo vazio
 * (`.optional()`), e aí a ausência no INSERT é "usa o default do banco", o mesmo
 * que gravar `chave: undefined`. Nada disso é lista à mão: são duas medições no
 * schema, e as duas saem vermelhas se o schema mudar.
 */
let coberturaDoEsquema: string[] | null = null;
function chavesCobertasPeloEsquema(): string[] {
  if (coberturaDoEsquema !== null) return coberturaDoEsquema;
  const parseadas = new Set(chavesDeVersionParseadas());
  const shape = versionCreateSchema.shape as unknown as Record<
    string,
    { safeParse: (valor: unknown) => { success: boolean } }
  >;
  coberturaDoEsquema = chavesDeConteudoDaVersao().filter(
    (c) => parseadas.has(c) || shape[c]?.safeParse(undefined).success === true,
  );
  return coberturaDoEsquema;
}

/** Chaves de conteúdo de `versionShapeSchema` (as que a versão LEVA ao gravar). */
function chavesDeConteudoDaVersao(): string[] {
  return Object.keys(versionCreateSchema.shape);
}

/** Extrai os nomes de chave (`chave:` no início de linha, indentado) de um trecho.
 *  Casar por nome de chave (e não por substring) evita que um comentário que cite
 *  a palavra confunda a cerca. */
function chavesNomeadas(bloco: string): string[] {
  const nomes: string[] = [];
  const re = /^\s+([a-z_][a-z0-9_]*):/gm;
  for (let m = re.exec(bloco); m !== null; m = re.exec(bloco)) {
    const nome = m[1];
    if (nome !== undefined && !nomes.includes(nome)) nomes.push(nome);
  }
  return nomes;
}

/**
 * Chaves que um alvo efetivamente escreve: as nomeadas no texto, mais as que o
 * schema estrito garante quando o alvo espalha `...input.version` (provado
 * acima). Espalha de helper que a cerca não conhece NÃO é aceito — ele some aqui
 * e o INSERT fica vermelho, que é o efeito desejado.
 */
function chavesDoAlvo(alvo: string): string[] {
  const nomes = chavesNomeadas(alvo);
  if (/\.\.\.[\w$]+\.version\b/.test(alvo)) nomes.push(...chavesCobertasPeloEsquema());
  return [...new Set(nomes)];
}

describe("todo INSERT de versão leva todas as chaves de versionShapeSchema", () => {
  it("o extrator acusa um INSERT sem uma chave do schema (controle positivo)", () => {
    const sem = `admin.from("ai_agent_versions").insert({ split_max_chars: 1, followup: { a: 1 } })`;
    const alvos = sitesDeInsert(sem);
    expect(alvos).toHaveLength(1);
    // split_max_chars presente no objeto, mas system_prompt falta — e um comentário
    // de fora citando a palavra não conta como chave.
    expect(alvos[0]).toContain("split_max_chars");
    const faltando = chavesDeConteudoDaVersao().filter(
      (c) => !chavesDoAlvo(alvos[0] ?? "").includes(c),
    );
    expect(faltando.some((c) => c === "system_prompt")).toBe(true);
  });

  it("descobre sozinho os arquivos que gravam versão", () => {
    const descobertos = arquivosQueGravamVersao();
    // Caminhos que já se perderam ou que a cerca passaria a cobrir agora. Uma
    // allowlist órfã (arquivo que não é mais descoberto) também cai aqui.
    for (const esperado of [
      "app/api/v1/ai/agents/route.ts",
      "app/api/v1/ai/agents/[id]/versions/route.ts",
      "app/app/ai/agents/[id]/_actions.ts",
      "lib/ai/agents/duplicate.ts",
      "lib/ai/apply-proposal.ts",
      ...Object.keys(INSERTS_FORA_DA_COBRANCA),
    ]) {
      expect(descobertos, `${esperado} saiu da descoberta`).toContain(esperado);
    }
  });

  it("todos os caminhos descobertos levam todas as chaves", () => {
    for (const file of arquivosQueGravamVersao()) {
      if (file in INSERTS_FORA_DA_COBRANCA) continue;
      const source = fonte(file);
      // SQL puro a cerca não lê: ou o caminho é justificado na allowlist, ou o
      // INSERT passa a ser objeto e entra na cobrança de chaves.
      expect(
        INSERT_SQL.test(source),
        `${file} grava versão em SQL puro sem estar em INSERTS_FORA_DA_COBRANCA`,
      ).toBe(false);
      const alvos = sitesDeInsert(source);
      expect(alvos.length, `${file} grava versão e a cerca não achou o alvo`).toBeGreaterThan(0);
      for (const alvo of alvos) {
        const faltando = chavesDeConteudoDaVersao().filter((c) => !chavesDoAlvo(alvo).includes(c));
        expect({ file, faltando }).toEqual({ file, faltando: [] });
      }
    }
  });

  it("o que a cerca aceita por construção (spread do schema estrito) cobre todas as chaves", () => {
    // É o que permite cobrir `app/api/v1/ai/agents/route.ts`, cujo INSERT grava
    // `records.version` — um objeto montado por `mcpAgentDraftRecords` que
    // espalha `...input.version` em vez de nomear as chaves. A cobertura é a
    // medição acima; se o schema ganhar uma chave obrigatória que o parse não
    // devolve, esta prova cai antes de a cerca passar a aceitar o spread.
    expect(chavesCobertasPeloEsquema()).toEqual(
      expect.arrayContaining(chavesDeConteudoDaVersao()),
    );
  });
});
