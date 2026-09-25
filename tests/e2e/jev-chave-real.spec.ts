/**
 * O JEV DE VERDADE — a mesma jornada de `jev-decisoes-rapidas`, contra a API da
 * TypeSafe AI, com uma chave paga.
 *
 * O dublê prova que o produto fala o contrato que MEDIMOS em 2026-09-23. Esta
 * spec prova que o contrato ainda é esse: que a chave passa no teste do
 * `GET /v1/models`, que a versão fixada (`jev-1.13.0`) ainda responde e que a
 * medição volta legível. Fica FORA DO CI porque exige chave paga, e segredo de
 * repositório público não é lugar para ela (o motivo também está no bloco
 * FORA_DO_CI do `.github/workflows/e2e.yml`). Sem `JEV_API_KEY`, ela PULA —
 * o placar diz "skipped", nunca "passed".
 *
 * A chave vai pela API da tela (a mesma rota que o diálogo "Colar a chave"
 * chama), não pelo campo: o passo `fill` do Playwright guarda o texto digitado
 * no título do passo e no trace, e o relatório de uma falha levaria a chave
 * junto. Pelo mesmo motivo o trace desta spec é desligado. O colar pela tela é
 * provado pela spec do dublê.
 *
 * Como rodar (o servidor sob teste lê JEV_API_BASE_URL do `.env.e2e`, que
 * vence o ambiente do shell — `playwright.config.ts`):
 *
 *   1. no `.env.e2e`, deixe `JEV_API_BASE_URL=` vazio (vazio = api.typesafe.ai);
 *   2. JEV_API_KEY=apikey_... pnpm exec playwright test tests/e2e/jev-chave-real.spec.ts
 *   3. rode `pnpm e2e:env` depois, para a suíte voltar a usar o dublê.
 */
import * as fs from "node:fs";

import { expect, test } from "@playwright/test";

import {
  credsDoJev,
  drenar,
  escoarAFila,
  esperarEstado,
  esperarMedicaoEmExecucoes,
  ligarOJev,
  limparOJev,
  mandarMensagemDoCliente,
  mensagensMedidas,
} from "./helpers/jev";
import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

const CHAVE = process.env.JEV_API_KEY ?? "";

test.use({ trace: "off" });

/** O JEV_API_BASE_URL que o SERVIDOR recebe — o do arquivo, não o do shell. */
function baseDoServidor(): string {
  const linha = fs
    .readFileSync(".env.e2e", "utf8")
    .split("\n")
    .find((l) => l.startsWith("JEV_API_BASE_URL="));
  return (linha ?? "JEV_API_BASE_URL=").slice("JEV_API_BASE_URL=".length).trim();
}

let orgId = "";

/**
 * Vazio = o default do produto (a API real). Qualquer outro valor só vale se a
 * ORIGEM for exatamente a da TypeSafe: comparar prefixo de texto aceitaria
 * `https://api.typesafe.ai.outro-host.com`, e um verde ali provaria outro servidor.
 */
function apontaParaAApiReal(base: string): boolean {
  if (base === "") return true;
  try {
    return new URL(base).origin === "https://api.typesafe.ai";
  } catch {
    return false;
  }
}

test.describe("Jev — contra a API de verdade", () => {
  test.describe.configure({ timeout: 240_000 });

  test.skip(CHAVE === "", "exige JEV_API_KEY (chave paga da TypeSafe AI) no ambiente");

  test.beforeAll(() => {
    const base = baseDoServidor();
    // Falha alto em vez de pular: com a chave em mãos e o servidor apontado
    // para o dublê, um verde provaria o dublê, não a API.
    expect(
      apontaParaAApiReal(base),
      `o servidor sob teste aponta o Jev para ${base}. Deixe JEV_API_BASE_URL= vazio no .env.e2e ` +
        "e suba o servidor de novo (o cabeçalho desta spec tem a receita).",
    ).toBe(true);
  });

  test.afterAll(async () => {
    if (orgId) await limparOJev(orgId);
  });

  test("a chave real passa no teste, e a primeira mensagem é medida pela TypeSafe AI", async ({ page }) => {
    await loginComoAdmin(page, lerCreds());
    orgId = credsDoJev().orgId;
    await limparOJev(orgId);

    const criada = await page.request.post("/api/v1/ai/credentials", {
      data: { provider: "typesafe", label: "Jev E2E (chave real)", api_key: CHAVE },
    });
    expect(criada.ok(), `cadastrar a chave respondeu ${criada.status()}`).toBe(true);
    await esperarEstado(page, ["pronto"], 45_000);

    // O que outra spec deixou na fila seria medido junto com a nossa mensagem.
    await escoarAFila(page);
    await ligarOJev(page);
    const antes = await mensagensMedidas(page);

    // Mensagem calma de propósito: uma irritada abriria a passagem para humano,
    // e o aviso ao cliente sairia pelo WAHA de mentira do ambiente de teste.
    await mandarMensagemDoCliente(
      page,
      "Obrigado pela ajuda de ontem, o pedido chegou certinho.",
      String(Date.now()).slice(-6),
    );
    // `>=`, pelo mesmo motivo da spec do dublê: um evento que voltou à fila
    // depois do escoamento também é medido, e isso não é defeito do cartão.
    await expect(async () => {
      await drenar(page);
      expect(await mensagensMedidas(page)).toBeGreaterThanOrEqual(antes + 1);
    }).toPass({ timeout: 120_000, intervals: [3_000, 5_000] });

    await esperarMedicaoEmExecucoes(page, /typesafe\/jev-\d/);
  });
});
