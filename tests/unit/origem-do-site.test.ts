import { describe, expect, it, vi } from "vitest";

import {
  CHAVES_DE_UTM,
  ehAPrimeiraMensagemDoContato,
  estamparOrigemDaPagina,
  extrairOrigemDaPagina,
  montarCodigoDeOrigemDoSite,
  TAMANHO_MAXIMO_DO_CODIGO,
} from "@/lib/leads/origem-do-site";

/**
 * A ORIGEM DA PÁGINA NÃO TEM POR ONDE ENTRAR NO WHATSAPP.
 *
 * A atribuição de anúncio (`lib/leads/atribuicao-de-anuncio.ts`) grava plataforma
 * e id do anúncio a partir do `referral`/contexto de anúncio. A origem de SITE não
 * tem esse transporte: o `wa.me/<numero>?text=...` abre o WhatsApp pelo sistema
 * operacional, sem cookie, sem referrer e sem sessão — a UTM morre na página.
 *
 * O único fio que atravessa essa fronteira é o TEXTO que a pessoa manda. É por ele
 * que a página embute um código curto, e é por ele que a ingestão o reconhece.
 *
 * ─── O que este módulo NÃO faz, de propósito ────────────────────────────────
 *
 * O código chega pelo texto do cliente: qualquer pessoa pode digitar, copiar,
 * encaminhar, editar ou repetir o marcador de outra. Ele é tratado como ENTRADA
 * NÃO CONFIÁVEL — só a primeira mensagem vale, o primeiro toque nunca é
 * sobrescrito, e nada disso é autorização de nada: é rótulo de origem.
 */
describe("o código que a página embute", () => {
  it("monta e extrai de volta, campo a campo", () => {
    const utm = {
      utm_source: "instagram",
      utm_medium: "social",
      utm_campaign: "pesquisa-preco",
      gclid: "Cj0KCQjw",
    };
    const codigo = montarCodigoDeOrigemDoSite(utm);
    expect(codigo).toMatch(/^\[dk1:[A-Za-z0-9_-]+\]$/);
    expect(extrairOrigemDaPagina(codigo)?.utm).toEqual(utm);
  });

  it("carrega os quatro níveis: campanha, conjunto, anúncio e posicionamento", () => {
    // O que quem opera tráfego pede da ficha do contato. Antes só a campanha
    // atravessava: conjunto, anúncio e posicionamento morriam no filtro da lista
    // fechada, e a tela não tinha o que mostrar porque o dado nunca chegava.
    const utm = {
      utm_campaign: "black-friday",
      utm_adset: "mulheres-25-34",
      utm_ad: "video-depoimento-v3",
      utm_placement: "instagram_stories",
    };
    expect(extrairOrigemDaPagina(montarCodigoDeOrigemDoSite(utm))?.utm).toEqual(utm);
  });

  it("sobrevive ao texto pré-preenchido do wa.me, que vai URL-encoded", () => {
    const codigo = montarCodigoDeOrigemDoSite({ utm_source: "google", gclid: "abc" });
    const link = `https://wa.me/5511999999999?text=${encodeURIComponent(`ola, vi o site ${codigo}`)}`;
    const textoComoChega = decodeURIComponent(new URL(link).searchParams.get("text") ?? "");
    expect(extrairOrigemDaPagina(textoComoChega)?.utm).toMatchObject({
      utm_source: "google",
      gclid: "abc",
    });
  });

  it("é achado no meio de uma frase, sem exigir mensagem exclusiva", () => {
    const codigo = montarCodigoDeOrigemDoSite({ utm_source: "site" });
    expect(extrairOrigemDaPagina(`bom dia!! ${codigo} queria saber o preco`)).not.toBeNull();
  });

  it("é estável: o mesmo mapa rende o mesmo código", () => {
    const a = { utm_campaign: "x", utm_source: "y" };
    const b = { utm_source: "y", utm_campaign: "x" };
    expect(montarCodigoDeOrigemDoSite(a)).toBe(montarCodigoDeOrigemDoSite(b));
  });
});

