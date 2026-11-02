/**
 * OS ATALHOS DO CARD (issue #3487) — a régua que a GRAVAÇÃO e a RENDERIZAÇÃO
 * compartilham.
 *
 * ─── O que este arquivo prova, e por que cada prova importa ─────────────────
 *
 * O `url` do atalho é digitado por uma pessoa e renderizado para outras: vira
 * `<a href>` na tela de quem atende. Duas consequências, e as duas estão aqui:
 *
 *   1. **SEGURANÇA.** `javascript:`, `data:`, `file:` e `vbscript:` são
 *      recusados NA GRAVAÇÃO (o schema do funil nem aceita o patch) e NA
 *      RENDERIZAÇÃO (`atalhosParaExibir`), porque o `settings` é jsonb e pode
 *      ser escrito por script, seed ou restauração de backup. Um link que só é
 *      seguro porque passou pelo formulário é meio link.
 *   2. **O LINK TEM DE FUNCIONAR.** `tel:` com espaço ou parêntese não disca em
 *      parte dos softphones, e um marcador sem valor que virasse string vazia
 *      abriria o app de pedidos do cliente errado. Por isso o telefone é
 *      reduzido a `+` e dígitos, cada valor interpolado passa por
 *      `encodeURIComponent`, e marcador sem dado faz o botão NÃO aparecer.
 *
 * Os três exemplos do fim (`Ligar`, `Tirar pedido`, `Segunda via`) são o que a
 * issue pede como prova: o mesmo cenário que o vendedor descreveu, com o href
 * conferido caractere a caractere.
 */
import { describe, expect, it } from "vitest";

import { pipelineConfigPatchSchema } from "@/lib/schemas/settings";

import {
  atalhosDoFunil,
  atalhosParaExibir,
  esquemaDoModelo,
  marcadoresDoModelo,
  motivoDaRecusaDoModelo,
  modeloAceito,
  montarHref,
  normalizarTelefoneParaTel,
  valorDoMarcador,
  type AtalhoDoCard,
  type DadosDoAtalho,
} from "./atalhos-do-card";

/** O contato e o negócio do exemplo que a issue usa (`11999999999`). */
const DADOS: DadosDoAtalho = {
  telefone: "+55 (11) 99999-9999",
  nome: "Maria Silva",
  email: "maria@exemplo.com",
  lead: { id: "lead-1", campos: { erp_id: "ERP-4471", valor_frete: 0 } },
  contato: { id: "contato-1", campos: { cpf: "123.456.789-09" } },
};

function atalho(parcial: Partial<AtalhoDoCard>): AtalhoDoCard {
  return { rotulo: "Abrir", icone: "link", url: "https://exemplo.com/", ...parcial };
}

