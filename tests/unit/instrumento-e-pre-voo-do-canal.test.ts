import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O INSTRUMENTO E O PRÉ-VOO — os dois buracos que sobraram do canal oficial.
 *
 * ─── 1. O arquivo do corpo cru ─────────────────────────────────────────────
 *
 * `webhook_events_log` é o único lugar onde o payload original fica guardado. A
 * rota do canal por QR grava lá desde sempre; a rota genérica de canal não
 * gravava nada — zero escritores naquele caminho.
 *
 * Não é lacuna abstrata: a decisão sobre identidades opacas (`@lid`) só foi
 * possível porque esse arquivo existia em produção ("76 de 76", contados no
 * banco). O instrumento faltava justamente no canal NOVO, que é onde ainda há
 * pergunta aberta.
 *
 * ─── 2. O pré-voo da definição ─────────────────────────────────────────────
 *
 * O caminho da plataforma direta confere antes de gastar; o do canal
 * intermediado postava direto. Um parâmetro a mais virava `400` cru em vez de
 * "falta o valor {{2}}".
 *
 * ─── O que estes casos vigiam de verdade ───────────────────────────────────
 *
 * Que nenhuma das duas peças DERRUBE o que já funciona. Um arquivo que lança
 * apagaria a mensagem do cliente para guardar o log dela; um pré-voo severo
 * demais barraria envio bom numa instalação cujo espelho nunca sincronizou.
 * Em ambos, o modo de falhar importa mais que o caminho feliz.
 */

let inserido: Record<string, unknown> | null = null;
let atualizado: Record<string, unknown> | null = null;
let erroInsert: { message: string } | null = null;
let linhaTemplate: Record<string, unknown> | null = null;
let erroSelect: { message: string } | null = null;

const admin = {
  from() {
    return {
      insert(payload: Record<string, unknown>) {
        inserido = payload;
        return {
          select: () => ({
            maybeSingle: async () =>
              erroInsert ? { data: null, error: erroInsert } : { data: { id: "log-1" }, error: null },
          }),
        };
      },
      update(payload: Record<string, unknown>) {
        atualizado = payload;
        return { eq: async () => ({ error: null }) };
      },
      select() {
        const cadeia: Record<string, unknown> = {
          eq: () => cadeia,
          maybeSingle: async () =>
            erroSelect ? { data: null, error: erroSelect } : { data: linhaTemplate, error: null },
        };
        return cadeia;
      },
    };
  },
} as never;

beforeEach(() => {
  inserido = null;
  atualizado = null;
  erroInsert = null;
  erroSelect = null;
  linhaTemplate = null;
});

