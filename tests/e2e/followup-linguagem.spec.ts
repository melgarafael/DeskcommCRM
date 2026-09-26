/**
 * W2-LINGUAGEM — a tela do construtor de follow-up não fala mais em código.
 *
 * A afirmação é dura de propósito: percorrendo o painel de configuração de
 * TODOS os tipos de nó, **nenhum valor de wire aparece no texto renderizado** e
 * **nenhum campo de texto contém um UUID**.
 *
 * A lista do que é proibido NÃO está escrita aqui. Ela é derivada do schema em
 * `tests/support/enums-do-grafo.ts` — a mesma derivação que o invariante de
 * tradução usa. Uma lista escrita à mão envelheceria calada: o `branching` do
 * contrato v2 entrou sem ninguém notar exatamente assim, e foi o que motivou a
 * derivação.
 *
 * Protocolo desta missão (`fv-briefings/PROTOCOLO-E2E.md`): NÃO rodar o seed
 * (ele rotaciona o TOTP do admin e derruba o run alheio), copiar as credenciais
 * do maestro, porta 3105, e 60s de prazo porque a máquina roda saturada.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Locator, type Page } from "./helpers/test";

import { VALORES_DE_WIRE_NA_TELA_PROIBIDOS } from "../support/enums-do-grafo";

const PRAZO_SOB_CARGA = 60_000;
const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence", "followup-vivo");
fs.mkdirSync(EVIDENCIA, { recursive: true });

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
}

function creds(): Creds {
  if (!fs.existsSync(CREDS_PATH)) {
    throw new Error(
      "Falta .e2e-creds.json. NÃO rode o seed (rotaciona o TOTP do admin e derruba o run de outra frente).\n" +
        "Copie o do maestro: cp /Users/rafaelmelgaco/fv-integra/.e2e-creds.json .",
    );
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//, { timeout: PRAZO_SOB_CARGA });
}

/**
 * Palavra inteira e sem acento-surpresa. Sem a fronteira, `eq` casaria dentro
 * de "Esqueça" e o teste viraria um gerador de vermelho falso — que é como se
 * desliga um gate.
 */