describe("allowlist de esquema — a recusa na GRAVAÇÃO", () => {
  const PROIBIDOS = [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "  javascript:alert(1)  ",
    "java\nscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "vbscript:msgbox(1)",
    "//exemplo.com/pedido",
  ];

  it.each(PROIBIDOS)("o patch do funil recusa %j", (url) => {
    const r = pipelineConfigPatchSchema.safeParse({
      atalhos: [{ rotulo: "Ligar", icone: "telefone", url }],
    });
    expect(r.success).toBe(false);
  });

  it("o patch aceita os três esquemas da entrega — e só eles", () => {
    const aceitos = ["tel:{{telefone}}", "http://pedidos.exemplo.com/", "https://exemplo.com/?c={{erp_id}}"];
    for (const url of aceitos) {
      const r = pipelineConfigPatchSchema.safeParse({
        atalhos: [{ rotulo: "Abrir", icone: "link", url }],
      });
      expect(r.success, `${url} deveria passar`).toBe(true);
    }
    for (const url of PROIBIDOS) {
      expect(modeloAceito(url), `${url} não deveria passar`).toBe(false);
    }
  });

  it("o esquema é lido em minúsculas — `TEL:` e `HTTPS:` valem", () => {
    expect(esquemaDoModelo("TEL:+5511999999999")).toBe("tel:");
    expect(esquemaDoModelo("HTTPS://x.exemplo.com")).toBe("https:");
    expect(modeloAceito("TEL:+5511999999999")).toBe(true);
  });

  it("recusa `http:`/`https:` sem `//` e modelo sem destino", () => {
    expect(modeloAceito("https:javascript:alert(1)")).toBe(false);
    expect(modeloAceito("tel:")).toBe(false);
    expect(motivoDaRecusaDoModelo("https:exemplo.com")).toBe("sem_barras");
    expect(motivoDaRecusaDoModelo("tel:")).toBe("sem_destino");
  });

  it("o domínio fica fixo no modelo: marcador só entra depois da primeira `/`", () => {
    // O valor do campo é escrito por quem atende e pela captação; ele preenche
    // o caminho e a busca, nunca o destino. `encodeURIComponent` não codifica
    // `.`, e por isso a régua mora no MODELO, antes da interpolação.
    const dados: DadosDoAtalho = {
      lead: { campos: { site: "outro-dominio.example", x: ".outro-dominio.example" } },
    };
    for (const url of [
      "https://{{lead.site}}/pedido",
      "https://erp.exemplo.com{{lead.x}}/p",
      "http://erp.exemplo.com:{{lead.x}}/p",
      "https://{{lead.x}}@erp.exemplo.com/p",
    ]) {
      expect(modeloAceito(url), url).toBe(false);
      expect(motivoDaRecusaDoModelo(url), url).toBe("marcador_no_dominio");
      expect(montarHref(url, dados), url).toBeNull();
      expect(atalhosParaExibir([atalho({ url })], dados), url).toEqual([]);
      expect(pipelineConfigPatchSchema.safeParse({ atalhos: [atalho({ url })] }).success, url).toBe(false);
    }
    // Depois da primeira `/`, `?` ou `#`, o marcador segue valendo.
    expect(modeloAceito("https://erp.exemplo.com/{{lead.x}}")).toBe(true);
    expect(modeloAceito("https://x.com/?c={{lead.x}}")).toBe(true);
    expect(montarHref("https://x.com/?c={{lead.x}}", dados)).toBe(
      "https://x.com/?c=.outro-dominio.example",
    );
    expect(modeloAceito("https://erp.exemplo.com?c={{lead.x}}")).toBe(true);
    expect(modeloAceito("https://erp.exemplo.com#{{lead.x}}")).toBe(true);
  });

  it("o domínio é o que o navegador lê: barras e contrabarras a mais antes do host não abrem o domínio ao campo", () => {
    // Para http(s), o navegador pula TODAS as `/` e `\` depois do esquema antes
    // de ler o host. A régua recorta a autoridade do mesmo jeito.
    const dados: DadosDoAtalho = { lead: { campos: { x: "outro-dominio.example" } } };
    for (const url of [
      "https:///{{lead.x}}",
      "https:////{{lead.x}}",
      "https:/\\{{lead.x}}",
      "https:\\\\{{lead.x}}",
      "https://\\{{lead.x}}/p",
      "http:///{{lead.x}}?c=1",
    ]) {
      // `montarHref` primeiro: ele tem a própria conferência de host, e esta
      // ordem mostra qual das duas portas falhou quando uma delas cede.
      expect(montarHref(url, dados), url).toBeNull();
      expect(atalhosParaExibir([atalho({ url })], dados), url).toEqual([]);
      expect(modeloAceito(url), url).toBe(false);
      expect(pipelineConfigPatchSchema.safeParse({ atalhos: [atalho({ url })] }).success, url).toBe(false);
    }
    expect(motivoDaRecusaDoModelo("https:///{{lead.x}}")).toBe("marcador_no_dominio");
    expect(motivoDaRecusaDoModelo("https://\\{{lead.x}}/p")).toBe("marcador_no_dominio");
    // Controle: com o host escrito no modelo, a barra a mais não muda nada.
    expect(montarHref("https:///x.com/?c={{lead.x}}", dados)).not.toBeNull();
  });

  it("recusa acima do teto e caractere de controle em qualquer posição", () => {
    expect(modeloAceito(`https://exemplo.com/${"a".repeat(2100)}`)).toBe(false);
    expect(motivoDaRecusaDoModelo(`https://exemplo.com/${"a".repeat(2100)}`)).toBe("longo");
    expect(motivoDaRecusaDoModelo(`https://exemplo.com/\u0000`)).toBe("invisivel");
  });

  it("o schema limita a seis atalhos e exige rótulo e ícone do catálogo", () => {
    const sete = Array.from({ length: 7 }, (_, i) =>
      atalho({ rotulo: `A${i}`, url: `https://exemplo.com/${i}` }),
    );
    expect(pipelineConfigPatchSchema.safeParse({ atalhos: sete }).success).toBe(false);
    expect(
      pipelineConfigPatchSchema.safeParse({
        atalhos: [{ rotulo: "", icone: "link", url: "https://exemplo.com/" }],
      }).success,
    ).toBe(false);
    expect(
      pipelineConfigPatchSchema.safeParse({
        atalhos: [{ rotulo: "Abrir", icone: "foguete", url: "https://exemplo.com/" }],
      }).success,
    ).toBe(false);
  });
});

