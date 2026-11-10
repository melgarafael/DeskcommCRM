import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { renderTemplate } from "@/lib/automation/template";
import {
  RAIZES_DE_CAMPO as RAIZES_DA_CAMPANHA,
  renderizar,
  VARIAVEIS_DA_CAMPANHA,
} from "@/lib/campanhas/renderizador";
import { valorDaFonte, type FonteDeVariavel } from "@/lib/channels/meta/variaveis-do-fluxo";
import { interpolateTemplate } from "@/lib/inbox/template-vars";
import { substituirVariaveis } from "@/lib/propostas/documento/variaveis";
import {
  ARQUIVOS_DOS_RESOLVEDORES,
  LACUNAS_CONHECIDAS,
  RAIZES_DE_CAMPO,
  RESOLVEDORES,
  SENTIDOS_DIVERGENTES,
  SUFIXO_DE_CURINGA,
  VARIAVEIS_DO_CATALOGO,
  VOCABULARIOS_ABERTOS,
  eCuringa,
  exclusivasDe,
  nomesDoCatalogo,
  normalizarToken,
  variavelDoCatalogo,
  variaveisDe,
} from "@/lib/variaveis/catalogo";

/**
 * O CATÁLOGO SÓ VALE SE DESCREVER O QUE EXISTE — e é isto que este arquivo prova.
 *
 * A tentação de um catálogo único é escrever o vocabulário que se GOSTARIA de
 * ter. Aí ele fica bonito e mentiroso: a tela oferece `{{saudacao}}` numa
 * automação, onde o token sai como string VAZIA na mensagem do cliente. Por isso
 * cada fonte de verdade do produto é lida e conferida contra o catálogo, uma a
 * uma, com o arquivo na mensagem de erro:
 *
 *   - Inbox            · `lib/inbox/template-vars.ts`
 *   - Campanha         · `lib/campanhas/renderizador.ts`
 *   - Automação        · `lib/automation/template.ts`
 *   - Fluxo (Meta)     · `lib/channels/meta/variaveis-do-fluxo.ts`
 *   - Seletor da tela  · `app/app/webhooks/_components/ActionConfigForm.tsx`
 *
 * Proposta e os campos criados pela organização não têm lista fechada: ficam
 * declarados em `VOCABULARIOS_ABERTOS`, e o teste prova a declaração em vez de
 * fingir paridade.
 *
 * A lista de vocabulário NÃO é redigitada aqui: ela sai do próprio fonte (o
 * array exportado da campanha, o literal `VARIAVEIS_DE_NOME` do Inbox, o
 * `ALIASES` do renderTemplate, os `kind` do schema do fluxo). Quando alguém
 * acrescentar uma variável lá e esquecer aqui, o teste reprova onde a pessoa
 * está editando.
 */

const RAIZ = join(__dirname, "..", "..");
const CATALOGO = join(RAIZ, "lib", "variaveis", "catalogo.ts");
const INBOX = "lib/inbox/template-vars.ts";
const CAMPANHA = "lib/campanhas/renderizador.ts";
const AUTOMACAO = "lib/automation/template.ts";
const FLUXO = "lib/channels/meta/variaveis-do-fluxo.ts";
const SELETOR = "app/app/webhooks/_components/ActionConfigForm.tsx";
const PROPOSTA = "lib/propostas/documento/variaveis.ts";

const fonte = (arquivo: string): string => readFileSync(join(RAIZ, arquivo), "utf8");

/**
 * Um array literal do fonte (`const X = ["a", "b"]`), lido por regex. Se o nome
 * sumir, o `throw` reprova com mensagem em vez de passar com lista vazia.
 */
