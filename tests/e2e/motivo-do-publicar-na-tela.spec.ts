/**
 * O MOTIVO DO "PUBLICAR" DESABILITADO ESTÁ ESCRITO NA TELA — sem hover (#951).
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * No editor do agente, quando "Publicar" está desabilitado, o motivo existia só
 * no `title` de um span: aparecia com o ponteiro parado em cima. Em tela de
 * toque não existe hover, e um botão desabilitado nem entra na ordem do Tab —
 * quem mais precisa da explicação (celular, teclado, leitor de tela) era
 * exatamente quem não a recebia.
 *
 * ─── O que este arquivo mede, e por que passa por `innerText` ───────────────
 *
 * ⚠️ NENHUM HOVER ACONTECE NESTE ARQUIVO. É a ausência dele que prova o
 * conserto: as asserções só olham o que a tela mostra parada. `getByTestId` e
 * `innerText` não enxergam atributo nenhum — se o motivo voltar a morar só no
 * `title`, não há nó de texto para achar e o caso fica VERMELHO.
 *
 * A régua de QUAL motivo bloqueia é `lib/ai/agents/bloqueio-de-publicacao.ts`
 * (com teste puro próprio). Aqui só se prova que a frase chega à tela e que o
 * botão aponta para ela — a lista de motivos possíveis aceita qualquer um dos
 * oito, porque qual deles vale depende do ambiente do job (chave de instalação
 * presente ou não), e fixar um só faria o teste mentir sobre o ambiente.
 *
 * Locale pt-BR fixado no arquivo, como as specs vizinhas: sem isso o navegador
 * de teste roda en-US e o que se lê na tela não é o português do produto.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "./helpers/test";

import { loginComoAdmin, lerCreds, type CredsE2E } from "./helpers/login-admin";

const EVIDENCIA = path.join(process.cwd(), "evidence", "motivo-do-publicar-951");

/** Os oito motivos de `bloqueioDePublicacao`, como a tela escreve cada um. */
const MOTIVOS_DE_BLOQUEIO =
  /sem rascunho para publicar|resolva os erros do formulário|salve o rascunho antes de publicar|esta instalação não tem chave de|escolha a chave de acesso|credencial \w+|escolha por qual número de whatsapp|número whatsapp não está conectado/i;

let creds: CredsE2E = lerCreds();

test.use({ locale: "pt-BR" });

// 240s, como a vizinha `agente-novo-e-uso`: o orçamento inclui UMA re-semeadura
// de credenciais, que o login dispara sozinho quando outra sessão rotaciona o
// fator TOTP deste banco compartilhado.
test.describe.configure({ timeout: 240_000 });

test.beforeEach(async ({ page }) => {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  creds = await loginComoAdmin(page, creds);
});

/**
 * Cria um agente BLOQUEADO para publicar, pela API — a precondição é semeada
 * aqui, não pressuposta de outra spec nem do seed.
 *
 * Sem chave escolhida e sem número, o botão nasce desabilitado em qualquer
 * ambiente: `credential_id: null` é "usar a chave da instalação" (pode estar no
 * `.env` do job, pode não estar) e `channel_session_id: null` é rascunho
 * legítimo — a publicação é que não passa sem número.
 */
async function criarAgenteBloqueado(page: Page): Promise<string> {
  const criado = await page.request.post("/api/v1/ai/agents", {
    data: {
      name: `E2E Motivo do Publicar ${Date.now()}`,
      version: {
        system_prompt: "Você é um atendente de teste E2E. Responda de forma clara, em pt-BR.",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        credential_id: null,
        channel_session_id: null,
      },
    },
  });
  expect(criado.status(), "a fixture do teste não foi criada").toBe(201);
  const { data } = (await criado.json()) as { data: { agent: { id: string } } };
  return data.agent.id;
}

test.describe("O motivo do Publicar bloqueado aparece na tela", () => {
  test("sem passar o mouse, o motivo está escrito ao lado do botão", async ({ page }) => {
    const agentId = await criarAgenteBloqueado(page);

    try {
      await page.goto(`/app/ai/agents/${agentId}`);
      await expect(page.getByRole("heading", { name: /E2E Motivo do Publicar/ })).toBeVisible();

      // O diálogo de confirmação tem um botão com o mesmo rótulo ("Publicar vN"),
      // mas ele só existe aberto — e o botão desabilitado nem abre. O `.first()`
      // é o do cabeçalho, na ordem do documento.
      const publicar = page.getByRole("button", { name: /^Publicar/ }).first();
      await expect(
        publicar,
        "a fixture deveria deixar o Publicar bloqueado — sem bloqueio não há motivo para medir",
      ).toBeDisabled();

      // ⚠️ A PROVA: o motivo como TEXTO da tela, com o ponteiro parado (nenhum
      // hover neste arquivo). Com o motivo de volta no `title`, não existe
      // elemento aqui e o caso fica vermelho.
      const motivo = page.getByTestId("motivo-do-publicar");
      await expect(motivo).toBeVisible();
      const texto = (await motivo.innerText()).trim();
      expect(texto, "o motivo na tela não é nenhum dos motivos de bloqueio").toMatch(
        MOTIVOS_DE_BLOQUEIO,
      );

      // Não basta existir num canto qualquer: tem de estar no TEXTO da tela.
      // `innerText` não lê atributo — é o que separa "escrito para quem olha" de
      // "escrito no `title` para quem passa o mouse".
      const textoDaTela = await page.locator("body").innerText();
      expect(textoDaTela, "o motivo não está no texto da tela").toContain(texto);

      // E o botão aponta para o motivo: quem chega pelo leitor de tela ouve a
      // explicação junto do rótulo. Botão desabilitado não recebe foco do Tab,
      // então o vínculo é por `aria-describedby`, não por foco.
      await expect(publicar).toHaveAttribute("aria-describedby", "motivo-do-publicar");
      await expect(page.locator("#motivo-do-publicar")).toHaveText(texto);

      await page.screenshot({
        path: path.join(EVIDENCIA, "01-motivo-visivel-sem-hover.png"),
        fullPage: true,
      });
    } finally {
      // O agente é da organização de teste e fica arquivado, não publicado.
      await page.request.delete(`/api/v1/ai/agents/${agentId}`);
    }
  });
});
