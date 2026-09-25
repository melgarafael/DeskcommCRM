/**
 * QUEM ESCREVE EM `organizations` PRECISA DO CLIENTE ADMIN — E O PORQUÊ É UMA FALHA SILENCIOSA.
 *
 * A RLS de `organizations` deixa o membro LER a própria organização e deixa
 * ESCREVER só quem é platform admin. Com o cliente de sessão, um
 * `update(...).eq("id", orgId)` feito pelo `admin` do próprio tenant casa ZERO
 * linhas — e o PostgREST devolve **sucesso**, sem erro. A tela diz "salvo" e
 * nada foi gravado.
 *
 * ═══ POR QUE ISTO PRECISA DE UM GATE, E NÃO DE UMA LINHA NA DOUTRINA ═══
 *
 * O modo de falha é invisível de três maneiras ao mesmo tempo:
 *
 * 1. **Não dá erro.** Nenhum `catch` acende, nenhum Sentry abre.
 * 2. **Funciona na máquina de quem escreveu.** O `install.sh` cria o dono da
 *    instalação COMO platform admin — então o autor testa, grava, e só o
 *    SEGUNDO administrador do time descobre. Num produto self-host, isso
 *    significa que o defeito viaja até o cliente.
 * 3. **Os testes de rota não podem vê-lo.** Eles mockam `createClient` inteiro
 *    com um stub que sempre dá certo; um teste de unidade não tem RLS.
 *
 * A regra não está no `CLAUDE.md` — ela vive só como padrão nos arquivos
 * irmãos, e um contribuidor que siga o `createClient()` do resto do handler
 * acerta tudo que os gates visíveis sabem cobrar e ainda assim entrega um
 * controle decorativo. Aconteceu no PR #671, e é por isso que este arquivo
 * existe: `lib/ai/pontos` não tinha como saber.
 *
 * ═══ O QUE ESTE GATE NÃO DIZ ═══
 *
 * Ele não afere que o `.eq("organization_id", …)` / `.eq("id", …)` está lá — o
 * cliente admin passa por cima da RLS, e o filtro de tenant vira
 * responsabilidade do arquivo (anti-pattern 10 do `CLAUDE.md`). Isso é matéria
 * de revisão humana. Aqui a pergunta é só: a escrita tem chance de acontecer?
 *
 * ═══ AS QUATRO FORMAS DE TER O CLIENTE ADMIN ═══
 *
 * A cerca aceita quatro, e nenhuma delas é prova de nome — todas são prova de
 * ORIGEM ou de TIPO:
 *
 *   1. **criado aqui** — `const admin = createAdminClient()`, que
 *      `nomesDoClienteAdmin` lê pela origem;
 *   2. **recebido por parâmetro e TIPADO** — `p.admin` com
 *      `admin: ReturnType<typeof createAdminClient>`, que
 *      `caminhosDoClienteAdmin` lê pela anotação resolvida;
 *   3. **anotado por um tipo que mora em OUTRO arquivo, ou herdado** —
 *      `import type { Admin } from "@/lib/waha/ingest"` (o alias já exportado
 *      lá) e `interface Pedido extends ComAdmin`, que os dois resolvedores
 *      seguem até o módulo que declara o tipo (issue #1157, itens 1 e 2);
 *   4. **passado de uma função para outra do mesmo arquivo** — o parâmetro SEM
 *      anotação cuja chamada visível entrega um cliente admin
 *      (`nomesProvadosPelaChamada`, item 3 da mesma issue).
 *
 * A (2) entrou porque a cerca acusava escrita irregular num arquivo CORRETO
 * (PR #1017, `lib/ai/pontos/padrao-da-organizacao.ts`): `raizDaCadeia` devolve a
 * raiz `"p"` de `p.admin.from(...)` e a propriedade se perdia, e a lista de
 * origem só cobre cliente criado no mesmo arquivo. Não era furo antigo, era caso
 * novo chegando: 21 arquivos já recebem o cliente por parâmetro e quatro deles
 * tocam `organizations`, mas todos os quatro só `.select()` — o #1017 foi o
 * primeiro a MUTAR assim, e `MUTACOES` é o que esta cerca olha.
 *
 * **Aceitar qualquer `x.admin` seria trocar a prova por uma senha**: bastaria
 * batizar de `admin` um parâmetro com o cliente de SESSÃO para escrever por
 * baixo da cerca. É por isso que (2) a (4) são medidas pelo tipo, e é por isso
 * que o CONTROLE abaixo sabota a si mesmo em cada forma que separa tipo de nome
 * — as três novas inclusive, cada uma com o par verde e vermelho.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { arquivosDeCodigo, caminhoRelativo } from "./helpers/varrer-codigo";
import {
  caminhoDaCadeia,
  caminhosDoClienteAdmin,
  ehReceptorAdmin,
  escopoDeTipos,
  nomesDoClienteAdmin,
  raizDaCadeia,
} from "./helpers/cliente-admin";

const RAIZES = ["app", "lib", "workers"] as const;
const MUTACOES = new Set(["update", "insert", "upsert", "delete"]);

/**
 * Arquivos liberados, com o motivo escrito. Esta lista só encolhe: quem
 * acrescentar um nome aqui está dizendo que a escrita não passa pela RLS de
 * `organizations` por um motivo que sobrevive à leitura de outra pessoa.
 */
