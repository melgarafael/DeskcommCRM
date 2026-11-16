/**
 * A BUSCA DE CONTATOS IGNORA ACENTO — PELA RÉGUA ÚNICA DA #3918 (#1835 → #3918).
 *
 * ─── O defeito, e o que mudou ────────────────────────────────────────────────
 * A listagem de contatos montava `name.imatch.*…*`, `display_name.imatch.*…*` e
 * `address_book_name.imatch.*…*`: um regex que imitava o `ILIKE`, e `ILIKE`
 * dobra a CAIXA, não o ACENTO (`lower("Á") = "á"`, que não é `"a"`). "Joao" não
 * achava "João"; "MARCIA" não achava "Márcia".
 *
 * A #1835 resolveu isso com uma régua PRÓPRIA (`lib/contacts/busca-regex.ts`,
 * classes de grafia como `[aáàâãä]`). A #3924 criou a coluna GERADA
 * `contacts.busca_sem_acento` — `lower(public.f_unaccent(display_name, name,
 * address_book_name))` — e a busca do inbox passou a usá-la. A #3918, fatia 2,
 * traz Contatos, seletor e a ferramenta do agente para a MESMA coluna e aposenta
 * a régua em regex: duas réguas de acento divergem no primeiro ajuste.
 *
 * ─── O que este teste mede, e o que ele NÃO mede ─────────────────────────────
 * Não há banco no `tests/unit`. O que se mede é o FILTRO que sai do handler e,
 * com ele, a composição do termo (normalizar → gramática do `or=` → sem acento).
 * O valor da coluna é emulado com `termoSemAcento` + um `LIKE` de verdade
 * (`padraoCasa`), que é a mesma regra dos dois lados — este arquivo prova que o
 * filtro CHEGA limpo; que o banco CASA é
 * `tests/invariants/busca-de-contatos-ignora-acento.test.ts` (`test:db`), com
 * `unaccent` e a coluna gerada de verdade.
 *
 * O `imatch` saiu: onde este arquivo fala de `like`, o PostgREST converte `*`
 * em `%` e o SQL do Postgres faz o casamento. Nada de regex.
 */
import { describe, expect, it } from "vitest";

import { listContactsHandler } from "@/app/api/v1/contacts/_handler";
import { termoSemAcento } from "@/lib/inbox/termo-de-busca";

const ORG = "11111111-1111-4111-8111-111111111111";

/** O contato que a #1835 usou para medir os casos de separador. */
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
 * O dublê conhece todos os elos que o handler encadeia: um elo que falta não
 * vira "asserção que não passa", vira `TypeError` no meio da consulta.
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

async function busca(termo: string, soContato?: string) {
  const { client, estado } = supabaseEspiao();
  const resultado = await listContactsHandler(
    client,
    { organization_id: ORG, actor: { type: "user", id: "u-1" }, requestId: "req" },
    { search: termo, limit: 20 },
    soContato,
  );
  return {
    resultado,
    aberturas: estado.aberturas,
    execucoes: estado.execucoes,
    // `filtros` pode ter mais de um `.or()`: termo com cara de telefone consulta
    // os telefones extras ANTES do filtro principal. O que interessa é o último
    // — a condição que a listagem executa.
    filtro: estado.filtros[estado.filtros.length - 1] ?? "",
    igualdades: estado.igualdades,
  };
}

