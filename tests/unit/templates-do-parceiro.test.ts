import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * AS DEFINIÇÕES APROVADAS DO CANAL INTERMEDIADO.
 *
 * ─── O que não existia ─────────────────────────────────────────────────────
 *
 * O adapter sabe listar, criar, editar e apagar definições desde que o canal
 * entrou. O que faltava era a PORTA: a aba "Templates da Meta" vive dentro do
 * canal oficial, e o endpoint dela resolve a conexão por `metaSessionForOrg`.
 *
 * Numa instalação que só tem o canal intermediado — a do dono — isso devolve
 * lista vazia, e o seletor do inbox dizia "nenhum modelo aprovado ainda" para
 * uma conta cheia deles. Barrar o texto livre sem oferecer a saída deixou o
 * operador sem caminho nenhum.
 *
 * ─── O que estes casos prendem ─────────────────────────────────────────────
 *
 * Que a tela não decida a fonte com o nome do provider na mão; que o seletor do
 * inbox e a tela de gestão leiam a MESMA fonte; e que a lista de uma conta não
 * vaze para a conversa da outra.
 */
import { fonteDeTemplates, rotaDeTemplates } from "@/lib/channels/templates-fonte";
import {
  contarVariaveis,
  IDIOMAS_DA_DEFINICAO,
  lerConteudo,
  LIMITE_BOTOES,
  LIMITE_CORPO,
  LIMITE_RODAPE,
  montarComponents,
} from "@/lib/channels/template-conteudo";

describe("de onde vêm as definições", () => {
  it("canal intermediado busca na rota do parceiro", () => {
    expect(fonteDeTemplates("zernio")).toBe("parceiro");
  });

  it("canal oficial busca na rota de sempre", () => {
    expect(fonteDeTemplates("meta_cloud")).toBe("oficial");
  });

  it("parceiro Graph-compatível busca na rota própria", () => {
    expect(fonteDeTemplates("datafy")).toBe("graph");
  });

  it("número por QR não tem definição a listar", () => {
    // Ele manda texto livre a qualquer hora: um seletor ali ofereceria uma
    // solução para um problema que aquele canal não tem.
    expect(fonteDeTemplates("waha")).toBeNull();
  });

  it("sem canal resolvido, não busca nada", () => {
    expect(fonteDeTemplates(null)).toBeNull();
    expect(fonteDeTemplates(undefined)).toBeNull();
  });

  it("cada fonte tem sua rota, e são DIFERENTES", () => {
    // Se as duas apontassem para a mesma, o canal intermediado voltaria a ler a
    // lista da Meta — que é exatamente o defeito de origem.
    expect(rotaDeTemplates("parceiro")).toBe("/api/v1/channels/partner/templates");
    expect(rotaDeTemplates("oficial")).toBe("/api/v1/channels/templates");
    expect(rotaDeTemplates("graph")).toBe("/api/v1/channels/graph-partner/templates");
    expect(rotaDeTemplates("parceiro")).not.toBe(rotaDeTemplates("oficial"));
    expect(rotaDeTemplates("graph")).not.toBe(rotaDeTemplates("parceiro"));
  });
});