const LIBERADOS = new Map<string, string>([
  [
    "lib/auth/provision.ts",
    "cria a organização no provisionamento, antes de existir membro — não há " +
      "sessão de tenant para a RLS avaliar, e o cliente já é o de serviço.",
  ],
]);

interface Achado {
  arquivo: string;
  linha: number;
  cliente: string;
  metodo: string;
}

/*
 * O RESOLVEDOR vive em `./helpers/cliente-admin`: `admin-client-exige-filtro-de-tenant.test.ts`
 * faz a pergunta irmã (esta cadeia FILTRA o tenant?) e precisa do mesmo
 * identificador-raiz. Duas cópias envelheceriam em ritmos diferentes.
 */

function escritasEmOrganizations(caminho: string): Achado[] {
  const texto = readFileSync(caminho, "utf8");
  if (!texto.includes('from("organizations")')) return [];

  const fonte = ts.createSourceFile(caminho, texto, ts.ScriptTarget.Latest, true);
  const achados = achadosNaFonte(fonte, caminhoRelativo(caminho));
  return achados;
}

/**
 * Os achados de uma fonte já lida — separado de `escritasEmOrganizations` para
 * que o CONTROLE possa alimentar a varredura com fonte sintética, sem gravar
 * arquivo. É a única forma de sabotar as variantes de "cliente de sessão com
 * nome de admin" — as de anotação, as de tipo importado de outro arquivo e as
 * de cliente passado entre funções — num teste que roda em todo CI.
 */
function achadosNaFonte(fonte: ts.SourceFile, arquivo: string): Achado[] {
  const escopo = escopoDeTipos(fonte);
  const caminhos = caminhosDoClienteAdmin(fonte);
  const achados: Achado[] = [];

  const visitar = (no: ts.Node): void => {
    // `<cadeia>.<mutacao>(...)` onde a cadeia contém `.from("organizations")`.
    if (
      ts.isCallExpression(no) &&
      ts.isPropertyAccessExpression(no.expression) &&
      MUTACOES.has(no.expression.name.text)
    ) {
      const alvo = no.expression.expression;
      // `arguments[0]` sai do índice como `Expression | undefined` sob
      // `noUncheckedIndexedAccess`, e o `length === 1` do lado não estreita o
      // tipo — daí o `const` antes do guard, em vez do índice repetido.
      const argumentoDoFrom = ts.isCallExpression(alvo) ? alvo.arguments[0] : undefined;
      if (
        ts.isCallExpression(alvo) &&
        ts.isPropertyAccessExpression(alvo.expression) &&
        alvo.expression.name.text === "from" &&
        alvo.arguments.length === 1 &&
        argumentoDoFrom !== undefined &&
        ts.isStringLiteral(argumentoDoFrom) &&
        argumentoDoFrom.text === "organizations"
      ) {
        const receptor = alvo.expression.expression;
        const raiz = raizDaCadeia(receptor);
        // Quatro formas de ter o cliente admin, e nenhuma delas é o nome (ver o
        // cabeçalho): criado aqui (origem), recebido por anotação — inclusive
        // por um tipo que mora em OUTRO arquivo, ou herdado por `extends` — ou
        // passado por outra função deste mesmo arquivo (a chamada prova).
        const caminho = caminhoDaCadeia(receptor);
        const deServico = ehReceptorAdmin(receptor, fonte, escopo, caminhos);
        if (raiz !== null && !deServico) {
          achados.push({
            arquivo,
            linha: fonte.getLineAndCharacterOfPosition(no.getStart()).line + 1,
            cliente: caminho ?? raiz,
            metodo: no.expression.name.text,
          });
        }
      }
    }
    ts.forEachChild(no, visitar);
  };
  visitar(fonte);
  return achados;
}