describe("o arquivo do corpo cru", () => {
  async function abrir(rawBody: string, headers: Headers) {
    const { abrirArquivoDoWebhook } = await import("@/lib/channels/arquivo-de-webhook");
    return abrirArquivoDoWebhook(admin, {
      organizationId: "org-1",
      channelSessionId: "sessao-1",
      provider: "canal-de-teste",
      rawBody,
      headers,
    });
  }

  it("grava o corpo CRU, e não só o interpretado", async () => {
    // O interpretado é o que já se sabe ler. O cru é o que responde a pergunta
    // que ainda não se sabe fazer — que é a razão de o arquivo existir.
    await abrir('{"event":"x"}', new Headers());
    expect(inserido).toMatchObject({ raw_body: '{"event":"x"}', status: "received" });
  });

  it("o provider vem de quem chamou, nunca de um literal", async () => {
    await abrir("{}", new Headers());
    expect(inserido).toMatchObject({ provider: "canal-de-teste" });
  });

  it("corpo que NÃO é JSON também é arquivado", async () => {
    // É o caso que ninguém consegue reproduzir depois. Descartá-lo por não
    // parsear perderia exatamente o payload que se quer investigar.
    const id = await abrir("<html>erro do proxy</html>", new Headers());
    expect(id).toBe("log-1");
    expect(inserido).toMatchObject({ raw_body: "<html>erro do proxy</html>", payload_parsed: null });
  });

  it("payload que é LISTA não vai para a coluna de objeto", async () => {
    await abrir("[1,2,3]", new Headers());
    expect(inserido).toMatchObject({ payload_parsed: null, raw_body: "[1,2,3]" });
  });

  it("guarda a assinatura mas NUNCA a credencial", async () => {
    // A assinatura permite reconferir depois se o payload recusado tinha mesmo
    // assinatura errada — e não abre nada sozinha. `authorization` abre.
    const h = new Headers({
      "x-zernio-signature": "abc123",
      authorization: "Bearer segredo",
      "x-api-key": "chave",
      cookie: "sessao=1",
    });
    await abrir("{}", h);
    const cabecalhos = inserido?.headers as Record<string, string>;
    expect(cabecalhos["x-zernio-signature"]).toBe("abc123");
    expect(Object.keys(cabecalhos), "vazou credencial para o arquivo").not.toContain("authorization");
    expect(Object.keys(cabecalhos)).not.toContain("x-api-key");
    expect(Object.keys(cabecalhos)).not.toContain("cookie");
  });

  it("falha ao arquivar NÃO derruba a ingestão", async () => {
    // Perder o log é ruim; perder a mensagem do cliente é pior. Devolver 500 ao
    // provedor faria ele reenviar tudo.
    erroInsert = { message: "tabela indisponível" };
    await expect(abrir("{}", new Headers())).resolves.toBeNull();
  });

  it("fechar sem id é no-op, não exceção", async () => {
    const { fecharArquivoDoWebhook } = await import("@/lib/channels/arquivo-de-webhook");
    await expect(
      fecharArquivoDoWebhook(admin, null, { status: "processed", validSignature: true }),
    ).resolves.toBeUndefined();
    expect(atualizado).toBeNull();
  });

  it("o desfecho fecha a linha", async () => {
    const { fecharArquivoDoWebhook } = await import("@/lib/channels/arquivo-de-webhook");
    await fecharArquivoDoWebhook(admin, "log-1", {
      status: "error",
      validSignature: false,
      erro: "bad_signature",
    });
    expect(atualizado).toMatchObject({ status: "error", valid_signature: false });
  });
});

