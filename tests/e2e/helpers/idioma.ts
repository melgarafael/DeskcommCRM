import { expect, type Page } from "@playwright/test";

/**
 * Troca o idioma da pessoa logada pelo seletor do topo, como ela faria.
 *
 * Por que pela tela, e não `auth.admin.updateUserById` no banco: o `getUser`
 * mora no cache curto da autorização (#3696). Quem troca pelo produto passa por
 * `trocarIdioma`, que invalida o cache na hora; quem grava direto no banco com a
 * sessão aberta espera até 30 s, e a recarga seguinte ainda vinha no idioma velho.
 *
 * O seletor pinta o idioma novo antes do servidor responder e depois recarrega a
 * página inteira. Esperar o texto do botão mudar é esperar a pintura otimista;
 * o carimbo no `window` some só com a recarga — é ela que se espera aqui.
 */
export async function trocarIdiomaPelaTela(page: Page, codigo: "pt-BR" | "es"): Promise<void> {
  const curto = codigo === "es" ? "ES" : "PT";
  const botao = page.getByTestId("seletor-de-idioma");
  if ((await botao.innerText()).trim() === curto) return;
  await page.evaluate(() => {
    (window as unknown as { __antesDaTroca?: boolean }).__antesDaTroca = true;
  });
  await botao.click();
  await page.getByTestId(`idioma-${codigo}`).click();
  await page.waitForFunction(
    () => !(window as unknown as { __antesDaTroca?: boolean }).__antesDaTroca,
    undefined,
    { timeout: 60_000 },
  );
  await page.waitForLoadState("networkidle", { timeout: 60_000 });
  await expect(botao).toHaveText(curto);
}
