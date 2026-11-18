/**
 * O SENTRY DA COMUNIDADE RECEBE ERRO, E SÓ ERRO.
 *
 * ## O que se pagava
 *
 * A política estava escrita em `isCommunityDsn` e não estava em vigor. As duas
 * amostragens foram a zero (`tracesSampleRate`, `replaysSessionSampleRate`) e a
 * terceira torneira ficou fora da conta: `browserSessionIntegration` entra por
 * DEFAULT no `@sentry/browser`, com `lifecycle: "route"` — a cada troca de rota ela
 * fecha uma sessão e abre outra.
 *
 * Medido em 2026-08-10 sobre `dc2f9f96`, um percurso de 7 telas com o DSN da
 * comunidade: 19 requisições ao túnel `/monitoring`, 17 respostas, TODAS `429`, e o
 * corpo de cada envelope era `{"type":"session"}` com `errors: 0`. Nenhum erro,
 * nenhum stack trace — exatamente o dado que a política diz não querer, ocupando a
 * cota de que o stack trace precisa. Depois do conserto, no mesmo percurso: 0.
 *
 * O cabeçalho da recusa era `x-sentry-rate-limits: 60::organization:suspended` —
 * lista de categorias VAZIA, isto é, todas. A organização estava suspensa por cota,
 * então nem o erro real de instalação real entrava, e cada tentativa barrada virava
 * erro de console no browser de quem hospeda.
 *
 * ## Por que o defeito passou
 *
 * `integrations: [x]` SOMA aos defaults do SDK; só `integrations: (defaults) => [...]`
 * os substitui. Quem escreveu o array leu "estas são as integrações" e o SDK leu
 * "estas, MAIS as dez de sempre". A diferença não aparece em nenhum tipo, em nenhum
 * lint, e o efeito ia para a rede — nunca para a tela de quem escreveu.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  INTEGRACAO_DE_SESSAO,
  INTEGRACAO_DE_TRACING,
  integracoesDoCliente,
  isCommunityDsn,
  resolveSentryDsn,
} from "@/lib/sentry/dsn";

const PADRAO_FALSO = [
  { name: "InboundFilters" },
  { name: "Breadcrumbs" },
  { name: INTEGRACAO_DE_SESSAO },
  { name: INTEGRACAO_DE_TRACING },
  { name: "GlobalHandlers" },
] as const;

describe("integracoesDoCliente", () => {
  it("no DSN da comunidade a sessão de release health NÃO vai", () => {
    const saida = integracoesDoCliente(PADRAO_FALSO, true).map((i) => i.name);
    expect(saida).not.toContain(INTEGRACAO_DE_SESSAO);
  });

  /**
   * `BrowserTracing` instrumenta Web Vitals (CLS/LCP/TTFB) via `PerformanceObserver`
   * mesmo com `tracesSampleRate: 0` — a amostragem decide se o trace é ENVIADO, não
   * se o observer é INSTALADO. Achado em produção (2026-09-09): um item `undefined`
   * na lista de entries (uma extensão de navegador mexendo na Performance API da
   * página) derrubava o coletor com `TypeError: Cannot read properties of
   * undefined (reading 'startTime')`, direto no console de quem opera o self-host
   * — sem nenhum trace chegando a existir para explicar o quê. Tirar a integração
   * pra quem está no DSN da comunidade elimina o crash de graça: não havia telemetria
   * nenhuma sendo enviada por ela ali.
   */
  it("no DSN da comunidade o tracing/Web Vitals (fonte do crash de PerformanceObserver) NÃO vai", () => {
    const saida = integracoesDoCliente(PADRAO_FALSO, true).map((i) => i.name);
    expect(saida).not.toContain(INTEGRACAO_DE_TRACING);
  });

  it("no DSN da comunidade o RESTO continua — não é desligar telemetria, é escolher o quê", () => {
    // Sem este caso, uma função que devolve `[]` passaria no de cima e mataria o
    // stack trace junto com a sessão, que é o oposto do desenho.
    const saida = integracoesDoCliente(PADRAO_FALSO, true).map((i) => i.name);
    expect(saida).toEqual(["InboundFilters", "Breadcrumbs", "GlobalHandlers"]);
  });

  it("no Sentry do próprio operador vai TUDO, sessão inclusive", () => {
    // A assimetria é deliberada e é a mesma das amostragens: lá o dado não sai da
    // infraestrutura de quem é dono dele, e release health é legítimo.
    const saida = integracoesDoCliente(PADRAO_FALSO, false).map((i) => i.name);
    expect(saida).toEqual(PADRAO_FALSO.map((i) => i.name));
  });

  it("não muta o array que recebeu — o SDK reusa a lista de defaults", () => {
    const entrada = [...PADRAO_FALSO];
    integracoesDoCliente(entrada, true);
    expect(entrada).toHaveLength(PADRAO_FALSO.length);
  });
});

/**
 * O NOME É UM ACOPLAMENTO COM O SDK, e o modo de falha dele é o silêncio.
 *
 * `integracoesDoCliente` filtra por `name`. Se o Sentry renomear a integração, o
 * filtro deixa de casar, para de filtrar e nada reprova: a suíte segue verde, os
 * quatro casos acima seguem verdes (eles usam um default FALSO, construído com a
 * própria constante), e as sessões voltam a sair sem ninguém notar.
 *
 * Este caso lê o nome no pacote instalado. Se o arquivo não for achado ele reprova
 * pedindo manutenção, em vez de passar vazio — a alternativa era uma sonda que
 * devolve "não achei" e "está tudo bem" com a mesma cara.
 */
