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
 * cada fonte de verdade do produto é lida e conferida contra o catálogo:
 *
 *   - Inbox            · `lib/inbox/template-vars.ts`
 *   - Campanha         · `lib/campanhas/renderizador.ts`
 *   - Automação        · `lib/automation/template.ts`
 *   - Fluxo (Meta)     · `lib/channels/meta/variaveis-do-fluxo.ts`
 *   - Seletor da tela  · `components/variaveis/SeletorDeVariavel.tsx`
 *
 * ATÉ #3687 a conferência era de LISTA: cada tela tinha a sua (`VARIAVEIS_DE_NOME`
 * no Inbox, `VARIAVEIS_DA_CAMPANHA` na campanha, `TEMPLATE_VARS` no seletor) e
 * este arquivo comparava lista com lista. As listas não existem mais: as quatro
 * telas passaram a chamar o MESMO resolvedor (`lib/variaveis/resolvedor.ts`) com
 * a MESMA fonte do catálogo. Então a conferência passou a ser de COMPORTAMENTO —
 * para cada entrada do catálogo, a tela resolve (ou não) exatamente o que o
 * catálogo promete. É mais forte que a comparação de listas: pega o item que
 * está catalogado e morreu no motor.
 *
 * Proposta e os campos criados pela organização não têm lista fechada: ficam
 * declarados em `VOCABULARIOS_ABERTOS`, e o teste prova a declaração em vez de
 * fingir paridade.
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

/** Os aliases de `renderTemplate` — o vocabulário que a automação conhece por nome. */
const ALIASES_DA_AUTOMACAO = chavesDoObjeto(fonte(AUTOMACAO), "const ALIASES");

/** As origens que o schema do modelo aprovado aceita (`fonteDeVariavelSchema`). */
const ORIGENS_DO_FLUXO = [
  ...fonte(FLUXO).matchAll(/kind:\s*z\.literal\("([a-z_]+)"\)/g),
].map((m) => m[1] as string);

/**
 * As telas que oferecem variável (#3687). Todas importam o MESMO seletor e dizem
 * qual é a fonte — nenhuma mantém lista própria de vocabulário.
 */
const TELAS_COM_SELETOR: { arquivo: string; fonte: string }[] = [
  { arquivo: SELETOR, fonte: "automacao" },
  { arquivo: "app/app/ai/followups/[id]/_components/forms/ActionForm.tsx", fonte: "automacao" },
  { arquivo: "app/app/campaigns/new/_client.tsx", fonte: "campanha" },
  { arquivo: "app/app/campaigns/[id]/edit/_client.tsx", fonte: "campanha" },
  { arquivo: "app/app/templates/_components/TemplateFormDialog.tsx", fonte: "inbox" },
];