describe("allowlist de esquema — a recusa na RENDERIZAÇÃO", () => {
  it("atalho `javascript:` gravado POR FORA do formulário não vira link", () => {
    // É o cenário que dá sentido à segunda porta: o jsonb foi escrito por
    // script/seed/restauração e nunca passou pelo schema.
    const doBanco = [{ rotulo: "Ligar", icone: "telefone", url: "javascript:alert(document.cookie)" }];
    expect(atalhosParaExibir(doBanco, DADOS)).toEqual([]);
  });

  it.each([
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "vbscript:msgbox(1)",
    "javascript:alert(1)",
  ])("`%s` não produz href", (url) => {
    expect(montarHref(url, DADOS)).toBeNull();
  });

  it("o valor de um campo não troca o destino do link", () => {
    // `encodeURIComponent` no valor: o `&` não vira segundo parâmetro e o `#`
    // não vira fragmento — os dois ficam dentro do valor de `cliente`.
    const href = montarHref("https://pedidos.exemplo.com/?cliente={{erp_id}}", {
      ...DADOS,
      lead: { id: "l", campos: { erp_id: "A&B#C" } },
    });
    expect(href).toBe("https://pedidos.exemplo.com/?cliente=A%26B%23C");
  });

  it("um valor que PARECE esquema continua dentro do valor, codificado", () => {
    const href = montarHref("https://exemplo.com/?nome={{nome}}", {
      ...DADOS,
      nome: "javascript:alert(1)",
    });
    expect(href).toBe("https://exemplo.com/?nome=javascript%3Aalert(1)");
    expect(href?.startsWith("https://")).toBe(true);
  });
});

describe("telefone: o link só sai com `+` e dígitos", () => {
  it("normaliza o que a pessoa digita e o que o banco guarda", () => {
    expect(normalizarTelefoneParaTel("+55 (11) 99999-9999")).toBe("+5511999999999");
    expect(normalizarTelefoneParaTel("11 99999-9999")).toBe("11999999999");
    expect(normalizarTelefoneParaTel("+5511999999999")).toBe("+5511999999999");
  });

  it("recusa o que não é telefone — e é isso que faz o botão sumir", () => {
    expect(normalizarTelefoneParaTel("")).toBeNull();
    expect(normalizarTelefoneParaTel(null)).toBeNull();
    expect(normalizarTelefoneParaTel("119")).toBeNull(); // curto demais para discar
    expect(normalizarTelefoneParaTel("ramal 4021")).toBeNull();
  });

  it("`tel:` sai com o número discável, sem espaço nem parêntese", () => {
    expect(montarHref("tel:{{telefone}}", DADOS)).toBe("tel:+5511999999999");
    // Sem código do país: o softphone brasileiro disca DDD + número.
    expect(montarHref("tel:{{telefone}}", { telefone: "(11) 99999-9999" })).toBe(
      "tel:11999999999",
    );
  });

  it("`tel:` com ramal literal mantém os dígitos do modelo, na ordem", () => {
    expect(montarHref("tel:{{telefone}},ramal 4021", { telefone: "+5511999999999" })).toBe(
      "tel:+55119999999994021",
    );
  });

  it("sem telefone, `tel:` não monta — e o botão não aparece", () => {
    expect(montarHref("tel:{{telefone}}", { telefone: null })).toBeNull();
    expect(
      atalhosParaExibir([atalho({ icone: "telefone", url: "tel:{{telefone}}" })], {}),
    ).toEqual([]);
  });
});