describe("o que NÃO vale como origem", () => {
  it("texto sem código não rende origem", () => {
    expect(extrairOrigemDaPagina("oi, tudo bem?")).toBeNull();
    expect(extrairOrigemDaPagina(null)).toBeNull();
  });

  it("marcador de versão desconhecida é ignorado", () => {
    expect(extrairOrigemDaPagina("[dk2:eyJ1dG1fc291cmNlIjoiaWcifQ]")).toBeNull();
  });

  it("carga ilegível não derruba a ingestão", () => {
    // base64url válido, JSON inválido: é o caso de um marcador truncado pelo
    // teclado de alguém. A ingestão tem de continuar, sem exceção.
    expect(() => extrairOrigemDaPagina("[dk1:aaaaaaaa]")).not.toThrow();
    expect(extrairOrigemDaPagina("[dk1:aaaaaaaa]")).toBeNull();
  });

  it("chave fora da lista conhecida é descartada", () => {
    const codigo = montarCodigoDeOrigemDoSite({
      utm_source: "instagram",
      // A chave fora da lista não é erro de tipo: `montarCodigoDeOrigemDoSite`
      // recebe `Record<string, string>` e quem descarta o que não é UTM conhecida
      // é o filtro em tempo de execução — que é o que este caso prova.
      telefone_do_cliente: "5511999999999",
    });
    const origem = extrairOrigemDaPagina(codigo);
    expect(origem?.utm).toEqual({ utm_source: "instagram" });
    expect(CHAVES_DE_UTM).toContain("utm_source");
  });

  it("valor vazio é descartado e, sem nada válido, não há origem", () => {
    const codigo = montarCodigoDeOrigemDoSite({ utm_source: "   ", utm_medium: "" });
    expect(extrairOrigemDaPagina(codigo)).toBeNull();
  });

  it("normaliza a caixa da chave e tira espaços do valor", () => {
    const carga = JSON.stringify({ "  UTM_SOURCE  ": "  instagram  " });
    const b64 = Buffer.from(carga, "utf8").toString("base64url");
    expect(extrairOrigemDaPagina(`[dk1:${b64}]`)?.utm).toEqual({ utm_source: "instagram" });
  });
});

describe("a estampagem no contato", () => {
  function bancoDeMentira(erro: { message: string } | null = null) {
    const chamadas: Record<string, unknown>[] = [];
    const admin = {
      async rpc(_nome: string, args: Record<string, unknown>) {
        chamadas.push(args);
        return { error: erro };
      },
    } as never;
    return { admin, chamadas };
  }

  it("grava pela fn_estampar_atribuicao_de_anuncio com a marca de primeiro toque", async () => {
    const { admin, chamadas } = bancoDeMentira();
    const ok = await estamparOrigemDaPagina(admin, "org-1", "contato-1", {
      utm: { utm_source: "instagram", gclid: "Cj0KCQjw" },
      capturadaEm: "2026-09-14T10:00:00.000Z",
    });
    expect(ok).toBe(true);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toMatchObject({
      p_org: "org-1",
      p_contact: "contato-1",
      p_platform: "site",
      p_metadata: {
        ad_platform: "site",
        utm_source: "instagram",
        gclid: "Cj0KCQjw",
        origem_capturada_em: "2026-09-14T10:00:00.000Z",
      },
    });
  });

  it("devolve false e não lança quando o banco recusa", async () => {
    const { admin } = bancoDeMentira({ message: "permission denied" });
    await expect(
      estamparOrigemDaPagina(admin, "org-1", "contato-1", { utm: { utm_source: "ig" }, capturadaEm: null }),
    ).resolves.toBe(false);
  });
});

/**
 * CONDIÇÃO 1 DA DECISÃO DA #924: "o código tem tamanho máximo e leva só os
 * campos de campanha (utm_* e, quando houver, o identificador de clique)".
 *
 * As duas metades são medidas aqui: o TETO (um número só, valendo nos dois
 * lados) e a LISTA FECHADA (dado pessoal não atravessa, nem escrito à mão).
 */