describe("os elos que somem sem barulho", () => {
  it("a tela do inbox NÃO decide pelo nome do provider", () => {
    const fonte = readFileSync("components/inbox/JanelaFechadaAviso.tsx", "utf8");
    expect(fonte).toMatch(/fonteDeTemplates/);
    expect(fonte, "a tela está nomeando provider").not.toMatch(/"zernio"|"meta_cloud"|"waha"/);
  });

  it("o cache é POR FONTE — senão a lista de uma conta vaza para a outra", () => {
    // Trocar de conversa entre canais com a mesma chave serviria o cache do
    // anterior, e o operador mandaria um modelo que não existe nesta conta.
    const fonte = readFileSync("components/inbox/JanelaFechadaAviso.tsx", "utf8");
    expect(fonte).toMatch(/queryKey: \["templates-da-conversa", fonte\]/);
  });

  it("a aba existe dentro do canal do parceiro", () => {
    // Sem porta, a tela não é alcançável — e o CI já reprova tela sem porta.
    const fonte = readFileSync("components/connections/ConexoesShell.tsx", "utf8");
    expect(fonte).toMatch(/\n\s*<TemplatesParceiroClient \/>/);
    expect(fonte).toMatch(/Modelos do parceiro/);
  });

  it("a aba Graph GERENCIA modelo — o gerenciar={false} saiu (#1734)", () => {
    // Ele existia porque o DELETE desta plataforma, por nome só, apagava TODAS
    // as variantes de idioma enquanto a tela apagaria uma (#1728). Desde a
    // #1734 o alvo resolve o id da variante por nome+idioma, então a aba usa o
    // MESMO cliente do outro parceiro, sem apagar botão.
    const fonte = readFileSync("components/connections/ConexoesShell.tsx", "utf8");
    expect(fonte).toContain('<TemplatesParceiroClient rota={rotaDeTemplates("graph")} />');
    expect(fonte, "a aba Graph ainda entrega o cliente com gerenciar desligado").not.toContain(
      "gerenciar={false}",
    );
  });

  it("a rota passa pelo SEAM, e não fala com a plataforma direto", () => {
    const fonte = readFileSync("app/api/v1/channels/partner/templates/route.ts", "utf8");
    expect(fonte).toMatch(/adapter\.templates\.list/);
    expect(fonte).toMatch(/adapter\.templates\.create/);
    // No SELECT, não só importada: a primeira versão deste caso aceitava a
    // constante presente no `import` enquanto o `select` nomeava as colunas à
    // mão. O guarda primário disto é o `lint:channels`, que reprovou a primeira
    // versão do arquivo; este caso é a rede de baixo.
    expect(fonte, "o select não usa a constante do seam").toMatch(
      /\.select\(`id, \$\{CHANNEL_SESSION_REF_COLUMNS\}`\)/,
    );
  });

  it("o espelho grava DE QUAL conexão veio (migration 0144)", () => {
    // Sem isso, dois números do mesmo provider dividem a mesma lista — e o
    // seletor de um oferece o modelo do outro.
    const fonte = readFileSync("app/api/v1/channels/partner/templates/route.ts", "utf8");
    expect(fonte).toMatch(/channel_session_id: r\.ctx\.sessionId/);
    expect(fonte).toMatch(/\.eq\("channel_session_id", r\.ctx\.sessionId\)/);
  });

  it("criar TAMBÉM sincroniza — senão o operador cria a mesma duas vezes", () => {
    // A definição nasce em revisão e não aparece na lista de envio. Se a tela
    // não a mostrasse pendente, ele concluiria que não salvou.
    const fonte = readFileSync("app/api/v1/channels/partner/templates/route.ts", "utf8");
    const iCriar = fonte.indexOf('corpo.acao === "criar"');
    const iSync = fonte.indexOf("adapter.templates.list");
    expect(iCriar).toBeGreaterThan(-1);
    expect(iSync).toBeGreaterThan(iCriar);
  });
});