const ARQUIVOS = arquivosDeCodigo(RAIZES);

/** Fonte sintética para os controles — nome de arquivo só para a mensagem. */
const fonteDe = (codigo: string): ts.SourceFile =>
  ts.createSourceFile("sintetico.ts", codigo, ts.ScriptTarget.Latest, true);

const IMPORTA_A_FABRICA = 'import type { createAdminClient } from "@/lib/supabase/admin";\n';
const IMPORTA_A_SESSAO = 'import type { createClient } from "@/lib/supabase/server";\n';
const MUTA = 'await p.admin.from("organizations").update({ settings }).eq("id", p.orgId);';
/** A mesma escrita pelo parâmetro SEM anotação, que só a chamada pode provar. */
const MUTA_PELO_CLIENTE_PASSADO =
  'await cliente.from("organizations").update({ settings }).eq("id", orgId);';

/** O alias REAL que a issue #1157 cita como instância do item 1. */
const MODULO_DO_ALIAS_DO_CLIENTE_ADMIN = "@/lib/waha/ingest";
/** Os fixtures com os MESMOS nomes: um declara o cliente admin, o outro o de sessão. */
const FIXTURE_VERDE = "@/tests/fixtures/escrita-em-organizations/verde/cliente";
const FIXTURE_VERMELHA = "@/tests/fixtures/escrita-em-organizations/vermelha/cliente";