describe("o teto de tamanho do código", () => {
  /** Um marcador montado à mão, como o que qualquer pessoa consegue digitar. */
  const marcadorCom = (valor: string, chave = "utm_source") =>
    `[dk1:${Buffer.from(JSON.stringify({ [chave]: valor }), "utf8").toString("base64url")}]`;

  it("o gerador recusa o que não caberia, em vez de emitir um link que não funciona", () => {
    // As dez chaves no teto de valor, com texto de quatro bytes por caractere.
    // O gerador corta cada valor em 200 unidades UTF-16 antes de montar — cada
    // 🚀 ocupa duas, então sobram 100 por chave —, e o código fica com 5535
    // caracteres, muito acima do teto. A página recebe `null` e sabe que não há
    // link — melhor do que um link que a ingestão ignoraria calada.
    const gigante = Object.fromEntries(
      CHAVES_DE_UTM.map((chave) => [chave, "🚀".repeat(200)]),
    );
    expect(montarCodigoDeOrigemDoSite(gigante)).toBeNull();
  });

  it("o pior caso plausível CABE: as dez chaves no teto de valor", () => {
    // 2868 caracteres de base64url — o motivo de o teto ser o número que é. Se
    // este caso passasse a ser recusado, a página perderia link de campanha de
    // verdade, e não de colagem aleatória.
    const noLimite = Object.fromEntries(CHAVES_DE_UTM.map((chave) => [chave, "x".repeat(200)]));
    const codigo = montarCodigoDeOrigemDoSite(noLimite);
    expect(codigo).not.toBeNull();
    expect(codigo!.length).toBeLessThanOrEqual(TAMANHO_MAXIMO_DO_CODIGO + 8);
    expect(extrairOrigemDaPagina(codigo)?.utm).toEqual(noLimite);
  });

  it("aceita o código no teto exato e ignora um caractere além dele", () => {
    const noTeto = marcadorCom("x".repeat(2233)); // carga de 3000 caracteres
    const acima = marcadorCom("x".repeat(2234)); // carga de 3002
    expect(noTeto.length).toBe(TAMANHO_MAXIMO_DO_CODIGO + "[dk1:".length + 1);
    expect(extrairOrigemDaPagina(noTeto)?.utm.utm_source).toHaveLength(200);
    expect(extrairOrigemDaPagina(acima)).toBeNull();
  });

  it("o teto vale nos DOIS lados, do mesmo número", () => {
    // Com dois números separados, o gerador emitiria o que o parser descarta —
    // e o defeito não apareceria em lugar nenhum, porque não há erro: só um
    // link que nunca vira atribuição.
    const cargaDoParser = (n: number) =>
      Buffer.from(JSON.stringify({ utm_source: "x".repeat(n) }), "utf8").toString("base64url");
    expect(cargaDoParser(2233)).toHaveLength(TAMANHO_MAXIMO_DO_CODIGO);
    expect(extrairOrigemDaPagina(marcadorCom("x".repeat(2233)))).not.toBeNull();
    expect(extrairOrigemDaPagina(marcadorCom("x".repeat(2234)))).toBeNull();
  });
});

