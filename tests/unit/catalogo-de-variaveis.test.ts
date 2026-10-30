import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { renderizar, VARIAVEIS_DA_CAMPANHA } from "@/lib/campanhas/renderizador";
import { interpolateTemplate } from "@/lib/inbox/template-vars";
import {
  DIVERGENCIAS,
  eCuringa,
  exclusivasDe,
  normalizarToken,
  RAIZES_DE_CAMPO,
  RESOLVEDORES,
  RESOLVEDORES_NAO_COBERTOS,
  SUFIXO_DE_CURINGA,
  VARIAVEIS_DO_CATALOGO,
  variavelDoCatalogo,
  variaveisDe,
  type Resolvedor,
} from "@/lib/templates/catalogo-de-variaveis";

/**
 * O CATÁLOGO SÓ VALE SE DESCREVER O QUE EXISTE — e é isso que este arquivo prova.
 *
 * A tentação de um catálogo único é escrever o vocabulário que se GOSTARIA de
 * ter. Aí ele fica bonito e mentiroso: a tela oferece `{{saudacao}}` no Inbox,
 * onde o token sai literal na mensagem do cliente. Por isso cada linha do
 * catálogo é conferida contra os DOIS resolvedores de verdade — o Inbox
 * (`interpolateTemplate`, o mais pobre) e a campanha (`renderizar`, o mais rico),
 * escolhidos por cobrirem os extremos:
 *
 *   - o valor sai igual onde os dois conhecem a variável;
 *   - onde um não conhece, o token continua LITERAL lá, e o catálogo diz isso;
 *   - com o dado ausente, cada um faz o que já fazia (Inbox deixa literal,
 *     campanha marca `faltando`) — nada aqui "melhora" esse comportamento.
 *
 * A lista de vocabulário não é redigitada: sai do próprio resolvedor (o array
 * exportado da campanha, o literal `VARIAVEIS_DE_NOME` do Inbox). Assim, quando
 * alguém acrescentar uma variável lá e esquecer aqui, o teste reprova onde a
 * pessoa está editando.
 */

const RAIZ = join(__dirname, "..", "..");
const CATALOGO = join(RAIZ, "lib", "templates", "catalogo-de-variaveis.ts");
const INBOX = join(RAIZ, "lib", "inbox", "template-vars.ts");
const CAMPANHA = join(RAIZ, "lib", "campanhas", "renderizador.ts");

/**
 * O vocabulário de um resolvedor, lido do próprio fonte — a lista que precisa
 * espelhar o catálogo é a que está no código, não uma segunda cópia escrita
 * aqui. Se o array mudar de nome, isto reprova com a mensagem do `throw` em vez
 * de passar em silêncio com uma lista vazia.
 */