function apareceComoPalavra(texto: string, valor: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${valor}([^\\p{L}\\p{N}_]|$)`, "iu").test(texto);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Tudo que o painel mostra: texto visível + o que está escrito dentro dos campos. */
async function oQuePainelMostra(painel: Locator): Promise<{ texto: string; valoresDeCampo: string[] }> {
  const texto = (await painel.innerText()).trim();
  const valoresDeCampo = await painel.locator("input[type='text'], input:not([type]), textarea").evaluateAll(
    (campos) => campos.map((c) => (c as HTMLInputElement | HTMLTextAreaElement).value),
  );
  return { texto, valoresDeCampo };
}

test.describe("construtor de follow-up — a tela não fala em código (W2-LINGUAGEM)", () => {
  test.use({ viewport: { width: 1600, height: 900 } });
  /**
   * O teto do teste precisa caber as esperas de 60s do protocolo, senão elas
   * são decorativas: medido, a 1ª tentativa morreu em `Test timeout of
   * 30000ms` (o default do `playwright.config.ts`) com o POST de criação AINDA
   * EM VOO — botão em "Criando…", desabilitado. Não era o app travando, era o
   * teste desistindo antes: só o login leva ~15s nesta máquina.
   */
  test.describe.configure({ timeout: 240_000 });

  test("nenhum valor de wire e nenhum UUID aparecem no painel de nenhum tipo de nó", async ({ page }) => {
    const c = creds();

    // Guarda de vacuidade: uma derivação quebrada devolveria lista vazia, e aí
    // "não achei nada proibido" seria verdade sem ter olhado para nada.
    expect(
      VALORES_DE_WIRE_NA_TELA_PROIBIDOS.length,
      "a derivação do schema devolveu lista vazia — instrumento quebrado",
    ).toBeGreaterThan(8);
    expect(VALORES_DE_WIRE_NA_TELA_PROIBIDOS).toContain("lead_stage");
    expect(VALORES_DE_WIRE_NA_TELA_PROIBIDOS).toContain("eq");

    await login(page, c.users.manager!.email, c.password);

    // ⚠️ UM MODELO DE MENSAGEM ANTES DE TUDO, e isso conserta um teste que
    // media o ambiente. Sem NENHUM modelo na conta, `SeletorDeModelo` renderiza
    // uma frase honesta ("Você ainda não tem modelos…") em vez do `<Select>` —
    // e aí `#action-fallback` não existe. Localmente passava porque o banco
    // tinha modelos deixados por outra spec; no CI, banco fresco, caía. Passar
    // onde o dado por acaso existe é o mesmo defeito que já tirou
    // `prova-painel-provedores` do CI uma vez.
    //
    // Criado ANTES de abrir o construtor de propósito: fazê-lo depois exigiria
    // um `reload`, e o custo dele estourou o teto de 240s desta spec, que já
    // abre seis painéis e tira seis capturas.
    const criaModelo = await page.request.post("/api/v1/message-templates", {
      data: { title: `E2E Linguagem ${Date.now()}`, body: "Oi {{nome}}, tudo bem?" },
    });
    expect(criaModelo.status(), "o seletor de modelo só existe se houver ao menos um").toBe(201);

    await page.goto("/app/ai/followups");
    const nomeDoFluxo = `E2E Linguagem ${Date.now()}`;
    await page.getByRole("button", { name: "Novo fluxo" }).click();
    const dialogo = page.getByRole("dialog");
    const campoNome = dialogo.getByLabel("Nome");
    // O Radix anima a abertura; um fill() antes do foco é engolido.
    await expect(campoNome).toBeFocused({ timeout: PRAZO_SOB_CARGA });
    await campoNome.fill(nomeDoFluxo);
    await expect(campoNome).toHaveValue(nomeDoFluxo);
    await dialogo.getByRole("button", { name: "Criar fluxo" }).click();
    await expect(dialogo).not.toBeVisible({ timeout: PRAZO_SOB_CARGA });

    await page.locator("li", { hasText: nomeDoFluxo }).getByRole("link").click();
    await page.waitForURL(/\/app\/ai\/followups\/[0-9a-f-]+$/);
    const flowId = page.url().split("/").pop()!;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: PRAZO_SOB_CARGA });

    try {
      const tipos = ["trigger", "wait", "condition", "ai_classify", "action", "end"] as const;
      for (const tipo of tipos) await page.getByTestId(`palette-add-${tipo}`).click();

      const vazamentos: string[] = [];
      for (const tipo of tipos) {
        await page.locator(`.react-flow__node[data-id^="${tipo}-"]`).first().click();
        const painel = page.getByTestId("node-config-panel");
        await expect(painel).toBeVisible({ timeout: PRAZO_SOB_CARGA });

        const { texto, valoresDeCampo } = await oQuePainelMostra(painel);
        for (const valor of VALORES_DE_WIRE_NA_TELA_PROIBIDOS) {
          if (apareceComoPalavra(texto, valor)) vazamentos.push(`${tipo}: mostra o valor de wire "${valor}"`);
        }
        for (const escrito of valoresDeCampo) {
          if (UUID.test(escrito)) vazamentos.push(`${tipo}: campo de texto com UUID (${escrito})`);
        }

        await page.screenshot({ path: path.join(EVIDENCIA, `linguagem-painel-${tipo}.png`), fullPage: true });
      }

      expect(vazamentos, "o painel ainda fala em código").toEqual([]);

      // O nó de ação é onde estavam os dois campos de UUID: prova positiva de
      // que o lugar deles virou seletor, e não simplesmente sumiu da tela.
      await page.locator('.react-flow__node[data-id^="action-"]').first().click();
      const painelDaAcao = page.getByTestId("node-config-panel");
      await expect(painelDaAcao.locator("#action-fallback")).toBeVisible({ timeout: PRAZO_SOB_CARGA });
      await expect(painelDaAcao.locator("input#action-fallback")).toHaveCount(0);
    } finally {
      await page.request.post(`/api/v1/ai/followup-flows/${flowId}/disable`, { data: {} });
    }
  });
});