describe("o que o texto do cliente NÃO consegue carregar", () => {
  it("dado pessoal não atravessa, mesmo escrito à mão no marcador", () => {
    // O marcador é texto do cliente: qualquer um digita o JSON que quiser. Quem
    // decide o que entra é a lista fechada de chaves de campanha — o resto é
    // descartado ANTES de virar origem, e não depois de já estar gravado.
    const carga = Buffer.from(
      JSON.stringify({
        utm_source: "instagram",
        nome: "Marcela Souza",
        email: "marcela@exemplo.com",
        cpf: "123.456.789-00",
        telefone: "+55 11 99999-9999",
        endereco: "Rua das Flores, 123",
      }),
      "utf8",
    ).toString("base64url");
    const origem = extrairOrigemDaPagina(`[dk1:${carga}]`);
    expect(origem?.utm).toEqual({ utm_source: "instagram" });
    expect(JSON.stringify(origem)).not.toContain("Marcela");
    expect(JSON.stringify(origem)).not.toContain("123.456");
    expect(JSON.stringify(origem)).not.toContain("exemplo.com");
  });

  it("o identificador de clique de anúncio entra: é campo de campanha", () => {
    // `gclid`/`fbclid` são o que a plataforma de anúncio usa para casar o
    // clique. Fazem parte do que a decisão chama de "identificador de clique".
    const carga = Buffer.from(
      JSON.stringify({ utm_source: "google", gclid: "Cj0KCQjw", fbclid: "IwAR1abc" }),
      "utf8",
    ).toString("base64url");
    expect(extrairOrigemDaPagina(`[dk1:${carga}]`)?.utm).toEqual({
      utm_source: "google",
      gclid: "Cj0KCQjw",
      fbclid: "IwAR1abc",
    });
  });

  it("colagem longa num valor só é cortada no teto do valor, não aceita inteira", () => {
    const carga = Buffer.from(
      JSON.stringify({ utm_campaign: "x".repeat(1000) }),
      "utf8",
    ).toString("base64url");
    expect(extrairOrigemDaPagina(`[dk1:${carga}]`)?.utm.utm_campaign).toHaveLength(200);
  });
});

/**
 * CONDIÇÃO 2, PRIMEIRA METADE: "vale só na primeira mensagem do contato".
 *
 * A segunda metade ("nunca sobrescreve uma origem já gravada, inclusive a de
 * anúncio") é da `fn_estampar_atribuicao_de_anuncio`, no banco, e está coberta
 * em `supabase/migrations/*_0164_atribuicao_de_anuncio.sql`.
 */