describe("o nome da integração casa com o SDK instalado", () => {
  it("o @sentry/browser instalado ainda chama a integração de sessão assim", () => {
    const store = path.join(process.cwd(), "node_modules", ".pnpm");
    const pastas = readdirSync(store).filter((d) => d.startsWith("@sentry+browser@"));
    expect(
      pastas.length,
      "não achei o @sentry/browser no store do pnpm — ENSINE ESTE TESTE",
    ).toBeGreaterThan(0);

    const fonte = pastas
      .map((d) =>
        path.join(
          store,
          d,
          "node_modules/@sentry/browser/build/npm/cjs/prod/integrations/browsersession.js",
        ),
      )
      .map((p) => {
        try {
          return readFileSync(p, "utf8");
        } catch {
          return "";
        }
      })
      .find((c) => c.length > 0);

    expect(
      fonte,
      "não achei o módulo da integração de sessão do @sentry/browser — ENSINE ESTE TESTE",
    ).toBeTruthy();
    expect(fonte).toContain(`name: "${INTEGRACAO_DE_SESSAO}"`);
  });

  it("o @sentry/browser instalado ainda chama a integração de tracing assim", () => {
    const store = path.join(process.cwd(), "node_modules", ".pnpm");
    const pastas = readdirSync(store).filter((d) => d.startsWith("@sentry+browser@"));
    expect(
      pastas.length,
      "não achei o @sentry/browser no store do pnpm — ENSINE ESTE TESTE",
    ).toBeGreaterThan(0);

    const fonte = pastas
      .map((d) =>
        path.join(
          store,
          d,
          "node_modules/@sentry/browser/build/npm/cjs/prod/tracing/browserTracingIntegration.js",
        ),
      )
      .map((p) => {
        try {
          return readFileSync(p, "utf8");
        } catch {
          return "";
        }
      })
      .find((c) => c.length > 0);

    expect(
      fonte,
      "não achei o módulo de tracing do @sentry/browser — ENSINE ESTE TESTE",
    ).toBeTruthy();
    // A constante fica no MESMO arquivo (não é import de outro módulo), então o
    // literal sobrevive ao build — é o mesmo motivo pelo qual checar o arquivo
    // isolado (em vez de rodar o SDK inteiro) já é prova suficiente do nome.
    expect(fonte).toContain(`= "${INTEGRACAO_DE_TRACING}"`);
  });
});

/**
 * O CALL SITE — porque a função pode estar perfeita e o `init` não usá-la.
 *
 * Guarda estática, e a fraqueza é conhecida: mede a FORMA do código, então um
 * refactor que preserve o comportamento e mude o texto reprova aqui. É o mesmo
 * trade-off de `operador-enfileiramento.test.ts`, e vale pelo mesmo motivo — o
 * defeito real que se caça (voltar ao `integrations: [...]`) é invisível a
 * typecheck, a lint e a todo teste que não abra um browser.
 */
describe("o init do cliente honra a política", () => {
  const fonte = readFileSync(path.join(process.cwd(), "instrumentation-client.ts"), "utf8");

  it("passa as integrações como FUNÇÃO, não como array", () => {
    const i = fonte.indexOf("integrations:");
    expect(i, "não achei a chave `integrations` no init — ENSINE ESTE TESTE").toBeGreaterThan(0);

    const trecho = fonte.slice(i, i + 220);
    expect(
      /integrations:\s*\(/.test(trecho),
      "o init voltou a passar `integrations` como ARRAY. Array SOMA aos defaults do " +
        "SDK, então a BrowserSession volta ligada e o Sentry da comunidade recebe " +
        "duas sessões por navegação de cada instalação — que é o defeito medido em " +
        "2026-08-10, com o ingest respondendo 429 a tudo.",
    ).toBe(true);
    expect(trecho).toContain("integracoesDoCliente(");
  });

  it("decide pela mesma pergunta que rege as amostragens", () => {
    // `community` é o que liga a política das três torneiras. Se o call site passar
    // um literal, uma instalação que aponta para o próprio Sentry perde release
    // health sem ter pedido.
    expect(fonte).toContain("integracoesDoCliente(padraoDoSdk, community)");
    expect(fonte).toContain("isCommunityDsn(sentryDsn)");
  });
});

/**
 * A SUÍTE NÃO FALA COM O SENTRY DE PRODUÇÃO.
 *
 * Mesma família do e2e que escrevia no banco de produção: o default é a coisa
 * mais perigosa quando o default é "manda para o nosso servidor de verdade".
 * `resolveSentryDsn("")` cai no DSN da comunidade — então a AUSÊNCIA da chave no
 * ambiente da suíte é o que mandava dado de teste para lá.
 */
describe("o ambiente da suíte desliga a telemetria", () => {
  it("o gerador do .env.e2e escreve SENTRY_DSN=off", () => {
    const gerador = readFileSync(
      path.join(process.cwd(), "scripts/gerar-env-e2e.sh"),
      "utf8",
    );
    expect(
      /^SENTRY_DSN=off$/m.test(gerador),
      "o ambiente da suíte voltou a ficar sem SENTRY_DSN. Sem a chave, " +
        "`resolveSentryDsn` cai no DSN da comunidade e a suíte passa a MANDAR DADO " +
        "para o Sentry de produção do projeto — e a cor do CI volta a depender do " +
        "estado de cobrança de um terceiro.",
    ).toBe(true);
  });

  it("e `off` de fato desliga — a guarda acima não vale nada se o valor não desligasse", () => {
    expect(resolveSentryDsn("off")).toBeUndefined();
    // Controle: o vazio NÃO desliga, e é por isso que a linha acima é obrigatória.
    expect(isCommunityDsn(resolveSentryDsn(""))).toBe(true);
  });
});