describe("marcadores: sem dado o botão NÃO aparece", () => {
  it("lista os marcadores do modelo, sem repetir e sem caixa", () => {
    expect(marcadoresDoModelo("https://x/?a={{ nome }}&b={{erp_id}}&c={{NOME}}")).toEqual([
      "nome",
      "erp_id",
    ]);
  });

  it("resolve os marcadores fixos", () => {
    expect(valorDoMarcador("nome", DADOS)).toBe("Maria Silva");
    expect(valorDoMarcador("primeiro_nome", DADOS)).toBe("Maria");
    expect(valorDoMarcador("email", DADOS)).toBe("maria@exemplo.com");
    expect(valorDoMarcador("telefone", DADOS)).toBe("+5511999999999");
  });

  it("`{{documento}}` cai no campo personalizado do contato (o banco só guarda hash)", () => {
    expect(valorDoMarcador("documento", DADOS)).toBe("123.456.789-09");
    expect(valorDoMarcador("documento", { contato: { campos: { cnpj: "12.345.678/0001-90" } } })).toBe(
      "12.345.678/0001-90",
    );
    expect(valorDoMarcador("documento", {})).toBeNull();
  });

  it("campo personalizado sem prefixo procura no NEGÓCIO antes do contato", () => {
    expect(valorDoMarcador("erp_id", DADOS)).toBe("ERP-4471");
    expect(
      valorDoMarcador("codigo", {
        lead: { campos: { codigo: "do-negocio" } },
        contato: { campos: { codigo: "do-contato" } },
      }),
    ).toBe("do-negocio");
    expect(valorDoMarcador("contact.codigo", DADOS)).toBeNull();
  });

  it("`{{lead.id}}` e `{{contact.id}}` resolvem", () => {
    expect(valorDoMarcador("lead.id", DADOS)).toBe("lead-1");
    expect(valorDoMarcador("contact.id", DADOS)).toBe("contato-1");
  });

  it("e-mail sem `@` e valor não textual contam como AUSENTES", () => {
    expect(valorDoMarcador("email", { email: "maria.exemplo.com" })).toBeNull();
    expect(valorDoMarcador("erp_id", { lead: { campos: { erp_id: { a: 1 } } } })).toBeNull();
    // Número entra como texto: código de ERP numérico é comum.
    expect(valorDoMarcador("erp_id", { lead: { campos: { erp_id: 4471 } } })).toBe("4471");
  });

  it("UM marcador sem valor derruba o botão inteiro (nunca `{{...}}` cru)", () => {
    const comFalta = atalhosParaExibir(
      [atalho({ icone: "carrinho", url: "https://pedidos.exemplo.com/?c={{erp_id}}", rotulo: "Tirar pedido" })],
      { nome: "Maria" },
    );
    expect(comFalta).toEqual([]);

    const href = montarHref("https://pedidos.exemplo.com/?c={{erp_id}}", { nome: "Maria" });
    expect(href).toBeNull();
  });

  it("atalho SEM marcador aparece sempre — a URL fixa não depende de dado", () => {
    const fixos = atalhosParaExibir(
      [atalho({ rotulo: "Central do PABX", url: "https://pabx.exemplo.com/" })],
      {},
    );
    expect(fixos).toHaveLength(1);
    expect(fixos[0]?.href).toBe("https://pabx.exemplo.com/");
    expect(fixos[0]?.externo).toBe(true);
  });
});