function listaDoFonte(fonte: string, nome: string): string[] {
  const bloco = new RegExp(`${nome}\\s*=\\s*\\[([^\\]]*)\\]`).exec(fonte);
  if (!bloco) throw new Error(`${nome} não encontrada no fonte`);
  return [...(bloco[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

/** O Inbox não exporta a lista (é detalhe interno), mas é ELA que o catálogo espelha. */
const VARIAVEIS_DO_INBOX = listaDoFonte(readFileSync(INBOX, "utf8"), "const VARIAVEIS_DE_NOME");

/** O da campanha: as chaves fechadas + as duas raízes de campo, que são caminho. */
const VARIAVEIS_DA_CAMPANHA_DO_FONTE = listaDoFonte(
  readFileSync(CAMPANHA, "utf8"),
  "VARIAVEIS_DA_CAMPANHA",
);

const VARIAVEIS_DA_CAMPANHA_NO_CATALOGO = [
  ...VARIAVEIS_DA_CAMPANHA_DO_FONTE,
  ...RAIZES_DE_CAMPO.map((raiz) => `${raiz}${SUFIXO_DE_CURINGA}`),
];

const CONTATO = { name: "Ana Souza" };
const VALORES = {
  nome: "Ana Souza",
  lead: { gancho: "vi que vocês vendem bolo de casamento" },
  contato: { link_previa: "https://loja.exemplo/previa/ana" },
};
/** 15:00Z = meio-dia em São Paulo — o primeiro segundo de "Boa tarde". */
const QUANDO = { agora: new Date("2026-10-29T15:00:00Z"), fuso: "America/Sao_Paulo" };

/**
 * Caso a caso: o token como o operador escreve, e o que cada resolvedor devolve
 * com o dado PRESENTE. O literal esperado é o próprio token, escrito por extenso
 * — quem lê o teste vê a divergência sem rodar nada.
 */
const CASOS: { token: string; inbox: string; campanha: string }[] = [
  { token: "{{nome}}", inbox: "Ana Souza", campanha: "Ana Souza" },
  { token: "{{primeiro_nome}}", inbox: "Ana", campanha: "Ana" },
  { token: "{{saudacao}}", inbox: "{{saudacao}}", campanha: "Boa tarde" },
  { token: "{{lead.gancho}}", inbox: "{{lead.gancho}}", campanha: VALORES.lead.gancho },
  {
    token: "{{contato.link_previa}}",
    inbox: "{{contato.link_previa}}",
    campanha: "https://loja.exemplo/previa/ana",
  },
];

describe("o catálogo descreve o que cada resolvedor faz, variável por variável", () => {
  for (const caso of CASOS) {
    it(`${caso.token}: Inbox devolve "${caso.inbox}", campanha devolve "${caso.campanha}"`, () => {
      const inbox = interpolateTemplate(caso.token, CONTATO);
      const campanha = renderizar(caso.token, VALORES, QUANDO);

      expect(inbox).toBe(caso.inbox);
      expect(campanha.texto).toBe(caso.campanha);
      expect(campanha.faltando).toEqual([]);
      expect(campanha.desconhecidas).toEqual([]);

      // A linha do catálogo é o que os dois ACABARAM de fazer — não o contrário.
      // Com dado presente, "resolveu" é a mesma coisa que "tem regra": só a
      // saudação sem instante separa as duas (e tem teste próprio abaixo).
      const resolveram = RESOLVEDORES.filter((r) =>
        r === "inbox" ? inbox !== caso.token : campanha.texto !== caso.token,
      );
      const catalogo = variavelDoCatalogo(caso.token);
      expect(catalogo, `${caso.token} não está no catálogo`).not.toBeNull();
      expect([...catalogo!.disponivelEm].sort()).toEqual([...resolveram].sort());
    });
  }
});

describe("o vocabulário do catálogo é exatamente o dos dois resolvedores", () => {
  it("Inbox: nome e primeiro_nome, nada mais", () => {
    expect([...variaveisDe("inbox")].sort()).toEqual([...VARIAVEIS_DO_INBOX].sort());
    expect([...variaveisDe("inbox")].sort()).toEqual(["nome", "primeiro_nome"]);
  });

  it("campanha: as três chaves exportadas mais as duas raízes de campo", () => {
    // O que o módulo exporta e o que está escrito no fonte são a mesma lista —
    // se divergirem, quem lê o código e quem importa estão vendo coisas diferentes.
    expect([...VARIAVEIS_DA_CAMPANHA]).toEqual(VARIAVEIS_DA_CAMPANHA_DO_FONTE);
    expect([...variaveisDe("campanha")].sort()).toEqual(
      [...VARIAVEIS_DA_CAMPANHA_NO_CATALOGO].sort(),
    );
  });

  it("as raízes do catálogo são as mesmas que o renderizador da campanha aceita", () => {
    expect(RAIZES_DE_CAMPO).toEqual(["lead", "contato"]);
    // `{{lead}}` sem campo não é variável para ninguém: o renderizador exige o
    // ponto, e o catálogo também — não inventa uma chave que ninguém resolve.
    expect(renderizar("{{lead}}", VALORES, QUANDO).desconhecidas).toEqual(["lead"]);
    expect(variavelDoCatalogo("{{lead}}")).toBeNull();
  });
});

describe("a divergência entre os dois não fica escondida", () => {
  it("as exclusivas do catálogo são as mesmas da tabela DIVERGENCIAS", () => {
    const derivadas = RESOLVEDORES.flatMap((r: Resolvedor) =>
      exclusivasDe(r).map((v) => `${v}@${r}`),
    ).sort();
    const escritas = DIVERGENCIAS.map((d) => `${d.variavel}@${d.existeEm}`).sort();
    expect(escritas).toEqual(derivadas);
  });

  it("cada divergência existe em um lado e o outro deixa o token literal", () => {
    const exemplo: Record<string, string> = {
      saudacao: "{{saudacao}}",
      "lead.*": "{{lead.gancho}}",
      "contato.*": "{{contato.link_previa}}",
    };

    for (const d of DIVERGENCIAS) {
      const entrada = variavelDoCatalogo(exemplo[d.variavel]!);
      expect(entrada, `${d.variavel} sem linha no catálogo`).not.toBeNull();
      expect(entrada!.disponivelEm).toContain(d.existeEm);
      expect(entrada!.disponivelEm).not.toContain(d.faltaEm);
      expect(d.efeito).not.toBe("");

      // O lado pobre não conhece a chave: o literal sobrevive, como o `efeito` diz.
      expect(interpolateTemplate(exemplo[d.variavel]!, CONTATO)).toBe(exemplo[d.variavel]);
    }
  });

  it("saudação existe só na campanha — e é a única diferença de chave fechada", () => {
    expect(exclusivasDe("campanha").filter((v) => !eCuringa(v))).toEqual(["saudacao"]);
    expect(exclusivasDe("inbox")).toEqual([]);
  });
});

describe("dado ausente: o catálogo não promete texto que o resolvedor não dá", () => {
  it("Inbox sem nome: nome e primeiro_nome continuam literais", () => {
    expect(interpolateTemplate("Oi {{nome}}!", { name: null })).toBe("Oi {{nome}}!");
    expect(interpolateTemplate("Oi {{primeiro_nome}}!", { name: null })).toBe(
      "Oi {{primeiro_nome}}!",
    );
    expect(interpolateTemplate("Oi {{nome}}!", {})).toBe("Oi {{nome}}!");
    expect(interpolateTemplate("Oi {{primeiro_nome}}!", { name: "   " })).toBe(
      "Oi {{primeiro_nome}}!",
    );
  });

  it("Inbox com nome vazio cai no display_name — é o que a origem do catálogo diz", () => {
    expect(interpolateTemplate("Oi {{nome}}!", { name: null, displayName: "Ana Paula" })).toBe(
      "Oi Ana Paula!",
    );
    expect(
      interpolateTemplate("Oi {{primeiro_nome}}!", { name: "", displayName: "Ana Paula" }),
    ).toBe("Oi Ana!");
  });

  it("campanha sem nome: literal + falta, nunca 'Olá , tudo bem?'", () => {
    const nome = renderizar("Oi {{nome}}!", { nome: null }, QUANDO);
    expect(nome.texto).toBe("Oi {{nome}}!");
    expect(nome.faltando).toEqual(["nome"]);

    const primeiro = renderizar("Oi {{primeiro_nome}}!", { nome: "   " }, QUANDO);
    expect(primeiro.texto).toBe("Oi {{primeiro_nome}}!");
    expect(primeiro.faltando).toEqual(["primeiro_nome"]);
  });

  it("campanha sem mapa de negócio: lead.* falta, e não vira string vazia", () => {
    const semLead = renderizar("{{lead.gancho}}", { nome: "Ana", lead: null }, QUANDO);
    expect(semLead.texto).toBe("{{lead.gancho}}");
    expect(semLead.faltando).toEqual(["lead.gancho"]);

    const semMapa = renderizar("{{contato.link_previa}}", { nome: "Ana" }, QUANDO);
    expect(semMapa.texto).toBe("{{contato.link_previa}}");
    expect(semMapa.faltando).toEqual(["contato.link_previa"]);
  });

  it("campanha com campo vazio, objeto ou raiz de protótipo: falta, não texto pela metade", () => {
    const vazio = renderizar("{{lead.gancho}}", { nome: "Ana", lead: { gancho: "   " } }, QUANDO);
    expect(vazio.faltando).toEqual(["lead.gancho"]);

    const objeto = renderizar(
      "{{lead.gancho}}",
      { nome: "Ana", lead: { gancho: { a: 1 } } },
      QUANDO,
    );
    expect(objeto.faltando).toEqual(["lead.gancho"]);

    const proto = JSON.parse('{"__proto__":"x"}') as Record<string, unknown>;
    const atravessado = renderizar("{{lead.__proto__}}", { nome: "Ana", lead: proto }, QUANDO);
    expect(atravessado.texto).toBe("{{lead.__proto__}}");
    expect(atravessado.faltando).toEqual(["lead.__proto__"]);
  });

  it("campanha com lista: vírgula, que é como a pessoa leria", () => {
    const lista = renderizar(
      "{{lead.servico}}",
      { nome: "Ana", lead: { servico: ["bolo", "doces"] } },
      QUANDO,
    );
    expect(lista.texto).toBe("bolo, doces");
    expect(lista.faltando).toEqual([]);
  });

  it("a reserva é sintaxe do motor, não uma variável do catálogo", () => {
    expect(variavelDoCatalogo('{{nome|"aluno"}}')?.nome).toBe("nome");
    expect(interpolateTemplate('Oi {{nome|"aluno"}}!', { name: null })).toBe("Oi aluno!");
    expect(renderizar('Oi {{primeiro_nome|"aluno"}}!', { nome: null }, QUANDO).texto).toBe(
      "Oi aluno!",
    );
  });
});

describe("os dois lados que o catálogo não pode confundir", () => {
  it("saudação sem instante não é falta: a prévia mostra o token, o envio resolve", () => {
    const previa = renderizar("{{saudacao}}, {{nome}}!", VALORES);
    expect(previa.texto).toBe("{{saudacao}}, Ana Souza!");
    expect(previa.faltando).toEqual([]);
    expect(previa.desconhecidas).toEqual([]);
  });

  it("chave fora do catálogo continua literal nos dois — e não ganha linha", () => {
    expect(variavelDoCatalogo("{{codigo}}")).toBeNull();
    expect(interpolateTemplate("Cupom {{codigo}}", CONTATO)).toBe("Cupom {{codigo}}");

    const campanha = renderizar("Cupom {{codigo}}", VALORES, QUANDO);
    expect(campanha.texto).toBe("Cupom {{codigo}}");
    expect(campanha.desconhecidas).toEqual(["codigo"]);
  });

  it("o dialeto da Meta ({{1}}, {{2}}) é outro e fica fora do catálogo", () => {
    // Não é descuido: `{{1}}` é posição de variável de modelo aprovado, resolvida
    // em `lib/channels/meta/variaveis-do-fluxo.ts`. Catalogá-la aqui prometeria
    // nome onde existe índice.
    expect(variavelDoCatalogo("{{1}}")).toBeNull();
    expect(variavelDoCatalogo("{{2}}")).toBeNull();
    expect(nomesDoCatalogoSemCuringa().some((n) => /^\d+$/.test(n))).toBe(false);
  });

  it("token com chaves, espaço e maiúscula é o mesmo nome — o catálogo não é mais exigente que o motor", () => {
    expect(normalizarToken("{{ NOME }}")).toBe("nome");
    expect(variavelDoCatalogo("{{ Primeiro_Nome }}")?.nome).toBe("primeiro_nome");
    expect(normalizarToken("{{lead.custom_fields.gancho}}")).toBe("lead.*");
    expect(interpolateTemplate("Oi {{ NOME }}", CONTATO)).toBe("Oi Ana Souza");
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
        // O `TOKEN` do Inbox aceita só `[a-zA-Z_]`: nome com dígito ou ponto
        // viraria linha de catálogo que a tela oferece e o Inbox ignora.
        expect(v.nome).toMatch(/^[a-z][a-z_]*$/);
      }
    }
  });

  it("o catálogo é dado puro: nenhum import, nenhum React, nenhum resolvedor", () => {
    const fonte = readFileSync(CATALOGO, "utf8");
    expect(fonte).not.toMatch(/^\s*import\s/m);
    expect(fonte).not.toMatch(/from\s+"react/m);
    expect(fonte).not.toMatch(/export\s+function\s+(resolver|renderizar|interpolar)\b/);
  });

  it("declara o que NÃO cobre — os quatro resolvedores restantes, com arquivo que existe", () => {
    expect(RESOLVEDORES_NAO_COBERTOS).toHaveLength(4);
    const arquivos = RESOLVEDORES_NAO_COBERTOS.map((r) => r.arquivo);
    expect(new Set(arquivos).size).toBe(arquivos.length);
    expect(arquivos).toContain("lib/automation/template.ts");
    expect(arquivos).toContain("lib/channels/meta/variaveis-do-fluxo.ts");
    expect(arquivos).toContain("lib/propostas/documento/variaveis.ts");

    for (const r of RESOLVEDORES_NAO_COBERTOS) {
      expect(r.dialeto.trim()).not.toBe("");
      expect(r.motivo.trim()).not.toBe("");
      // Declarar arquivo que não existe é a mesma mentira, um nível abaixo.
      expect(() => readFileSync(join(RAIZ, r.arquivo), "utf8")).not.toThrow();
    }
  });
});

/** Os nomes do catálogo sem o sufixo de curinga — para checar o formato das chaves. */
function nomesDoCatalogoSemCuringa(): string[] {
  return VARIAVEIS_DO_CATALOGO.map((v) => v.nome).filter((nome) => !eCuringa(nome));
}