describe("o conteúdo da definição, e o campo que causava as recusas", () => {
  it("lê corpo, cabeçalho, rodapé e botões do payload cru", () => {
    const c = lerConteudo([
      { type: "HEADER", format: "TEXT", text: "Olá" },
      { type: "BODY", text: "Seu pedido {{1}} chega dia {{2}}." },
      { type: "FOOTER", text: "Equipe" },
      { type: "BUTTONS", buttons: [{ type: "URL", text: "Rastrear" }] },
    ]);
    expect(c.body).toContain("Seu pedido");
    expect(c.header).toMatchObject({ formato: "TEXT", texto: "Olá" });
    expect(c.footer).toBe("Equipe");
    expect(c.botoes).toEqual([{ tipo: "URL", texto: "Rastrear" }]);
  });

  it("tolera caixa minúscula — leitura e escrita usam formatos diferentes", () => {
    // A leitura vem da plataforma em maiúsculas; a escrita do intermediário em
    // minúsculas. Um lado só faria metade das definições parecer vazia.
    const c = lerConteudo([{ type: "body", text: "oi" }]);
    expect(c.body).toBe("oi");
  });

  it("definição sem rodapé não é erro", () => {
    const c = lerConteudo([{ type: "BODY", text: "oi" }]);
    expect(c.footer).toBeNull();
    expect(c.botoes).toEqual([]);
  });

  it("conta as variáveis pelo MAIOR índice, não pelas ocorrências", () => {
    // `{{1}}` repetido pede UM valor; `{{1}}` e `{{3}}` pedem TRÊS, porque a
    // plataforma numera por posição e recusa lista com buracos.
    expect(contarVariaveis("oi {{1}}, tudo bem {{1}}?")).toBe(1);
    expect(contarVariaveis("{{1}} e {{3}}")).toBe(3);
    expect(contarVariaveis("sem variável")).toBe(0);
  });

  it("MONTA o example que a revisão exige — a causa das recusas", () => {
    // O formulário deixava digitar `{{1}}` e nunca coletava a amostra. Recusa
    // garantida, por omissão da nossa tela.
    const comps = montarComponents({ body: "Olá {{1}}", exemplos: ["María"] }) as {
      type: string;
      example?: { body_text: string[][] };
    }[];
    expect(comps[0]?.example?.body_text).toEqual([["María"]]);
  });

  it("o example é ARRAY DE ARRAYS — array simples é recusado", () => {
    const comps = montarComponents({ body: "{{1}} {{2}}", exemplos: ["a", "b"] }) as {
      example?: { body_text: string[][] };
    }[];
    expect(Array.isArray(comps[0]?.example?.body_text?.[0])).toBe(true);
  });

  it("campo em branco vira marcador, não vazio — vazio também é recusado", () => {
    const comps = montarComponents({ body: "Olá {{1}}", exemplos: ["  "] }) as {
      example?: { body_text: string[][] };
    }[];
    expect(comps[0]?.example?.body_text?.[0]?.[0]).toBe("exemplo");
  });

  it("sem variável NÃO manda example — campo vazio à toa também é recusa", () => {
    const comps = montarComponents({ body: "Texto fixo", exemplos: [] }) as {
      example?: unknown;
    }[];
    expect(comps[0]?.example).toBeUndefined();
  });

  it("a tela OFERECE a categoria — antes tudo saía como UTILITY", () => {
    // Mandar promoção como utility é reclassificado ou recusado, e a tarifa da
    // categoria errada é mais cara.
    const fonte = readFileSync("components/connections/TemplatesParceiroClient.tsx", "utf8");
    expect(fonte).toMatch(/category: categoria/);
    expect(fonte).toMatch(/value="MARKETING"/);
    expect(fonte).toMatch(/value="AUTHENTICATION"/);
  });

  it("e PEDE os exemplos, em vez de mandar sem eles", () => {
    const fonte = readFileSync("components/connections/TemplatesParceiroClient.tsx", "utf8");
    // O `exemplos` chega a `montarComponents` — a forma da chamada mudou quando
    // cabeçalho e botões entraram, o objeto virou multilinha.
    expect(fonte).toMatch(/montarComponents\(\{[\s\S]{0,200}?exemplos,/);
    expect(fonte).toMatch(/nVariaveis > 0 &&/);
  });

  it("a rota devolve o CONTEÚDO, não só o estado", () => {
    const fonte = readFileSync("app/api/v1/channels/partner/templates/route.ts", "utf8");
    expect(fonte).toMatch(/components: \(t\.components as unknown\[\]\) \?\? \[\]/);
  });
});

describe("o formulário completo — idioma, cabeçalho e botões", () => {
  it("o idioma vem de LISTA, não digitado", () => {
    // `esp`, `ES`, `es-AR` e `español` são todos recusados, e a recusa volta
    // como "language not supported" horas depois. Escolher não erra.
    const fonte = readFileSync("components/connections/TemplatesParceiroClient.tsx", "utf8");
    expect(fonte).toMatch(/IDIOMAS_DA_DEFINICAO\.map/);
    expect(fonte, "o idioma ainda é campo livre").not.toMatch(
      /placeholder="es"\s*\n\s*aria-label="Idioma"/,
    );
  });

  it("a lista traz os códigos no formato da plataforma", () => {
    // `es_AR`, não `es-AR` nem `ES`.
    for (const i of IDIOMAS_DA_DEFINICAO) {
      expect(i.codigo, i.codigo).toMatch(/^[a-z]{2}(_[A-Z]{2})?$/);
    }
  });

  it("cabeçalho de TEXTO leva exemplo PRÓPRIO", () => {
    // `header_text` é separado de `body_text`. Usar o do corpo manda a amostra
    // errada e a revisão recusa.
    const c = montarComponents({
      body: "corpo",
      exemplos: [],
      cabecalho: { texto: "Oi {{1}}" },
    }) as { type: string; example?: { header_text?: string[] } }[];
    expect(c[0]?.type).toBe("HEADER");
    expect(c[0]?.example?.header_text).toHaveLength(1);
  });

  it("cabeçalho de MÍDIA usa header_handle, não texto", () => {
    const c = montarComponents({
      body: "corpo",
      exemplos: [],
      cabecalho: { midiaUrl: "https://exemplo/foto.jpg" },
    }) as { type: string; format?: string; example?: { header_handle?: string[] } }[];
    expect(c[0]).toMatchObject({ type: "HEADER", format: "IMAGE" });
    expect(c[0]?.example?.header_handle).toEqual(["https://exemplo/foto.jpg"]);
  });

  it("o cabeçalho vem ANTES do corpo — a ordem é a da mensagem", () => {
    const c = montarComponents({
      body: "corpo",
      exemplos: [],
      cabecalho: { texto: "Título" },
    }) as { type: string }[];
    expect(c.map((x) => x.type)).toEqual(["HEADER", "BODY"]);
  });

  it("os botões saem num ÚNICO componente, como pede o contrato", () => {
    const c = montarComponents({
      body: "corpo",
      exemplos: [],
      botoes: [
        { tipo: "quick_reply", texto: "Sim" },
        { tipo: "url", texto: "Ver", url: "https://x.com" },
      ],
    }) as { type: string; buttons?: unknown[] }[];
    const bts = c.find((x) => x.type === "BUTTONS");
    expect(bts?.buttons).toHaveLength(2);
  });

  it("URL sem endereço e telefone sem número NÃO são enviados", () => {
    // Vão ser recusados de qualquer jeito; mandar só faz o operador esperar
    // horas por um "não" que já se sabia.
    const c = montarComponents({
      body: "corpo",
      exemplos: [],
      botoes: [
        { tipo: "url", texto: "Ver", url: "" },
        { tipo: "phone_number", texto: "Ligar", telefone: "" },
        { tipo: "quick_reply", texto: "Ok" },
      ],
    }) as { type: string; buttons?: { type: string }[] }[];
    const bts = c.find((x) => x.type === "BUTTONS");
    expect(bts?.buttons?.map((b) => b.type)).toEqual(["QUICK_REPLY"]);
  });

  it("botão sem texto não entra, e o teto é respeitado", () => {
    const c = montarComponents({
      body: "corpo",
      exemplos: [],
      botoes: [
        { tipo: "quick_reply", texto: "" },
        { tipo: "quick_reply", texto: "a" },
        { tipo: "quick_reply", texto: "b" },
        { tipo: "quick_reply", texto: "c" },
        { tipo: "quick_reply", texto: "d" },
      ],
    }) as { type: string; buttons?: unknown[] }[];
    expect(c.find((x) => x.type === "BUTTONS")?.buttons).toHaveLength(LIMITE_BOTOES);
  });

  it("a tela respeita os limites de tamanho da plataforma", () => {
    // Passar do limite é recusa, e a recusa não diz que o problema era o tamanho.
    const fonte = readFileSync("components/connections/TemplatesParceiroClient.tsx", "utf8");
    expect(fonte).toMatch(/slice\(0, LIMITE_CORPO\)/);
    expect(fonte).toMatch(/slice\(0, LIMITE_RODAPE\)/);
    expect(LIMITE_CORPO).toBe(1024);
    expect(LIMITE_RODAPE).toBe(60);
  });

  it("texto e mídia no cabeçalho se EXCLUEM — mandar os dois é recusa", () => {
    // Os dois sentidos: digitar texto limpa a mídia, e subir imagem limpa o
    // texto. E o campo de texto DESABILITA o de imagem enquanto tem conteúdo —
    // a forma mudou quando o "colar URL" virou "subir arquivo", mas a regra é a
    // mesma: a plataforma aceita um formato por definição.
    const fonte = readFileSync("components/connections/TemplatesParceiroClient.tsx", "utf8");
    expect(fonte).toMatch(/if \(e\.target\.value\) setMidiaUrl\(""\)/);
    expect(fonte).toMatch(/setMidiaUrl\(j\.data\.url\);\s*\n\s*setCabecalho\(""\);/);
    expect(fonte).toMatch(/cabecalho && "pointer-events-none opacity-50"/);
  });
});

describe("subir a imagem e ver a prévia", () => {
  it("o cabeçalho de mídia SOBE o arquivo — não pede URL colada", () => {
    // Colar exigia que o operador já tivesse a imagem hospedada em algum lugar
    // público, que é justamente o que ele não tem.
    const fonte = readFileSync("components/connections/TemplatesParceiroClient.tsx", "utf8");
    expect(fonte).toMatch(/type="file"/);
    expect(fonte).toMatch(/accept="image\/jpeg,image\/png"/);
    expect(fonte).toMatch(/\/api\/v1\/channels\/partner\/templates\/media/);
  });

  it("a rota devolve link ASSINADO — o bucket é privado", () => {
    // Tornar o bucket público resolveria o cabeçalho e exporia o histórico de
    // mídia de todos os clientes, que mora no mesmo lugar.
    const fonte = readFileSync("app/api/v1/channels/partner/templates/media/route.ts", "utf8");
    expect(fonte).toMatch(/createSignedUrl\(caminho, VALIDADE_SEGUNDOS\)/);
    expect(fonte).toMatch(/7 \* 24 \* 60 \* 60/);
  });

  it("e recusa formato e tamanho ANTES de subir", () => {
    // Deixar subir faria a recusa chegar horas depois, falando de um formato
    // que o operador escolheu porque a tela deixou.
    const fonte = readFileSync("app/api/v1/channels/partner/templates/media/route.ts", "utf8");
    expect(fonte).toMatch(/TIPOS\.has\(mime\)/);
    expect(fonte).toMatch(/file\.size > TAMANHO_MAX/);
  });

  it("a prévia é montada, e AO LADO do formulário", () => {
    // Embaixo ela sai da tela junto com o botão de enviar, e o operador manda
    // sem ter olhado.
    const fonte = readFileSync("components/connections/TemplatesParceiroClient.tsx", "utf8");
    expect(fonte).toMatch(/\n\s*<PreviaDaDefinicao/);
    expect(fonte).toMatch(/lg:grid-cols-\[1fr_20rem\]/);
  });

  it("a prévia AVISA da numeração com buraco", () => {
    // `{{3}}` sem `{{1}}` é recusado — a lista de valores é posicional. Ver
    // isso antes poupa o ciclo de revisão inteiro.
    const fonte = readFileSync("components/connections/PreviaDaDefinicao.tsx", "utf8");
    expect(fonte).toMatch(/faltando/);
    expect(fonte).toMatch(/numeração é sequencial/);
  });

  it("as variáveis aparecem COMO variáveis, não substituídas", () => {
    // Substituir pelo exemplo mostraria uma mensagem que nunca vai existir; o
    // que se confere aqui é ONDE está o buraco.
    const fonte = readFileSync("components/connections/PreviaDaDefinicao.tsx", "utf8");
    expect(fonte).toMatch(/\{corpo\}/);
    expect(fonte, "a prévia está substituindo as variáveis").not.toMatch(/replace\(.*\{\{/);
  });
});
