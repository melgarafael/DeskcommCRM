// @vitest-environment node
/**
 * PROVA PELO SDK, não pela função.
 *
 * `scrub.test.ts` chama o hook direto: fica verde mesmo que o `Sentry.init`
 * nunca o chame, ou que o SDK mude o formato do que entrega a ele — foi o que o
 * Sentry 11 fez com o span (`description`→`name`, `data`→`attributes`), e o hook
 * antigo continuaria sendo chamado sem limpar nada.
 *
 * Aqui o `@sentry/nextjs` de verdade (entrada de servidor, a que o app e o
 * worker usam) roda com as MESMAS opções dos quatro `Sentry.init`, e um
 * transporte que captura o envelope no lugar da rede. O que se afirma é sobre o
 * envelope: o que sairia da VPS.
 */
import * as Sentry from "@sentry/nextjs";
import { describe, expect, it } from "vitest";

import { opcoesDePrivacidade } from "./privacidade";
import { sentryScrubHooks } from "./scrub";

// Os literais ficam AQUI, longe das linhas que disparam: o evento carrega o
// código-fonte em volta de cada frame (`context_line`), e um literal escrito na
// linha do `expect` apareceria no envelope como se fosse vazamento.
const TOKEN = "wht_9f3a1c8b2e4d6a0f";
const EMAIL = "joao.titular@exemplo.com";
const CPF = "123.456.789-09";
const TELEFONE = "(11) 98765-4321";
const IP = "203.0.113.77";
const ASSINATURA = "ASSINATURA9";
const COOKIE = "valor-do-cookie-preferencia";
const CORPO = "corpo-da-mensagem-do-paciente";
const URL_WEBHOOK = `https://crm.exemplo.com/api/v1/webhooks/canal-x/${TOKEN}?sig=${ASSINATURA}`;

type Opcoes = Parameters<typeof Sentry.init>[0];

async function envelopeDe(opcoes: Opcoes, disparar: () => void): Promise<string> {
  const enviados: unknown[] = [];
  // O `init` do @sentry/nextjs é no-op se já houver cliente (`sdkAlreadyInitialized`),
  // o que em produção é o certo — um init por processo — e aqui faria todo caso
  // depois do primeiro medir as opções do primeiro. Solta o cliente anterior.
  Sentry.getCurrentScope().setClient(undefined);
  Sentry.init({
    dsn: "https://chave@o0.ingest.sentry.io/0",
    tracesSampleRate: 1,
    transport: () => ({
      send: async (envelope: unknown) => {
        enviados.push(envelope);
        return {};
      },
      flush: async () => true,
    }),
    ...opcoes,
  });
  Sentry.withIsolationScope((escopo) => {
    // O que a instrumentação HTTP do SDK põe no escopo a cada requisição: é
    // daqui que o `requestDataIntegration` monta `request`, `cookies` e o IP.
    escopo.setSDKProcessingMetadata({
      normalizedRequest: {
        url: URL_WEBHOOK,
        method: "POST",
        query_string: `sig=${ASSINATURA}`,
        headers: {
          "x-forwarded-for": IP,
          authorization: `Bearer ${TOKEN}`,
          cookie: `preferencia=${COOKIE}`,
          "content-type": "application/json",
        },
        cookies: { preferencia: COOKIE },
        data: JSON.stringify({ texto: CORPO, email: EMAIL, cpf: CPF }),
      },
      ipAddress: IP,
    });
    disparar();
  });
  await Sentry.close(2000);
  // Sem isto, um transporte nunca chamado deixaria verde todo caso que só
  // afirma ausência — a sonda cega lê igual a "nada vazou".
  expect(enviados.length, "o SDK não entregou envelope nenhum ao transporte").toBeGreaterThan(0);
  return JSON.stringify(enviados);
}

const erroComDadoDoTitular = () => {
  Sentry.captureException(
    new Error(`falha para ${EMAIL}, cpf ${CPF}, tel ${TELEFONE} em ${URL_WEBHOOK}`),
  );
};

const spanDeWebhook = () => {
  Sentry.startSpan(
    {
      name: `POST /api/v1/webhooks/canal-x/${TOKEN}`,
      attributes: {
        // Como a instrumentação HTTP marca a rota não parametrizada. Com `url`, o
        // SDK tira o nome do cabeçalho do envelope (`trace.transaction`), que o
        // `beforeSendSpan` não alcança; ver o NÃO MEDIDO do PR.
        "sentry.segment.name.source": "url",
        "url.full": URL_WEBHOOK,
        "http.request.header.x-canal-api-key": ["segredo-do-canal"],
      },
    },
    () => undefined,
  );
};

describe("o que sai da VPS, medido no envelope do SDK", () => {
  it("controle: sem a nossa configuração, o dado do titular SAI — a sonda enxerga", async () => {
    // Sem este caso, um envelope vazio (transporte que nunca é chamado) deixaria
    // todos os outros verdes pelo motivo errado.
    const envelope = await envelopeDe({}, erroComDadoDoTitular);
    expect(envelope).toContain(EMAIL);
    expect(envelope).toContain(TOKEN);
    expect(envelope).toContain(CORPO);
    expect(envelope).toContain(COOKIE);
    expect(envelope).toContain(IP);
  });

  it("erro com as opções dos quatro inits: nenhum dado do titular nem credencial", async () => {
    const envelope = await envelopeDe(opcoesDePrivacidade, erroComDadoDoTitular);
    expect(envelope).toContain("[EMAIL]"); // o evento saiu, e saiu limpo
    for (const vazamento of [EMAIL, CPF, TELEFONE, TOKEN, ASSINATURA, IP, COOKIE, CORPO]) {
      expect(envelope, `vazou ${vazamento}`).not.toContain(vazamento);
    }
  });

  it("span de webhook com as opções dos quatro inits: nem token nem header-credencial", async () => {
    const envelope = await envelopeDe(opcoesDePrivacidade, spanDeWebhook);
    expect(envelope).toContain("[TOKEN]"); // o span saiu, e saiu limpo
    expect(envelope).not.toContain(TOKEN);
    expect(envelope).not.toContain(ASSINATURA);
    expect(envelope).not.toContain("segredo-do-canal");
  });

  it("controle do span: sem o beforeSendSpan, o token do path sai", async () => {
    const envelope = await envelopeDe({}, spanDeWebhook);
    expect(envelope).toContain(TOKEN);
  });

  // As duas camadas são provadas SEPARADAS: com as duas juntas, apagar uma
  // deixaria o caso de cima verde pela outra.
  it("só a coleta restrita, sem scrub: o SDK não anexa cookie nem IP", async () => {
    const envelope = await envelopeDe(
      { dataCollection: opcoesDePrivacidade.dataCollection },
      erroComDadoDoTitular,
    );
    expect(envelope).toContain(EMAIL); // controle: sem scrub a mensagem sai crua
    expect(envelope).not.toContain(COOKIE);
    expect(envelope).not.toContain(IP);
  });

  it("só o scrub, com a coleta AMPLA do default: corpo, cookie e IP não saem", async () => {
    // Medido: o `requestDataIntegration` anexa o corpo que está no escopo sem
    // olhar `httpBodies`, então o corpo passa da coleta e é o scrub que o apaga.
    const envelope = await envelopeDe(sentryScrubHooks, erroComDadoDoTitular);
    for (const vazamento of [CORPO, COOKIE, IP, EMAIL, TOKEN]) {
      expect(envelope, `vazou ${vazamento}`).not.toContain(vazamento);
    }
  });
});