describe("a rota chama o arquivo nos dois lados", () => {
  const ROTA = readFileSync("app/api/v1/webhooks/channel/[token]/route.ts", "utf8");

  it("abre ANTES de processar", () => {
    // Se o processo morrer no meio, o corpo cru precisa já estar gravado — que é
    // justamente quando alguém vai querer lê-lo.
    const abertura = ROTA.indexOf("abrirArquivoDoWebhook");
    const processamento = ROTA.indexOf("await handleInboundWebhook");
    expect(abertura).toBeGreaterThan(-1);
    expect(abertura, "o arquivo abre depois do processamento").toBeLessThan(processamento);
  });

  it("fecha em TODOS os desfechos — sucesso, recusa, exceção, assinatura inválida e outra conta", () => {
    // Eram 3. O conserto do arquivamento (#963) passou a abrir a linha ANTES da
    // conferência de assinatura, o que acrescentou dois desfechos que antes
    // saíam sem arquivo nenhum: assinatura inválida e evento de outra conta.
    // A propriedade que este caso quer ficou MAIS satisfeita; o que envelheceu
    // foi o número guardado aqui.
    const fechamentos = [...ROTA.matchAll(/await fecharArquivoDoWebhook\(/g)];
    expect(fechamentos.length, "algum desfecho deixa a linha eternamente 'received'").toBe(5);
  });
});

describe("o pré-voo da definição", () => {
  async function conferir(values: Record<string, string> = {}) {
    const { conferirDefinicao } = await import("@/lib/channels/conferir-definicao");
    return conferirDefinicao(admin, {
      organizationId: "org-1",
      channelSessionId: "sessao-1",
      name: "boas_vindas",
      language: "pt_BR",
      values,
    });
  }

  it("recusa definição que NÃO está aprovada, dizendo em que estado está", async () => {
    linhaTemplate = {
      name: "boas_vindas",
      language: "pt_BR",
      status: "REJECTED",
      contract_hash: "h1",
      components: [],
    };
    await expect(conferir()).rejects.toThrow(/template_not_approved.*REJECTED/s);
  });

  it("recusa quando falta valor, e diz QUAL falta", async () => {
    // "faltam 2" não serve: o operador precisa saber qual preencher, e essa é a
    // diferença entre a frase ajudar e não ajudar.
    linhaTemplate = {
      name: "boas_vindas",
      language: "pt_BR",
      status: "APPROVED",
      contract_hash: "h1",
      components: [{ type: "BODY", text: "Olá {{1}}, seu pedido {{2}} saiu." }],
    };
    await expect(conferir({})).rejects.toThrow(/template_missing_values/);
  });

  it("deixa passar quando os valores estão completos", async () => {
    linhaTemplate = {
      name: "boas_vindas",
      language: "pt_BR",
      status: "APPROVED",
      contract_hash: "h1",
      components: [{ type: "BODY", text: "Olá {{1}}." }],
    };
    // A chave do corpo NÃO tem prefixo — `slotKey` só prefixa header, botão e
    // card. Errar isto do lado de quem envia faz o pré-voo recusar um envio
    // completo, então o formato exato importa e está fixado aqui.
    await expect(conferir({ "1": "Marcela" })).resolves.toBeUndefined();
  });

  it("definição NÃO espelhada passa — o provedor é a autoridade, não o espelho", async () => {
    // Um espelho vazio (sync nunca rodou) barraria todo envio de modelo numa
    // instalação que está com tudo certo do lado da plataforma.
    linhaTemplate = null;
    await expect(conferir()).resolves.toBeUndefined();
  });

  it("falha de LEITURA não vira recusa de envio", async () => {
    // Barrar aqui trocaria um envio que ia dar certo por um erro nosso.
    erroSelect = { message: "banco fora" };
    await expect(conferir()).resolves.toBeUndefined();
  });

  it("exige nome e idioma", async () => {
    const { conferirDefinicao } = await import("@/lib/channels/conferir-definicao");
    await expect(
      conferirDefinicao(admin, {
        organizationId: "org-1",
        channelSessionId: null,
        name: "",
        language: "pt_BR",
        values: {},
      }),
    ).rejects.toThrow(/template_incompleto/);
  });
});

describe("o pré-voo roda antes de escolher transporte", () => {
  const HANDLER = readFileSync("app/api/v1/messages/_handler.ts", "utf8");

  it("vale para os DOIS caminhos de envio de modelo", () => {
    // Colocá-lo dentro de um dos ramos deixaria o outro sem conferência — que é
    // exatamente o estado anterior.
    const preVoo = HANDLER.indexOf("await conferirDefinicao(");
    const escolha = HANDLER.indexOf("externalId = adapter.sendTemplate");
    expect(preVoo).toBeGreaterThan(-1);
    expect(preVoo, "o pré-voo ficou depois da escolha de transporte").toBeLessThan(escolha);
  });

  it("confere a definição DESTA conexão", () => {
    // Dois números têm modelos diferentes; conferir o do número errado aprovaria
    // um envio que a plataforma recusa.
    expect(HANDLER).toMatch(/channelSessionId: c\.channel_session_id/);
  });
});

describe("o resgate de presas não toca canal que não alcança", () => {
  const WATCHDOG = readFileSync("lib/agent-engine/edge/crm/session-reconciler.ts", "utf8");

  it("filtra para as sessões que este transporte resolve", () => {
    // Sem o filtro, a consulta trazia mensagem de QUALQUER canal e postava com
    // a sessão nula.
    expect(WATCHDOG).toMatch(/and s\.waha_session_name is not null/);
  });

  it("mas CONTA as que ficaram de fora — silêncio é o que fez isso durar", () => {
    expect(WATCHDOG).toMatch(/mensagens presas em canal que este resgate não alcança/);
  });

  it("e não as reenvia daqui", () => {
    // Enviar em dobro é pior que não enviar, e este processo não tem como saber
    // se o outro caminho já mandou.
    const envios = [...WATCHDOG.matchAll(/\/api\/sendText/g)];
    expect(envios.length, "apareceu um segundo caminho de envio no watchdog").toBe(1);
  });
});
