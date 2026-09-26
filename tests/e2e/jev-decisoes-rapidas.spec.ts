/**
 * O JEV, DA CHAVE À PRIMEIRA DECISÃO — pela tela, contra um dublê HTTP real.
 *
 * A jornada do admin que nunca ouviu falar do Jev: acha-o pela busca e pelo
 * menu, cola a chave pelo cartão, vê o teste passar, concorda com o envio aos
 * EUA, liga — e uma mensagem de cliente que chega pelo webhook do WhatsApp é
 * medida por ele. A prova de que o Jev foi chamado não é a tela: é o dublê
 * (`scripts/duble-jev-e2e.mjs`), que grava cada chamada num arquivo que esta
 * spec lê. A tela prova o resto — a linha em Execuções e o número no cartão.
 *
 * E o que o dublê recebeu prova a LGPD (D6): só a última mensagem, com
 * telefone e e-mail já apagados.
 *
 * Catracas no caminho: o Jev NÃO aparece no "Modelo padrão", no seletor do
 * ponto nem no seletor de IA do agente — ele não escreve texto, e escolhido ali
 * todo atendimento morreria. O "Qual você contratou" do onboarding não entra:
 * ele só aparece em organização sem chave nenhuma, e a desta parte tem a do
 * seed; a derivação dele de `PROVEDORES` é vigiada em
 * `tests/unit/provedores-de-decisao-catraca.test.ts`.
 *
 * Precondições: `pnpm e2e:env` (grava JEV_API_BASE_URL apontando para a porta
 * do dublê, que esta spec sobe e derruba sozinha) e o app buildado.
 *
 *   pnpm e2e:build && pnpm exec playwright test tests/e2e/jev-decisoes-rapidas.spec.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { expect, test, type Page } from "./helpers/test";

import {
  abrirOCartao,
  credsDoJev,
  drenar,
  clicarEEsperarAMudanca,
  escoarAFila,
  esperarMedicaoEmExecucoes,
  esperarNoCartao,
  ligarOJev,
  limparOJev,
  mandarMensagemDoCliente,
  mensagensMedidas,
} from "./helpers/jev";
import { lerCreds, loginComoAdmin, type CredsE2E } from "./helpers/login-admin";

const BASE_DO_JEV = process.env.JEV_API_BASE_URL ?? "";
/** A chave que o dublê aceita. Não é segredo: só vale para ele. */
const CHAVE_DO_DUBLE = "apikey_e2e_duble_do_jev_0123456789abcdef";
const ARQUIVO_DE_CHAMADAS = path.join(os.tmpdir(), `duble-jev-e2e-${process.pid}.json`);
const sufixo = String(Date.now()).slice(-6);
/** A frase que identifica a NOSSA mensagem no que o dublê recebeu. */
const FRASE_DO_CLIENTE = `Adorei o atendimento ${sufixo}`;
/** A da mensagem que chega com o Jev desligado — do MESMO cliente, na mesma conversa. */
const FRASE_DE_ANTES = `Vocês abrem no sábado ${sufixo}`;

interface Chamada {
  metodo: string;
  caminho: string;
  autorizado: boolean;
  corpo: { model?: string; state?: unknown; questions?: Record<string, { type?: string }> } | null;
}

let duble: ChildProcess | null = null;
let creds: CredsE2E;
let orgId = "";

function chamadasAoJev(): Chamada[] {
  if (!fs.existsSync(ARQUIVO_DE_CHAMADAS)) return [];
  return (JSON.parse(fs.readFileSync(ARQUIVO_DE_CHAMADAS, "utf8")) as Chamada[]).filter(
    (c) => c.metodo === "POST" && c.caminho === "/v1/systemone",
  );
}

/** A pergunta do clima sobre a NOSSA mensagem — a fila pode ter trazido outras da organização. */
function chamadaDaNossaMensagem(): Chamada | undefined {
  return chamadasAoJev().find((c) => String(c.corpo?.state ?? "").includes(FRASE_DO_CLIENTE));
}