describe("a origem só vale na primeira mensagem do contato", () => {
  function bancoDeMensagens(leitura: { id: string | null; count: number | null }, erro = false) {
    const filtros: Record<string, unknown> = {};
    const ordens: string[] = [];
    const consulta = {
      eq(coluna: string, valor: unknown) {
        filtros[coluna] = valor;
        return consulta;
      },
      order(coluna: string) {
        ordens.push(coluna);
        return consulta;
      },
      limit() {
        return consulta;
      },
      async maybeSingle() {
        return {
          data: leitura.id ? { id: leitura.id } : null,
          count: leitura.count,
          error: erro ? { message: "banco fora do ar" } : null,
        };
      },
    };
    const admin = { from: () => ({ select: () => consulta }) } as never;
    return { admin, filtros, ordens };
  }

  /** As colunas que a consulta pode filtrar — em snake_case, como no banco. */
  type LinhaDeMensagem = {
    id: string;
    organization_id: string;
    contact_id: string;
    direction: string;
    sent_at: string;
  };

  /**
   * Um banco de MENTIRA com as DUAS organizações, que aplica os filtros.
   *
   * O outro fake só anota os `eq` — prende a FORMA da consulta. Este prende o
   * EFEITO: sem o filtro de organização, a linha da outra organização entra no
   * resultado e a resposta muda. Não há RLS aqui, do mesmo jeito que não há no
   * client de admin (service role) que a função usa.
   */
  function bancoDeDuasOrganizacoes(linhas: LinhaDeMensagem[]) {
    const filtros: Record<string, unknown> = {};
    const consulta = {
      eq(coluna: string, valor: unknown) {
        filtros[coluna] = valor;
        return consulta;
      },
      order() {
        return consulta;
      },
      limit() {
        return consulta;
      },
      async maybeSingle() {
        const encontradas = linhas
          .filter((linha) =>
            Object.entries(filtros).every(
              ([coluna, valor]) => (linha as Record<string, unknown>)[coluna] === valor,
            ),
          )
          .sort((a, b) => a.sent_at.localeCompare(b.sent_at));
        return {
          data: encontradas[0] ? { id: encontradas[0].id } : null,
          count: encontradas.length,
          error: null,
        };
      },
    };
    const admin = { from: () => ({ select: () => consulta }) } as never;
    return { admin, filtros };
  }

  it("a mensagem que chegou agora é a mais antiga de entrada: vale", async () => {
    const { admin } = bancoDeMensagens({ id: "msg-1", count: 1 });
    await expect(ehAPrimeiraMensagemDoContato(admin, "org-1", "contato-1", "msg-1")).resolves.toBe(
      true,
    );
  });

  it("já havia mensagem de entrada antes desta: NÃO vale", async () => {
    // É o caso do link encaminhado adiante: o código chega, mas não é a
    // primeira coisa que este contato escreveu. A origem não entra.
    const { admin } = bancoDeMensagens({ id: "msg-0", count: 2 });
    await expect(ehAPrimeiraMensagemDoContato(admin, "org-1", "contato-1", "msg-1")).resolves.toBe(
      false,
    );
  });

  it("reentrega (sem id novo) só vale quando há UMA única mensagem de entrada", async () => {
    const uma = bancoDeMensagens({ id: "msg-1", count: 1 });
    await expect(ehAPrimeiraMensagemDoContato(uma.admin, "org-1", "contato-1", null)).resolves.toBe(
      true,
    );
    const varias = bancoDeMensagens({ id: "msg-1", count: 3 });
    await expect(
      ehAPrimeiraMensagemDoContato(varias.admin, "org-1", "contato-1", null),
    ).resolves.toBe(false);
  });

  it("sem linha nenhuma, e com erro de leitura, não vale: na dúvida não se grava", async () => {
    const vazio = bancoDeMensagens({ id: null, count: 0 });
    await expect(
      ehAPrimeiraMensagemDoContato(vazio.admin, "org-1", "contato-1", "msg-1"),
    ).resolves.toBe(false);
    const comErro = bancoDeMensagens({ id: "msg-1", count: 1 }, true);
    await expect(
      ehAPrimeiraMensagemDoContato(comErro.admin, "org-1", "contato-1", "msg-1"),
    ).resolves.toBe(false);
  });

  it("a pergunta é sobre as mensagens de ENTRADA desta organização e deste contato, na ordem de chegada", async () => {
    // Se a consulta não filtrasse por organização, a resposta seria sobre um
    // contato que não é deste tenant; sem `contact_id`, a de um contato
    // decidiria a de outro; sem `inbound`, um envio nosso contaria como
    // primeira mensagem dele.
    const { admin, filtros, ordens } = bancoDeMensagens({ id: "msg-1", count: 1 });
    await ehAPrimeiraMensagemDoContato(admin, "org-9", "contato-9", "msg-1");
    expect(filtros).toEqual({
      organization_id: "org-9",
      contact_id: "contato-9",
      direction: "inbound",
    });
    expect(ordens).toEqual(["sent_at", "created_at"]);
  });

  it("mensagem de ENTRADA de outra organização não decide esta (#1108)", async () => {
    // O `contact_id` de hoje é uuid e não colide entre tenants: este caso não
    // encena uma colisão real, ele prende a REGRA — a consulta sai pelo client
    // de admin, sem RLS, então o que existe fora da fronteira não pode entrar
    // na resposta. A mensagem da outra organização é a mais antiga: sem o
    // filtro é ela que responde, e a origem da página deste contato passaria a
    // ser decidida por dado de outro tenant.
    const { admin, filtros } = bancoDeDuasOrganizacoes([
      {
        id: "msg-de-fora",
        organization_id: "org-b",
        contact_id: "contato-1",
        direction: "inbound",
        sent_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "msg-1",
        organization_id: "org-a",
        contact_id: "contato-1",
        direction: "inbound",
        sent_at: "2026-02-01T00:00:00.000Z",
      },
    ]);

    await expect(
      ehAPrimeiraMensagemDoContato(admin, "org-a", "contato-1", "msg-1"),
    ).resolves.toBe(true);
    expect(filtros.organization_id).toBe("org-a");
  });
});
