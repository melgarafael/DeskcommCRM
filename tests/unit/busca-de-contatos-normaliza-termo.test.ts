/**
 * A BUSCA DE CONTATOS NORMALIZA O TERMO — PELA RÉGUA QUE JÁ EXISTE (#1835, F1).
 *
 * ─── O defeito ───────────────────────────────────────────────────────────────
 * O `q.search` da listagem de contatos passava por exatamente três
 * transformações, e nenhuma delas é sobre COMO A GENTE DIGITA:
 *
 *     trim · escape de curinga (`%`/`_`) · vírgula e parêntese viram espaço
 *
 * Medido na issue #1835, com o contato "Paulo Lima Jr" no banco:
 *
 *     digitado            antes                    depois (F1)
 *     "Paulo  Lima"       0 — espaço duplo         acha
 *     "Paulo Jr"          0 — não adjacentes       acha
 *     "Silva, Maria"      exige adjacência         acha
 *     "a"                 a lista INTEIRA          não consulta
 *
 * A última linha é a mais grave e a menos óbvia: `?search=a` montava
 * `name.ilike.%a%` e devolvia a base inteira embaralhada. Lista inteira sob
 * busca não é resposta — é ruído que PARECE resposta, e quem opera conclui
 * que o filtro não funciona.
 *
 * ─── Por que isto importa o arquivo inteiro ──────────────────────────────────
 * A busca de CONVERSAS já resolve os três casos com `normalizarTermoDeBusca` +
 * `PISO_DA_BUSCA`, em `lib/inbox/termo-de-busca.ts` — a ÚNICA régua por
 * design, lida pelo schema Zod e pela tela. Repetir a regra num dos lados faz
 * os dois divergirem no primeiro ajuste, e a divergência aparece como busca
 * que funciona na caixa e não funciona em contatos. Por isso o handler de
 * contatos IMPORTA a régua em vez de reimplementá-la, e este teste é a
 * catraca que impede que alguém volte a escrever a regra à mão aqui dentro.
 *
 * ─── O que este teste mede, e o que ele NÃO mede ─────────────────────────────
 * Não há banco no `tests/unit`. O que se mede é o FILTRO que sai do handler —
 * a decisão que estava errada — e ele é então traduzido para cá por DOIS
 * emuladores, um por operador: o `regexCasa` (um `RegExp` com caixa dobrada,
 * que é o que o Postgres executa em `imatch`) para o texto, e o `padraoCasa`
 * (uma reimplementação de `ILIKE`) para as variantes de telefone, que seguem
 * em LIKE porque são dígitos. Ambos têm casos de CONTROLE: se algum deles
 * passasse a casar tudo, os casos de cima ficariam verdes sem provar nada.
 *
 * O que NÃO está aqui: o banco de verdade (`tests/invariants`, `test:db`) e a
 * tela — ambos do CI. O `imatch` em si foi medido contra o PostgREST de VERDADE
 * (docker `postgrest/postgrest:latest` sobre `postgres:17`) antes de virar
 * código: a prova está no corpo do PR desta issue.
 */
import { describe, expect, it } from "vitest";

import { listContactsHandler } from "@/app/api/v1/contacts/_handler";
import { padraoRegexDeBusca } from "@/lib/contacts/busca-regex";

const ORG = "11111111-1111-4111-8111-111111111111";

/** O contato que a issue usou para medir os quatro casos. */
const PAULO_LIMA_JR = "Paulo Lima Jr";

/**
 * Cliente mínimo que mede TRÊS coisas: se o handler ABRIU uma tabela, se ele
 * EXECUTOU a cadeia (o `await` é o momento em que o supabase-js faria o fetch)
 * e o `.or()` que ele montou.
 *
 * Contar `from` e `await` separados é o que permite afirmar "NÃO CONSULTOU",
 * e não apenas "não achou": uma consulta que devolve 200 com a base inteira é
 * exatamente o defeito da linha `"a"` da issue.
 *
 * O dublê tem de conhecer TODOS os elos que o handler encadeia: um elo que
 * falta não vira "asserção que não passa", vira `TypeError` no meio da consulta
 * — e o vermelho aparece por motivo nenhum.
 */