describe("toda escrita em `organizations` passa pelo cliente admin", () => {
  it("CONTROLE: a varredura enxerga os arquivos que tocam a tabela", () => {
    expect(ARQUIVOS.length).toBeGreaterThan(500);
    const tocam = ARQUIVOS.filter((a) => readFileSync(a, "utf8").includes('from("organizations")'));
    expect(
      tocam.length,
      "zero arquivos tocando `organizations` é indistinguível de 'está tudo em ordem' — a sonda cegou",
    ).toBeGreaterThan(20);
  });

  it("CONTROLE: o resolvedor de identificador reconhece o padrão em vigor", () => {
    const gemeo = ARQUIVOS.find((a) => caminhoRelativo(a) === "app/actions/auth/politicaDeMfa.ts");
    expect(gemeo, "o gêmeo que escreve o MESMO jsonb sumiu — a sonda perdeu a referência").toBeDefined();
    expect(escritasEmOrganizations(gemeo as string)).toEqual([]);
  });

  it("CONTROLE: o cliente admin recebido por parâmetro é aceito — tipado aqui, importado, herdado ou passado", () => {
    const aceitos: readonly { forma: string; codigo: string }[] = [
      {
        forma: "propriedade de `interface` (a forma de `lib/ai/pontos/padrao-da-organizacao.ts`)",
        codigo:
          IMPORTA_A_FABRICA +
          "interface Pedido { admin: ReturnType<typeof createAdminClient>; orgId: string }\n" +
          `export async function gravar(p: Pedido, settings: unknown) { ${MUTA} }`,
      },
      {
        forma: "propriedade de tipo de objeto inline",
        codigo:
          IMPORTA_A_FABRICA +
          "export async function gravar(p: { admin: ReturnType<typeof createAdminClient>; orgId: string }, settings: unknown) " +
          `{ ${MUTA} }`,
      },
      {
        forma: "parâmetro direto",
        codigo:
          IMPORTA_A_FABRICA +
          "export async function gravar(admin: ReturnType<typeof createAdminClient>, orgId: string, settings: unknown) " +
          '{ await admin.from("organizations").update({ settings }).eq("id", orgId); }',
      },
      {
        forma: "parâmetro por `type` local (a forma de `lib/channels/pos-entrada.ts`)",
        codigo:
          IMPORTA_A_FABRICA +
          "type Admin = ReturnType<typeof createAdminClient>;\n" +
          "export async function gravar(admin: Admin, orgId: string, settings: unknown) " +
          '{ await admin.from("organizations").update({ settings }).eq("id", orgId); }',
      },
      {
        forma: "parâmetro desestruturado",
        codigo:
          IMPORTA_A_FABRICA +
          "export async function gravar({ admin, orgId }: { admin: ReturnType<typeof createAdminClient>; orgId: string }, settings: unknown) " +
          '{ await admin.from("organizations").update({ settings }).eq("id", orgId); }',
      },
      {
        forma: `alias de tipo IMPORTADO de outro arquivo (o \`${MODULO_DO_ALIAS_DO_CLIENTE_ADMIN}\` da issue)`,
        codigo:
          `import type { Admin } from "${MODULO_DO_ALIAS_DO_CLIENTE_ADMIN}";\n` +
          "export async function gravar(admin: Admin, orgId: string, settings: unknown) " +
          '{ await admin.from("organizations").update({ settings }).eq("id", orgId); }',
      },
      {
        forma: "`interface` IMPORTADA que herda o cliente por `extends` (dois saltos)",
        codigo:
          `import type { Pedido } from "${FIXTURE_VERDE}";\n` +
          `export async function gravar(p: Pedido, settings: unknown) { ${MUTA} }`,
      },
      {
        forma: "`interface` deste arquivo que ESTENDE a que tem o cliente admin",
        codigo:
          IMPORTA_A_FABRICA +
          "interface ComAdmin { admin: ReturnType<typeof createAdminClient>; orgId: string }\n" +
          "interface Pedido extends ComAdmin { settings: unknown }\n" +
          `export async function gravar(p: Pedido, settings: unknown) { ${MUTA} }`,
      },
      {
        forma: "cliente passado de uma função para outra (o receptor recebe SEM anotação: a chamada prova)",
        codigo:
          IMPORTA_A_FABRICA +
          "interface Pedido { admin: ReturnType<typeof createAdminClient>; orgId: string }\n" +
          "async function aplicar(cliente, orgId: string, settings: unknown) " +
          `{ ${MUTA_PELO_CLIENTE_PASSADO} }\n` +
          "export async function gravar(p: Pedido, settings: unknown) " +
          "{ await aplicar(p.admin, p.orgId, settings); }",
      },
      {
        forma: "cliente passado por DUAS funções (cada passagem provada pela chamada dela)",
        codigo:
          IMPORTA_A_FABRICA +
          "interface Pedido { admin: ReturnType<typeof createAdminClient>; orgId: string }\n" +
          "async function executar(cliente, orgId: string, settings: unknown) " +
          `{ ${MUTA_PELO_CLIENTE_PASSADO} }\n` +
          "async function aplicar(cliente, orgId: string, settings: unknown) " +
          "{ await executar(cliente, orgId, settings); }\n" +
          "export async function gravar(p: Pedido, settings: unknown) " +
          "{ await aplicar(p.admin, p.orgId, settings); }",
      },
      {
        forma: "cliente criado AQUI e passado a uma função local (a forma literal do item 3)",
        codigo:
          IMPORTA_A_FABRICA +
          "const admin = createAdminClient();\n" +
          "async function aplicar(cliente, orgId: string, settings: unknown) " +
          `{ ${MUTA_PELO_CLIENTE_PASSADO} }\n` +
          "export async function gravar(orgId: string, settings: unknown) " +
          "{ await aplicar(admin, orgId, settings); }",
      },
      {
        forma: "chamada encadeada `.schema(\"public\")` a partir do cliente admin criado aqui",
        codigo:
          IMPORTA_A_FABRICA +
          "const admin = createAdminClient();\n" +
          "export async function gravar(orgId: string, settings: unknown) {\n" +
          '  await admin.schema("public").from("organizations").update({ settings }).eq("id", orgId);\n' +
          "}",
      },
    ];
    for (const { forma, codigo } of aceitos) {
      // `expect.soft`: o vermelho lista TODAS as formas que passaram, e não só a
      // primeira — é o que torna a sabotagem desta cerca contável (a medição
      // está no PR).
      expect.soft(
        achadosNaFonte(fonteDe(codigo), "sintetico.ts"),
        `${forma}: o cliente admin chegou TIPADO e a cerca acusou escrita irregular — ` +
          "é o falso vermelho que o PR #1017 pagou",
      ).toEqual([]);
    }
  });

  it("CONTROLE: `admin` que não é ADMIN pelo TIPO continua reprovado", () => {
    // Sabotagem permanente, e não uma rodada da minha sessão: cada caso abaixo
    // é uma forma de chamar um cliente de `admin` sem que o tipo o sustente. Se
    // um deles ficar verde, o reconhecimento do parâmetro virou senha.
    const reprovados: readonly { forma: string; codigo: string; esperado?: readonly string[] }[] = [
      {
        forma: "cliente de SESSÃO criado no próprio arquivo",
        codigo:
          IMPORTA_A_SESSAO +
          "export async function gravar(orgId: string, settings: unknown) " +
          '{ const p = { admin: await createClient() }; await p.admin.from("organizations").update({ settings }).eq("id", orgId); }',
      },
      {
        forma: "parâmetro `admin` tipado como cliente de SESSÃO, num arquivo que importa a fábrica admin",
        codigo:
          IMPORTA_A_FABRICA +
          IMPORTA_A_SESSAO +
          "interface DoServico { admin: ReturnType<typeof createAdminClient> }\n" +
          "interface DaSessao { admin: Awaited<ReturnType<typeof createClient>>; orgId: string }\n" +
          "export function naoUsada(_p: DoServico): void {}\n" +
          `export async function gravar(p: DaSessao, settings: unknown) { ${MUTA} }`,
      },
      {
        forma: "parâmetro `admin` tipado `any`",
        codigo:
          IMPORTA_A_FABRICA +
          "export async function gravar(p: { admin: any; orgId: string }, settings: unknown) " +
          `{ ${MUTA} }`,
      },
      {
        forma: "parâmetro `admin` SEM anotação de tipo",
        codigo:
          IMPORTA_A_FABRICA +
          `export async function gravar(p, settings) { ${MUTA} }`,
      },
      {
        forma: "alias IMPORTADO de outro arquivo cujo tipo é o de SESSÃO (o import compra o nome, não o tipo)",
        codigo:
          `import type { Admin } from "${FIXTURE_VERMELHA}";\n` +
          "export async function gravar(admin: Admin, orgId: string, settings: unknown) " +
          '{ await admin.from("organizations").update({ settings }).eq("id", orgId); }',
        esperado: ["admin.update"],
      },
      {
        forma: "`extends` que herda o cliente de SESSÃO (seguir a herança não é liberar por ela)",
        codigo:
          IMPORTA_A_FABRICA +
          IMPORTA_A_SESSAO +
          "interface ComAdminDeSessao { admin: Awaited<ReturnType<typeof createClient>>; orgId: string }\n" +
          "interface Pedido extends ComAdminDeSessao { settings: unknown }\n" +
          `export async function gravar(p: Pedido, settings: unknown) { ${MUTA} }`,
      },
      {
        forma: "cliente de SESSÃO passado de uma função para outra (a chamada prova o contrário)",
        codigo:
          IMPORTA_A_FABRICA +
          IMPORTA_A_SESSAO +
          "interface Pedido { admin: ReturnType<typeof createAdminClient>; orgId: string }\n" +
          "export function naoUsada(_p: Pedido): void {}\n" +
          "async function aplicar(cliente, orgId: string, settings: unknown) " +
          `{ ${MUTA_PELO_CLIENTE_PASSADO} }\n` +
          "export async function gravar(orgId: string, settings: unknown) " +
          "{ const sessao = await createClient(); await aplicar(sessao, orgId, settings); }",
        esperado: ["cliente.update"],
      },
      {
        forma: "a MESMA função chamada com admin num lugar e com SESSÃO noutro (`every`, não `some`)",
        codigo:
          IMPORTA_A_FABRICA +
          IMPORTA_A_SESSAO +
          "interface Pedido { admin: ReturnType<typeof createAdminClient>; orgId: string }\n" +
          "async function aplicar(cliente, orgId: string, settings: unknown) " +
          `{ ${MUTA_PELO_CLIENTE_PASSADO} }\n` +
          "export async function gravar(p: Pedido, settings: unknown) " +
          "{ await aplicar(p.admin, p.orgId, settings); }\n" +
          "export async function vazar(orgId: string, settings: unknown) " +
          "{ const sessao = await createClient(); await aplicar(sessao, orgId, settings); }",
        esperado: ["cliente.update"],
      },
      {
        forma: "função EXPORTADA como receptora sem anotação (outro arquivo pode chamá-la: a cerca acusa)",
        codigo:
          IMPORTA_A_FABRICA +
          "interface Pedido { admin: ReturnType<typeof createAdminClient>; orgId: string }\n" +
          "export async function aplicar(cliente, orgId: string, settings: unknown) " +
          `{ ${MUTA_PELO_CLIENTE_PASSADO} }\n` +
          "export async function gravar(p: Pedido, settings: unknown) " +
          "{ await aplicar(p.admin, p.orgId, settings); }",
        esperado: ["cliente.update"],
      },
      {
        forma:
          "o MESMO nome de parâmetro provado numa função e NÃO provado noutra (o caminho é do " +
          "ARQUIVO: o nome inteiro fica fora e as DUAS escritas são acusadas)",
        codigo:
          IMPORTA_A_FABRICA +
          IMPORTA_A_SESSAO +
          "interface Pedido { admin: ReturnType<typeof createAdminClient>; orgId: string }\n" +
          "async function aplicar(cliente, orgId: string, settings: unknown) " +
          `{ ${MUTA_PELO_CLIENTE_PASSADO} }\n` +
          "async function vazar(cliente, orgId: string, settings: unknown) " +
          `{ ${MUTA_PELO_CLIENTE_PASSADO} }\n` +
          "export async function gravar(p: Pedido, settings: unknown) " +
          "{ await aplicar(p.admin, p.orgId, settings); }\n" +
          "export async function outro(orgId: string, settings: unknown) " +
          "{ const sessao = await createClient(); await vazar(sessao, orgId, settings); }",
        esperado: ["cliente.update", "cliente.update"],
      },
      {
        forma: "F1d: valor padrão com local homônimo de sessão noutra função (escopo léxico)",
        codigo:
          IMPORTA_A_FABRICA +
          IMPORTA_A_SESSAO +
          "const admin = createAdminClient();\n" +
          "async function aplicar(cliente = admin, orgId: string, settings: unknown) " +
          `{ ${MUTA_PELO_CLIENTE_PASSADO} }\n` +
          "export async function gravar(orgId: string, settings: unknown) " +
          "{ await aplicar(admin, orgId, settings); }\n" +
          "export async function vazar(orgId: string, settings: unknown) " +
          `{ const cliente = await createClient(); ${MUTA_PELO_CLIENTE_PASSADO} }`,
        esperado: ["cliente.update"],
      },
      {
        forma: "F2d: valor padrão com export { aplicar } (função exportada por declaração nomeada)",
        codigo:
          IMPORTA_A_FABRICA +
          "const admin = createAdminClient();\n" +
          "async function aplicar(cliente = admin, orgId: string, settings: unknown) " +
          `{ ${MUTA_PELO_CLIENTE_PASSADO} }\n` +
          "export { aplicar };\n" +
          "export async function gravar(orgId: string, settings: unknown) " +
          "{ await aplicar(admin, orgId, settings); }",
        esperado: ["cliente.update"],
      },
      {
        forma: "F2d2: valor padrão com export default aplicar (função exportada como default)",
        codigo:
          IMPORTA_A_FABRICA +
          "const admin = createAdminClient();\n" +
          "async function aplicar(cliente = admin, orgId = \"\", settings: unknown = null) " +
          `{ ${MUTA_PELO_CLIENTE_PASSADO} }\n` +
          "export default aplicar;\n" +
          "export async function gravar(orgId: string, settings: unknown) " +
          "{ await aplicar(admin, orgId, settings); }",
        esperado: ["cliente.update"],
      },
      {
        forma: "funções homônimas com valor padrão (ordem a depois b: escopo da função vs arquivo)",
        codigo:
          IMPORTA_A_FABRICA +
          IMPORTA_A_SESSAO +
          "const admin = createAdminClient();\n" +
          "export async function a(orgId: string, settings: unknown) {\n" +
          '  const run = async (cliente = admin) => { await cliente.from("organizations").update({ settings }).eq("id", orgId); };\n' +
          "  await run();\n" +
          "}\n" +
          "export async function b(orgId: string, settings: unknown) {\n" +
          "  const sessao = await createClient();\n" +
          '  const run = async (cliente = sessao) => { await cliente.from("organizations").update({ settings }).eq("id", orgId); };\n' +
          "  await run();\n" +
          "}",
        esperado: ["cliente.update", "cliente.update"],
      },
      {
        forma: "funções homônimas com valor padrão (ordem b depois a: independência de ordem)",
        codigo:
          IMPORTA_A_FABRICA +
          IMPORTA_A_SESSAO +
          "const admin = createAdminClient();\n" +
          "export async function b(orgId: string, settings: unknown) {\n" +
          "  const sessao = await createClient();\n" +
          '  const run = async (cliente = sessao) => { await cliente.from("organizations").update({ settings }).eq("id", orgId); };\n' +
          "  await run();\n" +
          "}\n" +
          "export async function a(orgId: string, settings: unknown) {\n" +
          '  const run = async (cliente = admin) => { await cliente.from("organizations").update({ settings }).eq("id", orgId); };\n' +
          "  await run();\n" +
          "}",
        esperado: ["cliente.update", "cliente.update"],
      },
      {
        forma:
          "valor padrão aponta para uma local de SESSÃO homônima do admin do módulo " +
          "(vale a declaração que o nome alcança, não o nome no arquivo)",
        codigo:
          IMPORTA_A_FABRICA +
          IMPORTA_A_SESSAO +
          "const admin = createAdminClient();\n" +
          "export async function b(orgId: string, settings: unknown) {\n" +
          "  const admin = await createClient();\n" +
          `  const run = async (cliente = admin) => { ${MUTA_PELO_CLIENTE_PASSADO} };\n` +
          "  await run();\n" +
          "}",
        esperado: ["cliente.update"],
      },
      {
        forma: "argumento é uma local de SESSÃO homônima do admin do módulo",
        codigo:
          IMPORTA_A_FABRICA +
          IMPORTA_A_SESSAO +
          "const admin = createAdminClient();\n" +
          "async function aplicar(cliente = admin, orgId: string, settings: unknown) " +
          `{ ${MUTA_PELO_CLIENTE_PASSADO} }\n` +
          "export async function vazar(orgId: string, settings: unknown) " +
          "{ const admin = await createClient(); await aplicar(admin, orgId, settings); }",
        esperado: ["cliente.update"],
      },
      {
        forma: "argumento `admin.schema(...)` sobre uma local de SESSÃO homônima do admin do módulo",
        codigo:
          IMPORTA_A_FABRICA +
          IMPORTA_A_SESSAO +
          "const admin = createAdminClient();\n" +
          "async function aplicar(cliente = admin, orgId: string, settings: unknown) " +
          `{ ${MUTA_PELO_CLIENTE_PASSADO} }\n` +
          "export async function vazar(orgId: string, settings: unknown) " +
          '{ const admin = await createClient(); await aplicar(admin.schema("public"), orgId, settings); }',
        esperado: ["cliente.update"],
      },
      {
        forma:
          "chamada com spread omite o argumento na posição, mas o spread entrega o cliente de SESSÃO " +
          "(o valor padrão não pode provar)",
        codigo:
          IMPORTA_A_FABRICA +
          IMPORTA_A_SESSAO +
          "const admin = createAdminClient();\n" +
          "async function aplicar(orgId: string, settings: unknown, cliente = admin) " +
          `{ ${MUTA_PELO_CLIENTE_PASSADO} }\n` +
          "export async function vazar(orgId: string, settings: unknown) " +
          "{ const sessao = await createClient(); const args = [orgId, settings, sessao] as const; await aplicar(...args); }",
        esperado: ["cliente.update"],
      },
      {
        forma:
          "closure com valor padrão escrita ANTES da local de SESSÃO homônima do admin do módulo " +
          "(const vale para o bloco inteiro: a posição não devolve o nome ao módulo)",
        codigo:
          IMPORTA_A_FABRICA +
          IMPORTA_A_SESSAO +
          "const admin = createAdminClient();\n" +
          "export async function b(orgId: string, settings: unknown) {\n" +
          `  const run = async (cliente = admin) => { ${MUTA_PELO_CLIENTE_PASSADO} };\n` +
          "  const admin = await createClient();\n" +
          "  await run();\n" +
          "}",
        esperado: ["cliente.update"],
      },
      {
        forma:
          "closure escreve com um APELIDO do admin do módulo, sombreado depois no mesmo bloco " +
          "por um cliente de SESSÃO",
        codigo:
          IMPORTA_A_FABRICA +
          IMPORTA_A_SESSAO +
          "const servico = createAdminClient();\n" +
          "const cliente = servico;\n" +
          "export async function b(orgId: string, settings: unknown) {\n" +
          `  const run = async () => { ${MUTA_PELO_CLIENTE_PASSADO} };\n` +
          "  const cliente = await createClient();\n" +
          "  await run();\n" +
          "}",
        esperado: ["cliente.update"],
      },
    ];
    for (const { forma, codigo, esperado = ["p.admin.update"] } of reprovados) {
      // `expect.soft` pelo mesmo motivo do CONTROLE verde: uma sabotagem por vez
      // não pode esconder as outras.
      expect.soft(
        achadosNaFonte(fonteDe(codigo), "sintetico.ts").map((a) => `${a.cliente}.${a.metodo}`),
        `${forma}: a cerca deixou passar. O reconhecimento do parâmetro tem de ser ` +
          "prova de TIPO — se o nome basta, escrever em `organizations` por baixo da " +
          "cerca custa renomear uma variável, e a falha devolve SUCESSO com zero linhas.",
      ).toEqual(esperado);
    }
  });

  it("nenhum arquivo escreve com o cliente de sessão", () => {
    const achados = ARQUIVOS.flatMap(escritasEmOrganizations).filter(
      (a) => !LIBERADOS.has(a.arquivo),
    );
    expect(
      achados,
      "Escrita em `organizations` com cliente de sessão. A RLS só deixa escrever " +
        "platform admin, então isto casa ZERO linhas e o PostgREST devolve SUCESSO — " +
        "a tela diz 'salvo' e nada foi gravado. Troque por `createAdminClient()` e " +
        "mantenha o filtro de tenant explícito (`.eq(\"id\", org.orgId)`), que com o " +
        "service role passa a ser responsabilidade deste arquivo.",
    ).toEqual([]);
  });

  it("a lista de liberados não tem nome órfão", () => {
    for (const arquivo of LIBERADOS.keys()) {
      const existe = ARQUIVOS.some((a) => caminhoRelativo(a) === arquivo);
      expect(existe, `\`${arquivo}\` está liberado e não existe mais — a lista só encolhe`).toBe(true);
    }
  });
});