function listaDoFonte(texto: string, nome: string): string[] {
  const bloco = new RegExp(`${nome}\\s*=\\s*\\[([^\\]]*)\\]`).exec(texto);
  if (!bloco) throw new Error(`${nome} não encontrada no fonte`);
  return [...(bloco[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

/** As CHAVES de um objeto literal do fonte (`const ALIASES = { nome: "..." }`). */
function chavesDoObjeto(texto: string, nome: string): string[] {
  const bloco = new RegExp(`${nome}(?:\\s*:[^=]+)?\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`).exec(texto);
  if (!bloco) throw new Error(`${nome} não encontrado no fonte`);
  const chaves = [...(bloco[1] ?? "").matchAll(/^\s*([a-zA-Z_][a-zA-Z0-9_]*):\s*"/gm)].map(
    (m) => m[1] as string,
  );
  if (chaves.length === 0) throw new Error(`${nome} está vazio no fonte`);
  return chaves;
}

/** O Inbox não exporta a lista (é detalhe interno), mas é ELA que o catálogo espelha. */
const VARIAVEIS_DO_INBOX = listaDoFonte(fonte(INBOX), "const VARIAVEIS_DE_NOME");

/** O da campanha: as chaves fechadas + as duas raízes de campo, que são caminho. */
const VARIAVEIS_DA_CAMPANHA_DO_FONTE = listaDoFonte(fonte(CAMPANHA), "VARIAVEIS_DA_CAMPANHA");

/** Os aliases de `renderTemplate` — o vocabulário que a automação conhece por nome. */
const ALIASES_DA_AUTOMACAO = chavesDoObjeto(fonte(AUTOMACAO), "const ALIASES");

/** As origens que o schema do modelo aprovado aceita (`fonteDeVariavelSchema`). */
const ORIGENS_DO_FLUXO = [
  ...fonte(FLUXO).matchAll(/kind:\s*z\.literal\("([a-z_]+)"\)/g),
].map((m) => m[1] as string);

/** Os três botões fixos do seletor de variável da automação. */
const TOKENS_DO_SELETOR = [
  ...(/const TEMPLATE_VARS = \[([\s\S]*?)\n\];/.exec(fonte(SELETOR))?.[1] ?? "").matchAll(
    /\{\{\s*([^}]+?)\s*\}\}/g,
  ),
].map((m) => m[1] as string);

const CONTATO = { name: "Ana Souza" };
const VALORES = {
  nome: "Ana Souza",
  lead: { gancho: "do bolo", title: "Maria" },
  contato: { gancho: "ctt" },
};
/** 15:00Z = meio-dia em São Paulo — o primeiro segundo de "Boa tarde". */
const QUANDO = { agora: new Date("2026-10-29T15:00:00Z"), fuso: "America/Sao_Paulo" };
/** O contexto da automação é `{ contact, lead }` — LINHAS inteiras. */
const CONTEXTO = {
  contact: {
    name: "Ana Souza",
    phone_number: "+5511999998888",
    email: "ana@exemplo.com",
    custom_fields: { gancho: "cf-contato" },
  },
  lead: { title: "Negocio X", custom_fields: { gancho: "cf-negocio" } },
};

/**
 * Um token de exemplo por linha do catálogo. A igualdade de chaves (teste da
 * forma) obriga quem acrescentar uma linha a escolher um exemplo aqui — sem
 * isso, o `lacunas` e o `sentido` abaixo passariam a conferir menos sem avisar.
 */
const TOKEN_DE_EXEMPLO: Record<string, string> = {
  nome: "{{nome}}",
  primeiro_nome: "{{primeiro_nome}}",
  saudacao: "{{saudacao}}",
  telefone: "{{telefone}}",
  email: "{{email}}",
  "lead.*": "{{lead.gancho}}",
  "contato.*": "{{contato.gancho}}",
  "contact.*": "{{contact.phone_number}}",
};

describe("o catálogo descreve o que o Inbox e a campanha fazem, variável por variável", () => {
  const casos: { token: string; inbox: string; campanha: string }[] = [
    { token: "{{nome}}", inbox: "Ana Souza", campanha: "Ana Souza" },
    { token: "{{primeiro_nome}}", inbox: "Ana", campanha: "Ana" },
    { token: "{{saudacao}}", inbox: "{{saudacao}}", campanha: "Boa tarde" },
    { token: "{{lead.gancho}}", inbox: "{{lead.gancho}}", campanha: "do bolo" },
    {
      token: "{{contato.gancho}}",
      inbox: "{{contato.gancho}}",
      campanha: "ctt",
    },
  ];

  for (const caso of casos) {
    it(`${caso.token}: Inbox devolve "${caso.inbox}", campanha devolve "${caso.campanha}"`, () => {
      const inbox = interpolateTemplate(caso.token, CONTATO);
      const campanha = renderizar(caso.token, VALORES, QUANDO);

      expect(inbox).toBe(caso.inbox);
      expect(campanha.texto).toBe(caso.campanha);
      expect(campanha.faltando).toEqual([]);
      expect(campanha.desconhecidas).toEqual([]);

      // A linha do catálogo é o que os dois ACABARAM de fazer — não o contrário.
      const resolveram = (["inbox", "campanha"] as const).filter((r) =>
        r === "inbox" ? inbox !== caso.token : campanha.texto !== caso.token,
      );
      const entrada = variavelDoCatalogo(caso.token);
      expect(entrada, `${caso.token} não está no catálogo`).not.toBeNull();
      for (const r of resolveram) {
        expect(entrada!.disponivelEm, `${caso.token} resolve em ${r} e o catálogo não diz`).toContain(
          r,
        );
      }
    });
  }
});

describe("o catálogo descreve o que a automação faz, variável por variável", () => {
  const casos: { token: string; esperado: string }[] = [
    { token: "{{nome}}", esperado: "Ana Souza" },
    { token: "{{primeiro_nome}}", esperado: "Ana" },
    // O telefone é o valor do contato — nunca um literal reescrito aqui (a
    // saída passa por mascaramento de privacidade no ambiente de teste).
    { token: "{{telefone}}", esperado: CONTEXTO.contact.phone_number },
    { token: "{{email}}", esperado: "ana@exemplo.com" },
    // A lacuna mais cara do produto: não é literal, é VAZIO — some sem aviso.
    { token: "{{saudacao}}", esperado: "" },
    // `{{lead.title}}` aqui é a COLUNA do card, não campo personalizado.
    { token: "{{lead.title}}", esperado: "Negocio X" },
    { token: "{{lead.custom_fields.gancho}}", esperado: "cf-negocio" },
    { token: "{{gancho}}", esperado: "cf-negocio" },
    { token: "{{contact.custom_fields.gancho}}", esperado: "cf-contato" },
  ];

  for (const caso of casos) {
    it(`${caso.token}: renderTemplate devolve "${caso.esperado}"`, () => {
      expect(renderTemplate(caso.token, CONTEXTO)).toBe(caso.esperado);
    });
  }
});

describe("toda variável que uma fonte conhece está no catálogo", () => {
  it(`Inbox (${INBOX}): ${VARIAVEIS_DO_INBOX.join(", ")}`, () => {
    expect([...variaveisDe("inbox")].sort()).toEqual([...VARIAVEIS_DO_INBOX].sort());
  });

  it(`campanha (${CAMPANHA}): chaves fechadas + raízes de campo`, () => {
    expect([...VARIAVEIS_DA_CAMPANHA]).toEqual(VARIAVEIS_DA_CAMPANHA_DO_FONTE);
    const esperado = [
      ...VARIAVEIS_DA_CAMPANHA_DO_FONTE,
      ...RAIZES_DA_CAMPANHA.map((raiz) => `${raiz}${SUFIXO_DE_CURINGA}`),
    ];
    expect([...variaveisDe("campanha")].sort()).toEqual(esperado.sort());
  });

  it(`automação (${AUTOMACAO}): todo alias de renderTemplate`, () => {
    expect(ALIASES_DA_AUTOMACAO.length).toBeGreaterThan(0);
    for (const chave of ALIASES_DA_AUTOMACAO) {
      const token = `{{${chave}}}`;
      const entrada = variavelDoCatalogo(token);
      expect(
        entrada,
        `${chave} resolve em ${AUTOMACAO} (ALIASES) e não está no catálogo`,
      ).not.toBeNull();
      expect(entrada!.disponivelEm, `${chave} existe em ${AUTOMACAO} e o catálogo não diz`).toContain(
        "automacao",
      );
    }
  });

  it(`automação (${AUTOMACAO}): cada alias resolve de verdade, não só está escrito`, () => {
    // A paridade é com o MOTOR, não com a constante: um alias acrescentado ao
    // `ALIASES` sem caminho no contexto ficaria catalogado e morto.
    const esperado: Record<string, string> = {
      nome: "Ana Souza",
      primeiro_nome: "Ana",
      telefone: CONTEXTO.contact.phone_number,
      email: "ana@exemplo.com",
    };
    for (const chave of ALIASES_DA_AUTOMACAO) {
      const esperadoDaChave = esperado[chave];
      expect(
        esperadoDaChave,
        `${chave} é alias novo em ${AUTOMACAO}: escolha o valor esperado neste teste`,
      ).toBeDefined();
      expect(renderTemplate(`{{${chave}}}`, CONTEXTO)).toBe(esperadoDaChave);
    }
  });

  it(`fluxo (${FLUXO}): toda origem de fonteDeVariavelSchema`, () => {
    // O fluxo fala posição (`{{1}}`), não nome: o mapeamento abaixo é a tradução
    // de origem → token que o catálogo cataloga.
    const tokenDaOrigem: Record<string, string> = {
      contact_name: "{{nome}}",
      contact_first_name: "{{primeiro_nome}}",
      lead_custom: "{{lead.gancho}}",
    };
    expect(ORIGENS_DO_FLUXO.length).toBeGreaterThan(0);
    // Igualdade exata: origem nova no schema obriga revisar a tradução.
    expect(Object.keys(tokenDaOrigem).sort()).toEqual([...new Set(ORIGENS_DO_FLUXO)].sort());

    for (const origem of ORIGENS_DO_FLUXO) {
      const token = tokenDaOrigem[origem]!;
      const entrada = variavelDoCatalogo(token);
      expect(
        entrada,
        `a origem "${origem}" de ${FLUXO} preenche ${token}, que não está no catálogo`,
      ).not.toBeNull();
      expect(
        entrada!.disponivelEm,
        `a origem "${origem}" de ${FLUXO} existe e o catálogo não lista fluxo em ${token}`,
      ).toContain("fluxo");
    }
  });

  it(`fluxo (${FLUXO}): cada origem resolve o valor que o catálogo promete`, () => {
    const dados = { nomeDoContato: "Ana Souza", camposDoNegocio: { gancho: "do bolo" } };
    const esperado: { fonte: FonteDeVariavel; valor: string | null }[] = [
      { fonte: { kind: "contact_name" }, valor: "Ana Souza" },
      { fonte: { kind: "contact_first_name" }, valor: "Ana" },
      { fonte: { kind: "lead_custom", key: "gancho" }, valor: "do bolo" },
      { fonte: { kind: "lead_custom", key: "naoexiste" }, valor: null },
    ];
    for (const caso of esperado) expect(valorDaFonte(caso.fonte, dados)).toBe(caso.valor);
  });

  it(`seletor da automação (${SELETOR}): todo botão fixo é uma variável catalogada`, () => {
    // O seletor é TELA, não resolvedor: ele não pode oferecer mais que o motor.
    expect(TOKENS_DO_SELETOR.length).toBeGreaterThan(0);
    for (const token of TOKENS_DO_SELETOR) {
      const entrada = variavelDoCatalogo(`{{${token}}}`);
      expect(entrada, `o botão "{{${token}}}" de ${SELETOR} não está no catálogo`).not.toBeNull();
      expect(
        entrada!.disponivelEm,
        `o botão "{{${token}}}" de ${SELETOR} não resolve na automação, que é a tela dele`,
      ).toContain("automacao");
      // Botão que insere token que o motor não resolve é promessa vazia.
      expect(renderTemplate(`{{${token}}}`, CONTEXTO)).not.toBe(`{{${token}}}`);
    }
  });
});

describe("a divergência entre as fontes não fica escondida", () => {
  it("as lacunas são EXATAMENTE as que o catálogo declara", () => {
    const derivadas = VARIAVEIS_DO_CATALOGO.flatMap((v) =>
      RESOLVEDORES.filter((r) => !v.disponivelEm.includes(r)).map((r) => `${v.nome}@${r}`),
    ).sort();
    const escritas = LACUNAS_CONHECIDAS.map((l) => `${l.variavel}@${l.fonte}`).sort();

    // Igualdade, não `>=`: lacuno a mais é catálogo que mente sobre a fonte, e
    // lacuno a menos é divergência que fica sem explicação para o operador.
    expect(escritas).toEqual(derivadas);
  });

  it("cada lacuna nomeia o efeito no operador e a variável existe no catálogo", () => {
    for (const lacuna of LACUNAS_CONHECIDAS) {
      expect(variavelDoCatalogo(TOKEN_DE_EXEMPLO[lacuna.variavel] ?? ""), lacuna.variavel).not.toBeNull();
      expect(lacuna.efeito.trim(), `${lacuna.variavel}@${lacuna.fonte} sem efeito escrito`).not.toBe(
        "",
      );
    }
  });

  it("no Inbox, TODA lacuna de lá sai literal — o token chega ao cliente", () => {
    const doInbox = LACUNAS_CONHECIDAS.filter((l) => l.fonte === "inbox");
    expect(doInbox.map((l) => l.variavel).sort()).toEqual(
      ["contact.*", "contato.*", "email", "lead.*", "saudacao", "telefone"].sort(),
    );
    for (const lacuna of doInbox) {
      const token = TOKEN_DE_EXEMPLO[lacuna.variavel]!;
      expect(interpolateTemplate(token, CONTATO)).toBe(token);
    }
  });

  it("na automação, saudação e caminho de contato saem VAZIOS — pior que literal", () => {
    expect(LACUNAS_CONHECIDAS.some((l) => l.variavel === "saudacao" && l.fonte === "automacao")).toBe(
      true,
    );
    expect(renderTemplate("Bom dia, {{primeiro_nome}}! {{saudacao}}", CONTEXTO)).toBe(
      "Bom dia, Ana! ",
    );
    // `{{contato.gancho}}` (a sintaxe da campanha) não existe no contexto da
    // automação: sai vazio, sem `desconhecidas` e sem aviso ao operador.
    expect(renderTemplate("{{contato.gancho}}", CONTEXTO)).toBe("");
  });

  it("na campanha, token desconhecido fica literal E entra em `desconhecidas`", () => {
    const r = renderizar("{{telefone}}", VALORES, QUANDO);
    expect(r.texto).toBe("{{telefone}}");
    expect(r.desconhecidas).toEqual(["telefone"]);
    expect(r.faltando).toEqual([]);
  });

  it("os caminhos com MAIS DE UM sentido estão declarados em SENTIDOS_DIVERGENTES", () => {
    const curingasComVariasFontes = VARIAVEIS_DO_CATALOGO.filter(
      (v) => eCuringa(v.nome) && v.disponivelEm.length > 1,
    ).map((v) => v.nome);
    expect(SENTIDOS_DIVERGENTES.map((s) => s.variavel).sort()).toEqual(curingasComVariasFontes.sort());
  });

  it("`{{lead.title}}` é a divergência que mais engana: mesmo token, valores diferentes", () => {
    const declarada = SENTIDOS_DIVERGENTES.find((s) => s.variavel === "lead.*");
    expect(declarada, "lead.* tem mais de um sentido e não está declarado").toBeDefined();
    expect(Object.keys(declarada!.sentidoPorFonte).sort()).toEqual(["automacao", "campanha", "fluxo"]);

    // Mesmo token, dois valores: a coluna do card na automação, o campo
    // personalizado na campanha. Quem copia o texto de uma tela para outra
    // recebe o dado errado (ou nada).
    expect(renderTemplate("{{lead.title}}", CONTEXTO)).toBe("Negocio X");
    expect(renderizar("{{lead.title}}", VALORES, QUANDO).texto).toBe("Maria");
    expect(renderizar("{{lead.title}}", { nome: "Ana" }, QUANDO).faltando).toEqual(["lead.title"]);
  });
});

describe("o que não tem lista fechada está declarado, não fingido", () => {
  it("proposta: resolve QUALQUER caminho, e o catálogo não finge catalogá-lo", () => {
    const documento = substituirVariaveis("{{cliente.nome}} — {{valor}}", {
      cliente: { nome: "Ana" },
      valor: 10,
    });
    expect(documento.textoRenderizado).toBe("Ana — 10");
    expect(variavelDoCatalogo("{{cliente.nome}}")).toBeNull();

    const declarada = VOCABULARIOS_ABERTOS.find((v) => v.arquivo === PROPOSTA);
    expect(declarada, `${PROPOSTA} resolve variáveis e não está declarado`).toBeDefined();
    expect(declarada!.motivo.trim()).not.toBe("");
  });

  it("todo vocabulário aberto declarado aponta arquivo que existe e explica o porquê", () => {
    expect(VOCABULARIOS_ABERTOS.length).toBeGreaterThan(0);
    for (const aberto of VOCABULARIOS_ABERTOS) {
      expect(aberto.dialeto.trim()).not.toBe("");
      expect(aberto.motivo.trim()).not.toBe("");
      expect(() => fonte(aberto.arquivo), `${aberto.arquivo} não existe`).not.toThrow();
    }
  });

  it("toda fonte conhecida de `{{...}}` está coberta ou declarada", () => {
    // A lista é a do produto, escrita uma vez: fonte nova entra aqui na mesma
    // edição em que nasce, ou o teste não deixa esquecer.
    const conhecidas = [INBOX, CAMPANHA, AUTOMACAO, FLUXO, SELETOR, PROPOSTA];
    const declaradas = [
      ...Object.values(ARQUIVOS_DOS_RESOLVEDORES),
      ...VOCABULARIOS_ABERTOS.map((v) => v.arquivo),
    ];
    for (const arquivo of conhecidas) {
      expect(() => fonte(arquivo), `${arquivo} sumiu do repositório`).not.toThrow();
      expect(
        declaradas,
        `${arquivo} não está nem coberto por um resolvedor nem declarado em VOCABULARIOS_ABERTOS`,
      ).toContain(arquivo);
    }
  });
});

describe("as raízes de campo", () => {
  it("cada raiz do catálogo é aceita pela fonte que a usa", () => {
    expect(RAIZES_DA_CAMPANHA).toEqual(["lead", "contato"]);
    for (const raiz of RAIZES_DE_CAMPO) {
      const entrada = variavelDoCatalogo(`{{${raiz}.campo}}`);
      expect(entrada, `{{${raiz}.campo}} não está no catálogo`).not.toBeNull();
      expect(entrada!.nome).toBe(`${raiz}${SUFIXO_DE_CURINGA}`);
    }
    // `{{lead}}` sem campo não é variável para ninguém.
    expect(renderizar("{{lead}}", VALORES, QUANDO).desconhecidas).toEqual(["lead"]);
    expect(variavelDoCatalogo("{{lead}}")).toBeNull();
  });

  it("`contact.*` é só da automação, `contato.*` só da campanha — e o catálogo diz", () => {
    expect(variavelDoCatalogo("{{contact.phone_number}}")!.disponivelEm).toEqual(["automacao"]);
    expect(variavelDoCatalogo("{{contato.gancho}}")!.disponivelEm).toEqual(["campanha"]);
  });
});

describe("a forma do catálogo", () => {
  it("toda entrada tem nome, descrição, exemplo e origem — nenhum campo vazio", () => {
    for (const v of VARIAVEIS_DO_CATALOGO) {
      expect(v.nome).not.toBe("");
      expect(v.descricao.trim()).not.toBe("");
      expect(v.exemplo.trim()).not.toBe("");
      expect(v.origem.fonte.trim()).not.toBe("");
      expect(v.origem.regra.trim()).not.toBe("");
      expect(v.disponivelEm.length).toBeGreaterThan(0);
    }
  });

  it("nome único, curinga só nas raízes conhecidas, chave fechada em [a-z_]", () => {
    const nomes = VARIAVEIS_DO_CATALOGO.map((v) => v.nome);
    expect(new Set(nomes).size).toBe(nomes.length);

    for (const v of VARIAVEIS_DO_CATALOGO) {
      if (eCuringa(v.nome)) {
        expect(RAIZES_DE_CAMPO as readonly string[]).toContain(
          v.nome.slice(0, -SUFIXO_DE_CURINGA.length),
        );
      } else {
        expect(v.nome).toMatch(/^[a-z][a-z_]*$/);
      }
    }
  });

  it("todo nome do catálogo tem exemplo de token (senão os testes acima conferem menos)", () => {
    expect(Object.keys(TOKEN_DE_EXEMPLO).sort()).toEqual([...nomesDoCatalogo()].sort());
  });

  it("o catálogo é dado puro: nenhum import, nenhum React, nenhum resolvedor", () => {
    const texto = readFileSync(CATALOGO, "utf8");
    expect(texto).not.toMatch(/^\s*import\s/m);
    expect(texto).not.toMatch(/from\s+"react/m);
    expect(texto).not.toMatch(/export\s+function\s+(resolver|renderizar|interpolar)\b/);
  });

  it("toda raiz de cada fonte está catalogada e toda fonte do catálogo é conhecida", () => {
    expect([...RESOLVEDORES].sort()).toEqual(["automacao", "campanha", "fluxo", "inbox"]);
    const fontesUsadas = new Set(VARIAVEIS_DO_CATALOGO.flatMap((v) => v.disponivelEm));
    expect([...fontesUsadas].sort()).toEqual([...RESOLVEDORES].sort());
  });

  it("normaliza token como o operador escreve e como o motor lê", () => {
    expect(normalizarToken("{{ NOME }}")).toBe("nome");
    expect(normalizarToken('{{nome|"aluno"}}')).toBe("nome");
    expect(normalizarToken("{{lead.custom_fields.gancho}}")).toBe("lead.*");
    expect(normalizarToken("{{contact.custom_fields.gancho}}")).toBe("contact.*");
    expect(variavelDoCatalogo("{{ Primeiro_Nome }}")?.nome).toBe("primeiro_nome");
  });
});

describe("as variáveis exclusivas de cada fonte", () => {
  it("o Inbox não tem nenhuma exclusiva: ele é o subconjunto mínimo", () => {
    expect(exclusivasDe("inbox")).toEqual([]);
  });

  it("campanha, automação e fluxo têm as suas, e são estas", () => {
    expect([...exclusivasDe("campanha")].sort()).toEqual(
      ["contato.*", "lead.*", "saudacao"].sort(),
    );
    expect([...exclusivasDe("automacao")].sort()).toEqual(
      ["contact.*", "email", "lead.*", "telefone"].sort(),
    );
    expect([...exclusivasDe("fluxo")].sort()).toEqual(["lead.*"].sort());
  });

  it("`saudacao` é a única chave fechada que a campanha tem e o Inbox não", () => {
    expect(exclusivasDe("campanha").filter((v) => !eCuringa(v))).toEqual(["saudacao"]);
  });
});