function supabaseEspiao() {
  const estado = {
    aberturas: 0,
    execucoes: 0,
    filtros: [] as string[],
    igualdades: [] as Array<[string, unknown]>,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    select: () => chain,
    eq: (coluna: string, valor: unknown) => {
      estado.igualdades.push([coluna, valor]);
      return chain;
    },
    order: () => chain,
    limit: () => chain,
    contains: () => chain,
    is: () => chain,
    in: () => chain,
    or: (expr: string) => {
      estado.filtros.push(expr);
      return chain;
    },
    then: (res: (v: unknown) => unknown) => {
      estado.execucoes += 1;
      return Promise.resolve({ data: [], error: null }).then(res);
    },
  };
  return {
    client: {
      from: () => {
        estado.aberturas += 1;
        return chain;
      },
    } as never,
    estado,
  };
}

async function busca(termo: string) {
  const { client, estado } = supabaseEspiao();
  const resultado = await listContactsHandler(
    client,
    { organization_id: ORG, actor: { type: "user", id: "u-1" }, requestId: "req" },
    { search: termo, limit: 20 },
  );
  return {
    resultado,
    aberturas: estado.aberturas,
    execucoes: estado.execucoes,
    filtro: estado.filtros[0] ?? "",
    igualdades: estado.igualdades,
  };
}