const CONTATO = { name: "Ana Souza" };
const VALORES = {
  nome: "Ana Souza",
  lead: { gancho: "do bolo", title: "Maria" },
  contato: { gancho: "ctt" },
};
/** 15:00Z = meio-dia em São Paulo — o primeiro segundo de "Boa tarde". */
const QUANDO = { agora: new Date("2026-10-29T15:00:00Z"), fuso: "America/Sao_Paulo" };
/** O instante do Inbox é o do compositor: a hora do clique, no fuso de quem atende. */
const AGORA_INBOX = { instante: QUANDO.agora, fuso: QUANDO.fuso };
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
    { token: "{{saudacao}}", inbox: "Boa tarde", campanha: "Boa tarde" },
    { token: "{{lead.gancho}}", inbox: "{{lead.gancho}}", campanha: "do bolo" },
    {
      token: "{{contato.gancho}}",
      inbox: "{{contato.gancho}}",
      campanha: "ctt",
    },
  ];

  for (const caso of casos) {
    it(`${caso.token}: Inbox devolve "${caso.inbox}", campanha devolve "${caso.campanha}"`, () => {
      const inbox = interpolateTemplate(caso.token, CONTATO, AGORA_INBOX);
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
    // Sem instante do envio não há saudação a dar: o token fica como foi escrito
    // (era a lacuna mais cara do produto — sumia como vazio, sem aviso).
    { token: "{{saudacao}}", esperado: "{{saudacao}}" },
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
  it(`Inbox (${INBOX}): resolve o catálogo inteiro de lá e nada além`, () => {
    // Sem lista própria no fonte, a conferência é de COMPORTAMENTO: o que o
    // catálogo dá ao Inbox resolve; o que ele NÃO dá continua literal, que é o
    // que a resposta rápida faz com token de outra tela.
    for (const nome of variaveisDe("inbox")) {
      const token = TOKEN_DE_EXEMPLO[nome]!;
      expect(
        interpolateTemplate(token, CONTATO, AGORA_INBOX),
        `${nome} está catalogada no Inbox (${INBOX}) e não resolve lá`,
      ).not.toBe(token);
    }
    for (const v of VARIAVEIS_DO_CATALOGO.filter((v) => !v.disponivelEm.includes("inbox"))) {
      const token = TOKEN_DE_EXEMPLO[v.nome]!;
      expect(
        interpolateTemplate(token, CONTATO, AGORA_INBOX),
        `${v.nome} NÃO está catalogada no Inbox e mesmo assim resolve em ${INBOX}`,
      ).toBe(token);
    }
  });

  it(`campanha (${CAMPANHA}): resolve o catálogo inteiro de lá e nada além`, () => {
    // As raízes de campo são as únicas com caminho aberto — e o catálogo as
    // declara como curinga, não como chave fechada.
    for (const raiz of RAIZES_DA_CAMPANHA) {
      expect(RAIZES_DE_CAMPO as readonly string[]).toContain(raiz);
    }
    for (const nome of variaveisDe("campanha")) {
      const token = TOKEN_DE_EXEMPLO[nome]!;
      const r = renderizar(token, VALORES, QUANDO);
      expect(r.desconhecidas, `${nome} está catalogada na campanha e saiu desconhecida`).toEqual([]);
      expect(r.texto, `${nome} está catalogada na campanha (${CAMPANHA}) e não resolve`).not.toBe(
        token,
      );
    }
    const doCatalogo = new Set(variaveisDe("campanha"));
    for (const v of VARIAVEIS_DO_CATALOGO.filter((v) => !v.disponivelEm.includes("campanha"))) {
      expect(doCatalogo.has(v.nome), `${v.nome} sai da campanha e o catálogo diz que sim`).toBe(
        false,
      );
      expect(renderizar(TOKEN_DE_EXEMPLO[v.nome]!, VALORES, QUANDO).desconhecidas.length).toBe(1);
    }
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
      // #3687 — a origem aditiva: qualquer nome do catálogo, resolvido pelo
      // resolvedor único. O exemplo é a chave fechada que ela acrescenta.
      variavel: "{{nome}}",
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
      // #3687 — a origem nova fala o vocabulário do catálogo, pelo resolvedor.
      { fonte: { kind: "variavel", chave: "nome" }, valor: "Ana Souza" },
      { fonte: { kind: "variavel", chave: "primeiro_nome" }, valor: "Ana" },
      { fonte: { kind: "variavel", chave: "lead.gancho" }, valor: "do bolo" },
      // `{{saudacao}}` não vale no fluxo (o fluxo não tem instante de envio
      // quando monta a tela): sem valor, o passo é recusado com motivo.
      { fonte: { kind: "variavel", chave: "saudacao" }, valor: null },
    ];
    for (const caso of esperado) expect(valorDaFonte(caso.fonte, dados)).toBe(caso.valor);
  });

  it("as telas usam o MESMO seletor, com a fonte certa — e nenhuma lista própria", () => {
    // Antes de #3687 cada tela tinha a sua lista (três botões fixos na
    // automação, `VARIAVEIS_DE_NOME` no Inbox, `VARIAVEIS_DA_CAMPANHA` na
    // campanha). O que este teste impede é a lista VOLTAR: se alguém escrever
    // um array de variáveis dentro de uma tela, ele reprova aqui.
    for (const { arquivo, fonte: fonteDaTela } of TELAS_COM_SELETOR) {
      const texto = fonte(arquivo);
      expect(texto, `${arquivo} não importa o seletor único`).toMatch(
        /from "@\/components\/variaveis\/(SeletorDeVariavel|CampoComVariaveis)"/,
      );
      if (!texto.includes("CampoComVariaveis")) {
        expect(texto, `${arquivo} usa o seletor sem dizer a fonte`).toContain(
          `fonte="${fonteDaTela}"`,
        );
      }
      // Nenhuma lista de tokens escrita à mão na tela.
      expect(
        texto,
        `${arquivo} voltou a manter uma lista própria de variáveis (TEMPLATE_VARS/VARIAVEIS_DE_* com ["..."])`,
      ).not.toMatch(/const (TEMPLATE_VARS|VARIAVEIS_DE_[A-Z_]+)\s*=\s*\[/);
    }
  });

  it("todo item que o seletor oferece vem do catálogo e resolve de verdade", () => {
    // O seletor é TELA, não resolvedor: ele não pode oferecer mais que o motor.
    for (const tela of TELAS_COM_SELETOR) {
      for (const nome of variaveisDe(tela.fonte as Parameters<typeof variaveisDe>[0])) {
        const token = TOKEN_DE_EXEMPLO[nome]!;
        const resolvido =
          tela.fonte === "campanha"
            ? renderizar(token, VALORES, QUANDO).texto
            : tela.fonte === "inbox"
              ? interpolateTemplate(token, CONTATO, AGORA_INBOX)
              : renderTemplate(token, CONTEXTO, undefined, AGORA_INBOX);
        expect(
          resolvido,
          `o seletor de ${tela.arquivo} oferece ${nome} e o motor da tela não resolve`,
        ).not.toBe(token);
      }
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
      ["contact.*", "contato.*", "email", "lead.*", "telefone"].sort(),
    );
    for (const lacuna of doInbox) {
      const token = TOKEN_DE_EXEMPLO[lacuna.variavel]!;
      expect(interpolateTemplate(token, CONTATO, AGORA_INBOX)).toBe(token);
    }
  });

  it("na automação, caminho de contato sai VAZIO e saudação resolve no envio", () => {
    // `{{contato.gancho}}` (a sintaxe da campanha) não existe no contexto da
    // automação: sai vazio, sem `desconhecidas` e sem aviso ao operador.
    expect(renderTemplate("{{contato.gancho}}", CONTEXTO)).toBe("");
    // #3687 — a saudação deixou de ser lacuna: sem instante o token fica como
    // foi escrito (nunca vazio); com instante, sai a saudação da hora.
    expect(
      LACUNAS_CONHECIDAS.some((l) => l.variavel === "saudacao" && l.fonte === "automacao"),
    ).toBe(false);
    expect(renderTemplate("Bom dia, {{primeiro_nome}}! {{saudacao}}", CONTEXTO)).toBe(
      "Bom dia, Ana! {{saudacao}}",
    );
    expect(
      renderTemplate("Bom dia, {{primeiro_nome}}! {{saudacao}}", CONTEXTO, undefined, AGORA_INBOX),
    ).toBe("Bom dia, Ana! Boa tarde");
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
  it("o Inbox só tem a saudação fora das quatro — e é a única", () => {
    // `exclusivasDe` = existe nesta fonte e não em todas: é o mapa do que a
    // pessoa perde ao copiar o texto para outra tela.
    expect(exclusivasDe("inbox")).toEqual(["saudacao"]);
  });

  it("campanha, automação e fluxo têm as suas, e são estas", () => {
    expect([...exclusivasDe("campanha")].sort()).toEqual(
      ["contato.*", "lead.*", "saudacao"].sort(),
    );
    expect([...exclusivasDe("automacao")].sort()).toEqual(
      ["contact.*", "email", "lead.*", "saudacao", "telefone"].sort(),
    );
    expect([...exclusivasDe("fluxo")].sort()).toEqual(["lead.*"].sort());
  });

  it("`saudacao` é a única chave fechada da campanha além do universal — e agora é das três", () => {
    expect(exclusivasDe("campanha").filter((v) => !eCuringa(v))).toEqual(["saudacao"]);
    // #3687: deixou de ser só da campanha. Resolve no Inbox (compositor, fuso de
    // quem atende), na automação (instante do disparo) e na campanha (relógio).
    expect([...variavelDoCatalogo("{{saudacao}}")!.disponivelEm].sort()).toEqual([
      "automacao",
      "campanha",
      "inbox",
    ]);
  });
});