describe("os três botões de exemplo da issue", () => {
  const CONFIGURADOS: AtalhoDoCard[] = [
    { rotulo: "Ligar", icone: "telefone", url: "tel:{{telefone}}" },
    { rotulo: "Tirar pedido", icone: "carrinho", url: "https://pedidos.exemplo.com/?cliente={{erp_id}}" },
    { rotulo: "Segunda via", icone: "boleto", url: "https://financeiro.exemplo.com/boleto?doc={{documento}}&email={{email}}" },
  ];

  it("desenha os três, com o href montado dado a dado", () => {
    const visiveis = atalhosParaExibir(CONFIGURADOS, DADOS);
    expect(visiveis.map((a) => a.rotulo)).toEqual(["Ligar", "Tirar pedido", "Segunda via"]);
    expect(visiveis.map((a) => a.href)).toEqual([
      "tel:+5511999999999",
      "https://pedidos.exemplo.com/?cliente=ERP-4471",
      "https://financeiro.exemplo.com/boleto?doc=123.456.789-09&email=maria%40exemplo.com",
    ]);
    // `tel:` não abre aba; os dois `https` abrem em aba nova.
    expect(visiveis.map((a) => a.externo)).toEqual([false, true, true]);
  });

  it("some SÓ o botão cujo dado falta — os outros continuam", () => {
    const semDocumento = atalhosParaExibir(CONFIGURADOS, {
      telefone: "+5511999999999",
      email: "maria@exemplo.com",
      lead: { campos: { erp_id: "ERP-4471" } },
    });
    expect(semDocumento.map((a) => a.rotulo)).toEqual(["Ligar", "Tirar pedido"]);
  });

  it("sem nenhum dos três dados, a faixa inteira desaparece", () => {
    expect(atalhosParaExibir(CONFIGURADOS, {})).toEqual([]);
  });
});

describe("leitura do jsonb — cadastro sujo não derruba o resto", () => {
  it("`atalhosDoFunil` devolve o que tem forma de atalho e descarta o resto", () => {
    const settings = {
      atalhos: [
        { rotulo: "Ligar", icone: "telefone", url: "tel:{{telefone}}" },
        null,
        "texto solto",
        { rotulo: "", icone: "telefone", url: "tel:1" },
        { rotulo: "Sem ícone", icone: "foguete", url: "https://x.com/" },
      ],
    };
    expect(atalhosDoFunil(settings)).toEqual([
      { rotulo: "Ligar", icone: "telefone", url: "tel:{{telefone}}" },
    ]);
  });

  it("modelo INVÁLIDO sobrevive à leitura — o editor precisa vê-lo para consertar", () => {
    const lidos = atalhosDoFunil({
      atalhos: [{ rotulo: "Quebrado", icone: "link", url: "javascript:alert(1)" }],
    });
    expect(lidos).toHaveLength(1);
    expect(atalhosParaExibir(lidos, DADOS)).toEqual([]);
  });

  it("settings sem a chave, ou com lixo, devolve lista vazia", () => {
    expect(atalhosDoFunil(null)).toEqual([]);
    expect(atalhosDoFunil({})).toEqual([]);
    expect(atalhosDoFunil({ atalhos: "não é lista" })).toEqual([]);
    expect(atalhosParaExibir(undefined, DADOS)).toEqual([]);
  });

  it("o teto de seis vale na leitura também", () => {
    const oito = Array.from({ length: 8 }, (_, i) => ({
      rotulo: `A${i}`,
      icone: "link" as const,
      url: `https://exemplo.com/${i}`,
    }));
    expect(atalhosDoFunil({ atalhos: oito })).toHaveLength(6);
  });
});