function escapeRegex(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `ILIKE` do PostgREST, em duas linhas declaradas.
 *
 * PostgREST traduz `*` no valor para `%` do SQL; `%` e `_` escapados com
 * barra voltada são literais (é o que o handler faz com o curinga que a PESSOA
 * digitou); o resto é casamento por inteiro, sem caixa — `ilike`.
 */
function padraoCasa(padrao: string, valor: string): boolean {
  let re = "";
  for (let i = 0; i < padrao.length; i++) {
    const ch = padrao[i]!;
    if (ch === "\\" && i + 1 < padrao.length) {
      re += escapeRegex(padrao[++i]!);
    } else if (ch === "*" || ch === "%") {
      re += ".*";
    } else if (ch === "_") {
      re += ".";
    } else {
      re += escapeRegex(ch);
    }
  }
  return new RegExp(`^${re}$`, "i").test(valor);
}

type Operador = "ilike" | "imatch";

/** Todas as condições `coluna.operador.padrao` que o handler pôs no `.or()`. */
function condicoes(filtro: string): Array<{ coluna: string; operador: Operador; padrao: string }> {
  return [...filtro.matchAll(/(\w+)\.(ilike|imatch)\.([^,]+)/g)].map((m) => ({
    coluna: m[1]!,
    operador: m[2] as Operador,
    padrao: m[3]!,
  }));
}

/**
 * Uma condição traduzida para cá.
 *
 * `imatch` (`~*`) → `RegExp` com caixa dobrada: é a MESMA semântica que o
 * Postgres executa, e o `padrao` do handler é um regex POSIX que o `RegExp` do
 * JS lê igual para os construtos que o handler emite (classe, `.`, `*`, escape).
 * `ilike` continua pelo `padraoCasa` abaixo — é ele que anda nas variantes de
 * telefone, que continuam em LIKE de propósito (são dígitos, não têm acento).
 */
function casa(condicao: { operador: Operador; padrao: string }, valor: string): boolean {
  return condicao.operador === "imatch" ? regexCasa(condicao.padrao, valor) : padraoCasa(condicao.padrao, valor);
}

/** O `imatch` (`~*`) em `RegExp` com caixa dobrada — o tradutor do texto. */
function regexCasa(padrao: string, valor: string): boolean {
  return new RegExp(padrao, "i").test(valor);
}

/** O filtro ACHOU o nome? (`name` e `display_name` — as duas colunas do OR.) */
function achouNoNome(filtro: string, nome: string): boolean {
  return condicoes(filtro)
    .filter((c) => c.coluna === "name" || c.coluna === "display_name")
    .some((c) => casa(c, nome));
}

describe("busca de contatos: o termo é normalizado pela régua do repo (#1835, F1)", () => {
  it('espaço duplo ("Paulo  Lima") passa a achar "Paulo Lima Jr"', async () => {
    const { filtro } = await busca("Paulo  Lima");
    expect(achouNoNome(filtro, PAULO_LIMA_JR), `filtro=${filtro}`).toBe(true);
    // A asserção acima é o comportamento; esta diz COMO ele nasceu: o espaço
    // DUO não sobra no filtro. O padrão sai em regex (#1835, F2), então o que
    // não se pode mais afirmar é a string `%Paulo*Lima%` por inteiro — as
    // letras com grafias viram classe (`P[aáàâãä…]…`).
    expect(filtro).not.toContain("Paulo  Lima");
    expect(filtro).toContain("name.imatch.");
  });

  it('palavras não adjacentes ("Paulo Jr") passam a achar "Paulo Lima Jr"', async () => {
    const { filtro } = await busca("Paulo Jr");
    expect(achouNoNome(filtro, PAULO_LIMA_JR), `filtro=${filtro}`).toBe(true);
    // O termo cru ("Paulo Jr", com o espaço que exige adjacência) é justamente o
    // que NÃO pode estar no filtro: quem exigisse adjacência casaria zero.
    expect(filtro).not.toContain("Paulo Jr");
  });

  it('vírgula ("Silva, Maria") não exige mais adjacência — nem injeção no or=', async () => {
    // DIGITADO com vírgula contra o contato cadastrado COM vírgula: o saneamento
    // antigo virava `Silva  Maria` (dois espaços literais) e não casava nada.
    const comVirgula = await busca("Silva, Maria");
    expect(comVirgula.filtro).not.toContain("Silva,");
    expect(achouNoNome(comVirgula.filtro, "Silva, Maria"), `filtro=${comVirgula.filtro}`).toBe(true);

    // E o outro sentido é o que a linha da issue quer dizer com "não exige
    // adjacência": digitar SEM a vírgula acha o cadastro QUE A TEM.
    const semVirgula = await busca("Silva Maria");
    expect(achouNoNome(semVirgula.filtro, "Silva, Maria"), `filtro=${semVirgula.filtro}`).toBe(true);
  });

  it('termo de 1 caractere ("a") NÃO consulta — devolver a lista inteira é ruído', async () => {
    const { aberturas, execucoes, filtro, resultado } = await busca("a");
    // Antes: `name.ilike.%a%` e a base inteira de volta, com 200 OK — parecia
    // resposta. Agora: nenhuma consulta, página vazia.
    expect(aberturas).toBe(0);
    expect(execucoes).toBe(0);
    expect(filtro).toBe("");
    expect(resultado).toEqual({ contacts: [], cursor: null, has_more: false });
  });

  it("só pontuação também não consulta — o piso mede DEPOIS de normalizar", async () => {
    // `", ,"` tem 3 caracteres crus e passaria por qualquer piso de comprimento;
    // normalizado vira string vazia, que no `ilike` seria `%%` e casaria TUDO.
    const { aberturas, execucoes } = await busca(", ,");
    expect(aberturas).toBe(0);
    expect(execucoes).toBe(0);
  });

  it.each(["()", "((", "(a", "a)", "( a )"])(
    'parêntese não fura o piso: "%s" NÃO consulta',
    async (termo) => {
      // O filtro tira os parênteses antes da régua; o piso tem de medir a MESMA
      // string. Medido o cru, "()" passava (2 caracteres) e consultava `%%`, e
      // "(a" consultava `%a%` — a lista inteira de volta, pela porta irmã de ", ,".
      const { aberturas, execucoes } = await busca(termo);
      expect(aberturas).toBe(0);
      expect(execucoes).toBe(0);
    },
  );

  it.each([
    "a,organization_id.neq.x",
    "a),or(id.not.is.null",
    "a,organization_id.eq.00000000-0000-0000-0000-000000000000,id.not.is.null",
    '"a"',
    "a.b:c",
    "a&or=(id.not.is.null)",
  ])('termo malicioso "%s" não abre condição nova no or= nem tira o filtro de org', async (termo) => {
    const { execucoes, filtro, igualdades } = await busca(termo);
    expect(execucoes).toBe(1);
    // Nenhum delimitador do DSL do `or=` sobra dentro de um valor: parêntese
    // aninharia, e cada vírgula restante tem de ser a que o handler pôs.
    expect(filtro).not.toMatch(/[()]/);
    const colunas = filtro.split(",").map((cond) => cond.split(".")[0]);
    expect(colunas).toEqual(["name", "display_name", "email", "phone_number"]);
    // O recorte por organização é parâmetro PRÓPRIO da query (E com o `or=`):
    // é ele que segura o caminho de service role (Bearer e MCP).
    expect(igualdades).toContainEqual(["organization_id", ORG]);
  });

  it("CONTROLE: termo de verdade continua consultando e filtrando", async () => {
    // Sem este par, uma implementação que recusasse TUDO passaria nos de cima.
    const { aberturas, execucoes, filtro } = await busca("Paulo");
    expect(aberturas).toBe(1);
    expect(execucoes).toBe(1);
    expect(filtro).not.toBe("");
    expect(achouNoNome(filtro, PAULO_LIMA_JR)).toBe(true);
    // E continua filtrando de verdade: quem não é o termo não casa.
    expect(achouNoNome(filtro, "Maria Silva")).toBe(false);
  });

  it("CONTROLE: o curinga digitado continua literal, não vira coringa", async () => {
    // Em regex o `%` não é curinga nenhum (o `LIKE` é que o tinha), e `_` também
    // não: o que o handler escapa hoje é o metacaractere do REGEX. Prova pelos
    // dois sentidos — casa com o `%` de verdade, não casa sem ele.
    const { filtro } = await busca("100%");
    expect(achouNoNome(filtro, "Plano 100%"), `filtro=${filtro}`).toBe(true);
    expect(achouNoNome(filtro, "Plano 1000"), `filtro=${filtro}`).toBe(false);
  });
});

/**
 * ─── A F2: o ACENTO casa dos DOIS LADOS ──────────────────────────────────────
 *
 * Medido na issue #1835: `ILIKE` dobra a CAIXA, não o ACENTO (`lower("Á") =
 * "á"`, que não é `"a"`), e o banco não tem `unaccent` nenhum — então "Joao"
 * não achava "João" e "MARCIA" não achava "Márcia". O #1892 deixou a F2
 * declaradamente de fora; é ela que este bloco vigia.
 *
 * O que se mede aqui é o FILTRO que sai do handler, traduzido para cá pelo
 * `regexCasa`. O banco de verdade (`tests/invariants`, `test:db`) e a tela
 * seguem fora, como no resto do arquivo — a prova do operador `imatch` contra
 * o PostgREST real está no corpo do PR.
 */
describe("busca de contatos: o acento casa dos dois lados (#1835, F2)", () => {
  it('"Joao" acha "João" — o defeito medido na issue, termo cru contra coluna acentuada', async () => {
    const { filtro } = await busca("Joao");
    expect(achouNoNome(filtro, "João Silva"), `filtro=${filtro}`).toBe(true);
    // E a classe não pode achar TODO mundo: quem não tem o nome não entra.
    expect(achouNoNome(filtro, "Josefina"), `filtro=${filtro}`).toBe(false);
  });

  it('"João" acha "Joao" — o sentido inverso, e continua achando a própria grafia', async () => {
    const { filtro } = await busca("João");
    expect(achouNoNome(filtro, "Joao Souza"), `filtro=${filtro}`).toBe(true);
    expect(achouNoNome(filtro, "João Silva"), `filtro=${filtro}`).toBe(true);
  });

  it('"MARCIA" acha "Márcia" e "Márcia" acha "Marcia" — caixa e acento juntos', async () => {
    const semAcento = await busca("MARCIA");
    expect(achouNoNome(semAcento.filtro, "Márcia Conceição"), `filtro=${semAcento.filtro}`).toBe(true);
    const comAcento = await busca("Márcia");
    expect(achouNoNome(comAcento.filtro, "Marcia"), `filtro=${comAcento.filtro}`).toBe(true);
  });

  it("CONTROLE: sem a classe de acento NÃO casa — é a classe, e não o emulador", () => {
    // As duas primeiras são a régua de identidade do caso: se o tradutor
    // passasse a casar tudo, "João" ficaria verde até com o padrão CRU e nenhum
    // dos testes de cima provaria nada. O padrão cru é exatamente o defeito da
    // issue — e ele reprova.
    expect(regexCasa(".*joao.*", "João")).toBe(false);
    expect(regexCasa(".*joao.*", "Joao")).toBe(true);
    // E o padrão que o MÓDULO emite fecha os dois sentidos e as duas caixas.
    const modulo = padraoRegexDeBusca("Joao");
    expect(regexCasa(modulo, "João")).toBe(true);
    expect(regexCasa(modulo, "Joao")).toBe(true);
    expect(regexCasa(modulo, "JOÃO")).toBe(true);
    expect(regexCasa(modulo, "Josefina")).toBe(false);
  });

  it("CONTROLE: telefone, emoji e nome sem acento continuam achando", async () => {
    // O saneamento novo tem de deixar o RESTO do filtro intacto.
    const telefone = await busca("3284793302");
    expect(telefone.filtro).toContain("phone_number.ilike.%5532984793302%");
    expect(telefone.filtro).toContain("phone_number.imatch.");

    // O emoji tem de atravessar a normalização inteiro: `semAcento` não pode
    // comer o variation selector que fecha o emoji (é por isso que ele só
    // remove `\p{M}` depois de `\p{L}`).
    const emoji = await busca("Maria 👍");
    expect(achouNoNome(emoji.filtro, "Maria 👍 Santos"), `filtro=${emoji.filtro}`).toBe(true);

    const nome = await busca("Silva");
    expect(achouNoNome(nome.filtro, "João Silva"), `filtro=${nome.filtro}`).toBe(true);
    expect(achouNoNome(nome.filtro, "Josefina"), `filtro=${nome.filtro}`).toBe(false);
  });
});

/**
 * ⛔ Os controles dos PRÓPRIOS emuladores.
 *
 * São eles quem decide se os casos de cima significam alguma coisa. Se algum
 * passasse a casar tudo, tudo ficaria verde com a busca destruída.
 */
describe("CONTROLE: o emulador mede o que diz medir", () => {
  it("regex: curinga `.` `*` cobre o meio; classe casa as DUAS grafias", () => {
    expect(regexCasa(".*Paulo.*Jr*", PAULO_LIMA_JR)).toBe(true);
    expect(regexCasa(".*Paulo.*", PAULO_LIMA_JR)).toBe(true);
    expect(regexCasa(".*[jJ]o[aáàâãä]o.*", "João")).toBe(true);
    expect(regexCasa(".*[jJ]o[aáàâãä]o.*", "Joao")).toBe(true);
  });

  it("regex: casamento é por INTEIRO — `.*` nas pontas, não casa pedaço qualquer", () => {
    expect(regexCasa(".*lmo.*", PAULO_LIMA_JR)).toBe(false);
    expect(regexCasa(".*Paulo.*", PAULO_LIMA_JR)).toBe(true);
  });

  it("ilike (as variantes de telefone): `*` cobre o meio, `%`/`_` escapado é literal", () => {
    expect(padraoCasa("%5532984793302%", "+5532984793302")).toBe(true);
    expect(padraoCasa("%Paulo*Jr%", PAULO_LIMA_JR)).toBe(true);
    expect(padraoCasa("100\\%", "100%")).toBe(true);
    expect(padraoCasa("100\\%", "1000")).toBe(false);
    expect(padraoCasa("a\\_b", "a_b")).toBe(true);
    expect(padraoCasa("a\\_b", "axb")).toBe(false);
    // E o `_` SEM escape é curinga de UM caractere — é o `LIKE` do SQL, e é por
    // isso que o digitado é escapado ali: sem o escape, "a_b" casaria "axb".
    expect(padraoCasa("a_b", "axb")).toBe(true);
    expect(padraoCasa("%Paulo  Lima%", PAULO_LIMA_JR)).toBe(false);
  });
});

/**
 * ─── O ESCAPE e os dois defeitos que a troca para regex podia trazer ────────
 *
 * Os termos dos blocos de cima não têm metacaractere nenhum, então nenhum deles
 * exercita o `escapar` — tirá-lo deixava tudo verde. Este bloco mede o escape,
 * o colapso dos `*` (sem ele, `a` + 400 `*` + `b` vira `.*.*.*…`: 28 s por
 * coluna, e com 3000 o Postgres recusa com `regular expression is too complex`)
 * e a letra acentuada FORA da tabela, que o `ilike` achava pela grafia exata.
 */
describe("busca de contatos: escape, colapso de * e acento fora da tabela (#2310)", () => {
  it('"a.*" é ponto LITERAL seguido de curinga — não vira o regex `.*`', () => {
    const padrao = padraoRegexDeBusca("a.*");
    expect(regexCasa(padrao, "a.x"), padrao).toBe(true);
    expect(regexCasa(padrao, "aXYZ"), padrao).toBe(false);
  });

  it.each([
    ["a[b", "a[b", "ab"],
    ["a\\b", "a\\b", "ab"],
    ["x{2}", "x{2}", "xx"],
    ["a+b", "a+b", "aab"],
    ["a|b", "a|b", "b"],
    ["^a$", "^a$", "a"],
  ])('"%s" casa só o literal', (termo, literal, metacaractere) => {
    const padrao = padraoRegexDeBusca(termo);
    expect(regexCasa(padrao, `Cliente ${literal}`), padrao).toBe(true);
    expect(regexCasa(padrao, `Cliente ${metacaractere}`), padrao).toBe(false);
  });

  it.each(["Peña", "Muñoz", "Zoë", "Ångela", "Lòpez"])(
    '"%s" acha a própria grafia — letra fora da tabela sai literal, como no ilike',
    (nome) => {
      const padrao = padraoRegexDeBusca(nome);
      expect(regexCasa(padrao, `${nome} Silva`), padrao).toBe(true);
      expect(regexCasa(padrao, `${nome.toUpperCase()} SILVA`), padrao).toBe(true);
    },
  );

  it("a letra DA tabela continua virando classe nos dois sentidos", () => {
    expect(regexCasa(padraoRegexDeBusca("Conceição"), "Conceicao")).toBe(true);
    expect(regexCasa(padraoRegexDeBusca("Conceicao"), "CONCEIÇÃO")).toBe(true);
  });

  it('"a***b" gera UM `.*` só — e 3000 asteriscos também', () => {
    expect(padraoRegexDeBusca("a***b").match(/\.\*/g)).toHaveLength(3);
    const longo = padraoRegexDeBusca(`a${"*".repeat(3000)}b`);
    expect(longo.match(/\.\*/g)).toHaveLength(3);
    expect(regexCasa(longo, "aXYZb")).toBe(true);
  });

  it("nenhum caractere digitado chega ao or= como , ( ou ) — pelo caminho do handler", async () => {
    // A função sozinha emite `\(` e `\)`: quem os tira é o handler, ANTES dela.
    // Por isso a varredura passa pelo handler, que é o que vai ao PostgREST.
    const amostra = [
      ...Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCharCode(0x20 + i)),
      " ", " ", "（", "）", "，", "،", "、", "ñ", "Å", "👍",
    ];
    for (const ch of amostra) {
      const { filtro, execucoes } = await busca(`ab${ch}cd`);
      expect(execucoes, JSON.stringify(ch)).toBe(1);
      expect(filtro, JSON.stringify(ch)).not.toMatch(/[()]/);
      const colunas = filtro.split(",").map((cond) => cond.split(".")[0]);
      expect(colunas, JSON.stringify(ch)).toEqual(["name", "display_name", "email", "phone_number"]);
    }
  });
});
