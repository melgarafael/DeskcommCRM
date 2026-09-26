/**
 * A PRESENÇA DO ATENDENTE, PELA TELA — e a guarda do emissor (#996, PR #1066).
 *
 * ─── Por que esta spec existe, e por que ela não é opcional ───────────────
 *
 * O emissor do sinal é um hook montado no `AppShell`: com a aba aberta, ele
 * bate em `POST /api/v1/attendants/presence` a cada 60 s. **Nenhum teste
 * unitário alcança esse ponto de montagem.** Medido na triagem: remover
 * `useSinalDePresenca(...)` do `AppShell` deixa a suíte unitária inteira verde —
 * a rota continua testada, o hook continua testado, e o produto para de emitir
 * sinal sem nada reprovar. Quem prende o ponto de montagem é esta spec.
 *
 * Por isso a asserção central não é "a tela mostra presente": é **a batida
 * acontecer**, observada na fronteira da rede, com a aba aberta e sem ninguém
 * clicar em nada.
 *
 * ─── O que ela NÃO faz, de propósito ─────────────────────────────────────
 *
 * Não espera os 60 s do intervalo (a suíte inteira tem orçamento menor que
 * isso) e não espera a presença expirar. O que ela cobra é a PRIMEIRA batida,
 * que sai no momento em que a tela monta — que é justamente o caso que audita,
 * cria a linha e acorda o roteamento. O ciclo longo fica para o invariante e
 * para o teste unitário da rota, que medem sem relógio de parede.
 */
import { expect, test } from "./helpers/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

test.describe.configure({ timeout: 180_000 });

test.describe("Sinal de presença do atendente", () => {
  test("com a aba aberta, o sinal sai sozinho — e a Equipe mostra quem está aí", async ({ page }) => {
    // A fronteira: toda chamada ao emissor é registrada antes de seguir para o
    // servidor. Observar a REDE é o que distingue "o hook está montado" de "a
    // rota existe" — a segunda é verdade mesmo com o emissor removido.
    const batidas: string[] = [];
    await page.route("**/api/v1/attendants/presence", async (route) => {
      batidas.push(new Date().toISOString());
      await route.continue();
    });

    await loginComoAdmin(page, lerCreds());

    // A primeira batida sai na montagem da tela, sem nenhum clique. Se o
    // `useSinalDePresenca` sumir do AppShell, esta espera estoura — é a guarda
    // que a suíte unitária não tem.
    await expect
      .poll(() => batidas.length, {
        message: "nenhuma batida de presença saiu com a aba aberta — o emissor sumiu do AppShell?",
        timeout: 60_000,
      })
      .toBeGreaterThan(0);

    // E o efeito na tela de quem administra: a Equipe diz quem está com a tela
    // aberta. O seletor é o nome da pessoa logada, que o seed garante existir.
    await page.goto("/app/team");

    // A lista de atendentes mora na aba "Atendimento", que NÃO é a aba padrão
    // (a padrão é "Membros"). Medido no CI duas vezes: sem este clique o selo
    // simplesmente não existe no DOM, e a spec reprovava por procurar numa tela
    // que não tinha o que ela buscava — primeiro na tabela de convites, depois
    // no nada.
    await page.getByRole("tab", { name: /atendimento|atención|attendance/i }).click();

    // O selo tem `data-testid="presenca"` e carrega o estado em
    // `data-presente`, que é o dado — o texto ("Com a tela aberta") é a
    // redação, e prender a spec à redação a quebra na primeira tradução.
    //
    // Medido no CI antes deste ajuste: a primeira versão procurava o texto na
    // linha da TABELA DE CONVITES (nome, e-mail, papel, "Aceito"), que não tem
    // selo de presença nenhum — a spec reprovava por olhar o lugar errado, com
    // a batida já provada acima.
    const selo = page.getByTestId("presenca").first();
    await expect(selo).toBeVisible({ timeout: 30_000 });
    await expect(selo).toHaveAttribute("data-presente", "sim", { timeout: 30_000 });
  });
});