function escapeRegex(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * O `LIKE` do PostgREST em duas linhas declaradas.
 *
 * PostgREST traduz `*` no valor para `%` do SQL; `%` e `_` escapados com barra
 * voltada são literais (é o que `termoSeguroParaOr` faz com o que a PESSOA
 * digitou); o resto é casamento por inteiro — o `LIKE` sobre a coluna gerada,
 * que já é minúscula.
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

type Operador = "like" | "ilike";

/** Todas as condições `coluna.operador.padrao` que o handler pôs no `.or()`. */
function condicoes(filtro: string): Array<{ coluna: string; operador: Operador; padrao: string }> {
  return [...filtro.matchAll(/(\w+)\.(like|ilike)\.([^,]+)/g)].map((m) => ({
    coluna: m[1]!,
    operador: m[2] as Operador,
    padrao: m[3]!,
  }));
}

/**
 * Uma condição traduzida para cá.
 *
 * Nas colunas de NOME o valor do banco é `lower(f_unaccent(...))`, então o
 * emulador aplica `termoSemAcento` antes do `LIKE`. Email e telefone são
 * comparados crus (não têm acento).
 */
function casa(condicao: { coluna: string; padrao: string }, valor: string): boolean {
  const doBanco = condicao.coluna.startsWith("busca_sem_acento") ? termoSemAcento(valor) : valor;
  return padraoCasa(condicao.padrao, doBanco);
}

/** O filtro ACHOU o nome? (as colunas de nome — `busca_sem_acento*`.) */
function achouNoNome(filtro: string, nome: string): boolean {
  return condicoes(filtro)
    .filter((c) => c.coluna.startsWith("busca_sem_acento"))
    .some((c) => casa(c, nome));
}

describe("busca de contatos: o termo é normalizado pela régua do repo (#1835, F1)", () => {
  it('espaço duplo ("Paulo  Lima") passa a achar "Paulo Lima Jr"', async () => {
    const { filtro } = await busca("Paulo  Lima");
    expect(achouNoNome(filtro, PAULO_LIMA_JR), `filtro=${filtro}`).toBe(true);
    expect(filtro).not.toContain("Paulo  Lima");
    expect(filtro).toContain("busca_sem_acento.like.");
  });

  it('palavras não adjacentes ("Paulo Jr") passam a achar "Paulo Lima Jr"', async () => {
    const { filtro } = await busca("Paulo Jr");
    expect(achouNoNome(filtro, PAULO_LIMA_JR), `filtro=${filtro}`).toBe(true);
    // O termo cru (com o espaço que exigiria adjacência) não pode estar no filtro.
    expect(filtro).not.toContain("Paulo Jr");
  });

  it('vírgula ("Silva, Maria") não exige mais adjacência — nem injeção no or=', async () => {
    const comVirgula = await busca("Silva, Maria");
    expect(comVirgula.filtro).not.toContain("Silva,");
    expect(achouNoNome(comVirgula.filtro, "Silva, Maria"), `filtro=${comVirgula.filtro}`).toBe(
      true,
    );

    const semVirgula = await busca("Silva Maria");
    expect(achouNoNome(semVirgula.filtro, "Silva, Maria"), `filtro=${semVirgula.filtro}`).toBe(
      true,
    );
  });

  it('termo de 1 caractere ("a") NÃO consulta — devolver a lista inteira é ruído', async () => {
    const { aberturas, execucoes, filtro, resultado } = await busca("a");
    expect(aberturas).toBe(0);
    expect(execucoes).toBe(0);
    expect(filtro).toBe("");
    expect(resultado).toEqual({ contacts: [], cursor: null, has_more: false });
  });

  it("só pontuação também não consulta — o piso mede DEPOIS de normalizar", async () => {
    const { aberturas, execucoes } = await busca(", ,");
    expect(aberturas).toBe(0);
    expect(execucoes).toBe(0);
  });

  it.each(["()", "((", "(a", "a)", "( a )"])(
    'parêntese não fura o piso: "%s" NÃO consulta',
    async (termo) => {
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
  ])(
    'termo malicioso "%s" não abre condição nova no or= nem tira o filtro de org',
    async (termo) => {
      const { execucoes, filtro, igualdades } = await busca(termo);
      expect(execucoes).toBe(1);
      // Nenhum delimitador do DSL do `or=` sobra dentro de um valor: parêntese
      // aninharia, e cada vírgula restante tem de ser a que o handler pôs.
      expect(filtro).not.toMatch(/[()]/);
      const colunas = filtro.split(",").map((cond) => cond.split(".")[0]);
      expect(colunas).toEqual(["busca_sem_acento", "email", "phone_number"]);
      // O recorte por organização é parâmetro PRÓPRIO da query (E com o `or=`):
      // é ele que segura o caminho de service role (Bearer e MCP).
      expect(igualdades).toContainEqual(["organization_id", ORG]);
    },
  );

  it("CONTROLE: termo de verdade continua consultando e filtrando", async () => {
    const { aberturas, execucoes, filtro } = await busca("Paulo");
    expect(aberturas).toBe(1);
    expect(execucoes).toBe(1);
    expect(filtro).not.toBe("");
    expect(achouNoNome(filtro, PAULO_LIMA_JR)).toBe(true);
    expect(achouNoNome(filtro, "Maria Silva")).toBe(false);
  });

  it("CONTROLE: o `%` digitado continua literal, não vira coringa", async () => {
    // Sem o escape de `termoSeguroParaOr`, `%` no LIKE casaria TUDO — e "a lista
    // toda" se parece com "a busca funcionou". Prova pelos dois sentidos.
    const { filtro } = await busca("100%");
    expect(achouNoNome(filtro, "Plano 100%"), `filtro=${filtro}`).toBe(true);
    expect(achouNoNome(filtro, "Plano 1000"), `filtro=${filtro}`).toBe(false);
    expect(achouNoNome(filtro, "Maria Silva"), `filtro=${filtro}`).toBe(false);
  });

  it("CONTROLE: `_` digitado também é literal", async () => {
    const { filtro } = await busca("a_b");
    expect(achouNoNome(filtro, "a_b"), `filtro=${filtro}`).toBe(true);
    expect(achouNoNome(filtro, "axb"), `filtro=${filtro}`).toBe(false);
  });
});

/**
 * ─── O ACENTO, dos DOIS LADOS (#3918) ────────────────────────────────────────
 *
 * O defeito medido no relato: "Andreia" não achava "Andréia" e "Andréia" não
 * achava "Andreia". A simetria é o que importa: quem digita com acento e quem
 * digita sem têm de chegar ao MESMO cadastro.
 */
describe("busca de contatos: o acento casa dos dois lados (#3918)", () => {
  it('"Andreia" acha "Andréia" — o defeito literal do relato', async () => {
    const { filtro } = await busca("Andreia");
    expect(achouNoNome(filtro, "Andréia Souza"), `filtro=${filtro}`).toBe(true);
  });

  it('"Andréia" acha "Andreia" — o sentido inverso', async () => {
    const { filtro } = await busca("Andréia");
    expect(achouNoNome(filtro, "Andreia Souza"), `filtro=${filtro}`).toBe(true);
    expect(achouNoNome(filtro, "Andréia Souza"), `filtro=${filtro}`).toBe(true);
  });

  it.each([
    ["Leticia", "Letícia Lima"],
    ["Letícia", "Leticia Lima"],
    ["Joao", "João Pereira"],
    ["João", "Joao Pereira"],
    ["Conceicao", "Conceição Alves"],
    ["Conceição", "Conceicao Alves"],
    ["Julia", "Júlia Ramos"],
  ])('"%s" acha "%s"', async (termo, nome) => {
    const { filtro } = await busca(termo);
    expect(achouNoNome(filtro, nome), `filtro=${filtro}`).toBe(true);
  });

  it('"MARCIA" acha "Márcia" — caixa e acento juntos', async () => {
    const { filtro } = await busca("MARCIA");
    expect(achouNoNome(filtro, "Márcia Conceição"), `filtro=${filtro}`).toBe(true);
  });

  it("não vira 'acha tudo': termo sem relação continua sem casar", async () => {
    const { filtro } = await busca("Andreia");
    expect(achouNoNome(filtro, "Josefina"), `filtro=${filtro}`).toBe(false);
    expect(achouNoNome(filtro, "Marcia"), `filtro=${filtro}`).toBe(false);
  });

  it("cedilha, hífen e apóstrofo atravessam a régua inteiros", async () => {
    const { filtro: conceicao } = await busca("Conceição");
    expect(achouNoNome(conceicao, "Conceicao")).toBe(true);

    const { filtro: hifen } = await busca("Ana-Maria");
    expect(achouNoNome(hifen, "Ana-Maria Silva"), `filtro=${hifen}`).toBe(true);

    const { filtro: apostrofo } = await busca("D'Avila");
    expect(achouNoNome(apostrofo, "D'Avila Costa"), `filtro=${apostrofo}`).toBe(true);
  });

  it("acento fora do português também casa — a coluna é NFD, não tabela de grafias", async () => {
    // A régua aposentada (#1835) só conhecia as letras da tabela PT: `ñ` e `ü`
    // saíam literais, e "Pena" não achava "Peña". É o ganho da régua única.
    const { filtro: pena } = await busca("Pena");
    expect(achouNoNome(pena, "Peña & Müller"), `filtro=${pena}`).toBe(true);
    const { filtro: muller } = await busca("Muller");
    expect(achouNoNome(muller, "Peña & Müller"), `filtro=${muller}`).toBe(true);
  });

  it("emoji continua achando — a remoção de marca não come o emoji", async () => {
    const { filtro } = await busca("Maria 👍");
    expect(achouNoNome(filtro, "Maria 👍 Santos"), `filtro=${filtro}`).toBe(true);
  });
});

/**
 * ─── As OUTRAS colunas do OR, e o `soContato` ─────────────────────────────────
 */
describe("busca de contatos: as outras portas continuam de pé", () => {
  it("telefone e email seguem no OR, com as variantes de número", async () => {
    const { filtro } = await busca("3284793302");
    expect(filtro).toContain("phone_number.ilike.*3284793302*");
    expect(filtro).toContain("phone_number.ilike.%5532984793302%");
    expect(filtro).toContain("email.ilike.*3284793302*");
  });

  it("a busca do agente durante a conversa NÃO olha o nome da agenda (#2439)", async () => {
    // `busca_sem_acento` carrega display_name + name + address_book_name; com o
    // contato do turno, casar na agenda faria a ferramenta responder ao modelo
    // se o rótulo interno contém o termo — o mesmo vazamento que a guarda
    // SO_DA_EQUIPE fecha no template. A coluna sem agenda é a que entra.
    const filtro = (await busca("caloteira", "22222222-2222-4222-8222-222222222222")).filtro;
    expect(filtro).not.toContain("address_book_name");
    expect(filtro).toContain("busca_sem_acento_sem_agenda.like.");
    expect(filtro).not.toContain("busca_sem_acento.like.");
    // E o resto da busca continua igual.
    expect(filtro).toContain("email.ilike.");
  });

  it("nenhum caractere digitado chega ao or= como , ( ou ) — pelo caminho do handler", async () => {
    const amostra = [
      ...Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCharCode(0x20 + i)),
      " ",
      " ",
      "（",
      "）",
      "，",
      "،",
      "、",
      "ñ",
      "Å",
      "👍",
    ];
    for (const ch of amostra) {
      const { filtro, execucoes } = await busca(`ab${ch}cd`);
      expect(execucoes, JSON.stringify(ch)).toBe(1);
      expect(filtro, JSON.stringify(ch)).not.toMatch(/[()]/);
      const colunas = filtro.split(",").map((cond) => cond.split(".")[0]);
      expect(colunas, JSON.stringify(ch)).toEqual(["busca_sem_acento", "email", "phone_number"]);
    }
  });
});