/** Nenhuma opção do seletor aberto é o Jev — e o seletor tem opções (controle positivo). */
async function seletorSemOJev(page: Page): Promise<void> {
  const opcoes = page.getByRole("option");
  await expect(opcoes.first()).toBeVisible();
  await expect(page.getByRole("option", { name: /Anthropic/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Jev|TypeSafe/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
}

test.describe("Jev — decisões rápidas, pela tela", () => {
  // Uma jornada só, numa sessão só: o login com MFA custa uma janela de TOTP.
  test.describe.configure({ timeout: 240_000 });

  test.beforeAll(async () => {
    let alvo: URL;
    try {
      alvo = new URL(BASE_DO_JEV);
    } catch {
      throw new Error(
        "JEV_API_BASE_URL ausente no ambiente do teste. Rode `pnpm e2e:env` — sem ela o servidor " +
          "sob teste falaria com a TypeSafe AI de verdade, e esta spec mediria o vazio.",
      );
    }
    expect(alvo.hostname, "o Jev da suíte tem de apontar para o dublê local").toBe("127.0.0.1");

    fs.rmSync(ARQUIVO_DE_CHAMADAS, { force: true });
    duble = spawn(process.execPath, ["scripts/duble-jev-e2e.mjs"], {
      env: {
        ...process.env,
        DUBLE_JEV_PORTA: alvo.port,
        DUBLE_JEV_HOST: alvo.hostname,
        DUBLE_JEV_CHAVE: CHAVE_DO_DUBLE,
        DUBLE_JEV_ARQUIVO: ARQUIVO_DE_CHAMADAS,
      },
      stdio: "inherit",
    });
    // O dublê que responde tem de ser ESTE: um que sobrou de outra rodada na
    // mesma porta gravaria noutro arquivo, e a spec leria o vazio.
    await expect
      .poll(
        async () => {
          try {
            const r = await fetch(`${BASE_DO_JEV}/__duble/saude`);
            return ((await r.json()) as { arquivo?: string }).arquivo ?? null;
          } catch {
            return null;
          }
        },
        { timeout: 15_000, message: "o dublê do Jev não subiu (porta ocupada?)" },
      )
      .toBe(ARQUIVO_DE_CHAMADAS);

    creds = lerCreds();
  });

  test.afterAll(async () => {
    duble?.kill("SIGTERM");
    fs.rmSync(ARQUIVO_DE_CHAMADAS, { force: true });
    if (orgId) await limparOJev(orgId);
  });

  test("[P1] o admin acha o Jev, liga, e a primeira mensagem é medida por ele", async ({ page }) => {
    creds = await loginComoAdmin(page, creds);
    orgId = credsDoJev().orgId;
    await limparOJev(orgId);

    await test.step("acha o Jev pela busca, e Provedores pelo menu", async () => {
      // Ninguém procura "Provedores" quando ouviu falar do Jev.
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByRole("combobox").fill("jev");
      await page.getByRole("option", { name: /Provedores/ }).click();
      await page.waitForURL(/\/app\/ai\/providers/);
      await expect(page.getByTestId("cartao-do-jev")).toBeVisible({ timeout: 30_000 });

      await page.goto("/app/ai");
      await page.getByRole("link", { name: /Provedores/ }).first().click();
      await page.waitForURL(/\/app\/ai\/providers/);
    });

    await test.step("sem chave: cola a do Jev pelo próprio cartão, e o teste passa", async () => {
      const cartao = await abrirOCartao(page);
      await expect(cartao).toHaveAttribute("data-estado", "sem_chave");
      await expect(cartao.getByRole("link", { name: "Pegar a chave na TypeSafe" })).toHaveAttribute(
        "href",
        /console\.typesafe\.ai/,
      );
      await cartao.getByRole("button", { name: "Colar a chave" }).click();
      // O diálogo abre JÁ no Jev: o formato da chave é o dele.
      await expect(page.locator("#cred-key")).toHaveAttribute("placeholder", "apikey_…");
      // Só a chave, como o leigo faz: o nome é opcional e vira o do provedor.
      await page.locator("#cred-key").fill(CHAVE_DO_DUBLE);
      const [criou] = await Promise.all([
        page.waitForResponse(
          (r) => r.url().endsWith("/api/v1/ai/credentials") && r.request().method() === "POST",
        ),
        page.getByRole("button", { name: /salvar e validar/i }).click(),
      ]);
      expect(criou.status(), "a chave não foi cadastrada").toBe(201);
      await expect(page.getByRole("dialog")).toBeHidden();
      // Sem recarregar: o cartão se relê sozinho depois do teste da chave.
      await esperarNoCartao(page, ["pronto"]);
      // E diz que a chave FUNCIONA, não só que foi guardada.
      await expect(cartao.getByTestId("jev-chave-conferida")).toBeVisible();
      // O teste da chave foi ao dublê, com a chave certa.
      const doTeste = JSON.parse(fs.readFileSync(ARQUIVO_DE_CHAMADAS, "utf8")) as Chamada[];
      expect(doTeste.some((c) => c.caminho === "/v1/models" && c.autorizado)).toBe(true);
    });

    await test.step("com a chave validada e o Jev desligado, uma mensagem chega e nada sai (D6)", async () => {
      await mandarMensagemDoCliente(page, `Bom dia! ${FRASE_DE_ANTES}?`, sufixo, 1);
      // Quem chama o Jev é o worker de clima, e ele só roda no dreno: sem esta
      // linha a lista vazia abaixo não diria nada. O escoamento também tira da
      // fila o que as specs anteriores da parte deixaram, antes de ligar.
      await escoarAFila(page);
      // Controle positivo: a mensagem da etapa seguinte é do mesmo cliente, na
      // mesma conversa, e o Jev a mede — o que muda entre as duas é o interruptor.
      expect(chamadasAoJev(), "o Jev foi chamado antes de alguém ligá-lo").toEqual([]);
    });

    const antes = await test.step("liga, com o aceite de envio aos EUA", async () => {
      await ligarOJev(page);
      return mensagensMedidas(page);
    });

    await test.step("a mensagem do cliente chega pelo WhatsApp e o Jev a mede", async () => {
      await mandarMensagemDoCliente(
        page,
        `Oi! Meu telefone é (11) 98765-4321 e o e-mail cliente.jev@exemplo.com.br. ${FRASE_DO_CLIENTE}!`,
        sufixo,
        2,
      );
      await expect(async () => {
        await drenar(page);
        expect(chamadaDaNossaMensagem(), "o dublê ainda não recebeu a pergunta do clima").toBeDefined();
      }).toPass({ timeout: 90_000, intervals: [2_000, 3_000, 5_000] });

      const chamada = chamadaDaNossaMensagem()!;
      expect(chamada.autorizado, "o servidor não mandou a chave que o admin colou").toBe(true);
      expect(chamada.corpo?.model).toBe("jev-1.13.0");
      expect(chamada.corpo?.questions?.["clima"]?.type).toBe("score");
      // LGPD: só a última mensagem, e sem telefone nem e-mail. A conversa já
      // tem a mensagem de antes de ligar — mandar o histórico a levaria junto.
      const estado = String(chamada.corpo?.state ?? "");
      expect(estado.startsWith("Oi! Meu telefone é"), "o estado não é a mensagem, ou é mais que ela").toBe(true);
      expect(estado, "o Jev recebeu o histórico da conversa, não só a última mensagem").not.toContain(
        FRASE_DE_ANTES,
      );
      expect(estado).toContain("[PHONE]");
      expect(estado).toContain("[EMAIL]");
      expect(estado).not.toContain("98765-4321");
      expect(estado).not.toContain("cliente.jev@");
    });

    await test.step("Execuções mostra a medição com o nome do Jev", async () => {
      await esperarMedicaoEmExecucoes(page, /typesafe\/jev-1\.13\.0/);
      await page.screenshot({ path: ".superpowers/evidence/jev/execucoes-so-o-jev.png", fullPage: true });
    });

    await test.step("o cartão conta a mensagem medida", async () => {
      // `>=`, não `===`: um evento de outra spec que voltou à fila depois do
      // escoamento também seria medido, e isso não é defeito do cartão.
      await expect(async () => {
        expect(await mensagensMedidas(page)).toBeGreaterThanOrEqual(antes + 1);
      }).toPass({ timeout: 30_000, intervals: [1_000, 2_000, 3_000] });
      await page.screenshot({ path: ".superpowers/evidence/jev/cartao-decidindo.png", fullPage: true });
    });

    await test.step("catracas: o Jev não é escolhível como IA que conversa", async () => {
      await abrirOCartao(page);
      await page.getByTestId("padrao-provider").click();
      await seletorSemOJev(page);

      await page.click('[data-testid="avancado-entender"]');
      await expect(page.getByTestId("jev-no-ponto-sentiment_classify")).toContainText(/O Jev mede/);
      await page.getByTestId("provider-sentiment_classify").click();
      await seletorSemOJev(page);

      await page.goto("/app/ai/agents/new");
      await page.locator("#provider").click();
      await seletorSemOJev(page);
    });

    await test.step("desligar volta ao estado de antes, e o aceite fica registrado", async () => {
      const cartao = await abrirOCartao(page);
      await clicarEEsperarAMudanca(page, cartao.getByRole("button", { name: "Desligar" }));
      await esperarNoCartao(page, ["pronto"]);
      // Relida do servidor: o aceite ficou gravado, não só na memória da tela.
      const pronto = await abrirOCartao(page);
      await expect(pronto).toHaveAttribute("data-estado", "pronto");
      // Religar não pergunta de novo: o aceite é da empresa (D6).
      await expect(pronto.locator("#jev-aceite")).toHaveCount(0);
      await expect(pronto).toContainText("Envio aceito pela empresa em");
    });
  });
});
