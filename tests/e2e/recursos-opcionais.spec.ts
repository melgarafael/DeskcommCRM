/**
 * A ÁREA "RECURSOS OPCIONAIS", PELA TELA (pedido do mantenedor, doc 73; desenho no doc 80).
 *
 * O pedido era de achabilidade: "não entendi onde ficam os lugares para
 * ativar/desativar". Então esta spec prova o CAMINHO, não só a tela:
 *
 *   1. o admin da empresa chega pelo hub de Configurações (sem digitar URL),
 *      vê a lista e o "Ajustar" de uma chave o leva à tela onde ela mora;
 *   2. o dono do servidor vê a porta "Recursos opcionais" no menu do Admin, e a
 *      tela tem os três blocos, com o que depende do servidor só em leitura.
 *
 * O que ela NÃO prova: que cada leitura de estado bate com a tela do recurso —
 * isso é regra pura, coberta em `tests/unit/recursos-opcionais-catalogo.test.ts`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { expect, test } from "./helpers/test";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { moduloLigado } from "../../lib/instalacao/modulos";

import { lerCreds, loginComoAdmin, loginComoDono } from "./helpers/login-admin";
import { afirmarDonoDoServidor } from "./utils/precondicao";

const EVIDENCIA = path.join(process.cwd(), "evidence", "recursos-opcionais");
function evidencia(nome: string): string {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  return path.join(EVIDENCIA, nome);
}

test.describe.configure({ timeout: 120_000 });

/**
 * ESPERA O BANCO, NÃO A TELA — e isto é o conserto de um defeito do teste que me custou duas
 * rodadas de CI, com dois sintomas opostos e UMA causa.
 *
 * O interruptor de `/admin/sistema` é OTIMISTA: `_form.tsx` vira o estado local no clique e só
 * depois aguarda a action. Então `aria-checked` (e a frase "Aparece no menu em:", que lê o mesmo
 * estado) ficam verdes ANTES de o banco ter a linha. Navegar nesse instante mede um servidor que
 * ainda não sabe da mudança:
 *
 *   - ao LIGAR, `/app/companies` caiu no `notFound()` do layout e não havia barra lateral —
 *     o link "não existia" (`element(s) not found`);
 *   - ao DESLIGAR, a porta continuou lá (`Expected: 0  Received: 4`).
 *
 * Os dois sintomas são opostos e a causa é a mesma, que é exatamente o que torna esse tipo de
 * corrida difícil de ler a partir de um só vermelho. A espera usa `moduloLigado`, a MESMA função
 * que a aplicação usa para decidir — não uma consulta paralela que poderia divergir dela. É o
 * padrão que `fluxo-de-atendimento.spec.ts` já usava.
 */
const db = createClient(
  credenciaisSupabaseDeTeste().url,
  credenciaisSupabaseDeTeste().serviceRole,
  { auth: { persistSession: false } },
);

async function esperarModuloNoBanco(ligado: boolean): Promise<void> {
  await expect.poll(async () => moduloLigado(db, "crm_b2b"), { timeout: 20_000 }).toBe(ligado);
}

test("admin da empresa acha os recursos opcionais e o Ajustar leva à tela certa", async ({ page }) => {
  await loginComoAdmin(page, lerCreds());

  // Pela porta, como o usuário: o hub de Configurações.
  await page.goto("/app/settings");
  await page.getByRole("link", { name: /Recursos opcionais/ }).first().click();
  await expect(page).toHaveURL(/\/app\/settings\/recursos$/);

  await expect(page.getByRole("heading", { level: 1, name: "Recursos opcionais" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Módulos desta instalação" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Da sua empresa" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Em cada agente" })).toBeVisible();

  const linha = page.locator('[data-recurso="conversa_fica_com_quem_atendeu"]');
  await expect(linha).toContainText("A conversa fica com quem atendeu");
  // O estado vem lido, não um placeholder: é um dos dois rótulos de chave da empresa.
  await expect(linha).toContainText(/Ligado|Desligado/);
  await page.screenshot({ path: evidencia("empresa.png"), fullPage: true });

  await linha.getByRole("link", { name: /Ajustar/ }).click();
  await expect(page).toHaveURL(/\/app\/settings\/atendimento$/);
  await expect(page.getByRole("heading", { level: 1, name: "Distribuição de atendimento" })).toBeVisible();
});

test("dono do servidor vê a porta Recursos opcionais e os três blocos no Admin", async ({ page }) => {
  // O `e2e-dono` só é platform admin se um seed anterior o promoveu; sem esta
  // afirmação a spec mediria a ordem de execução em vez do produto.
  await afirmarDonoDoServidor(lerCreds().users.dono!.email);
  await loginComoDono(page, lerCreds());

  await page.goto("/admin");
  await page.getByRole("link", { name: "Recursos opcionais" }).first().click();
  await expect(page).toHaveURL(/\/admin\/sistema$/);

  await expect(page.getByRole("heading", { level: 1, name: "Recursos opcionais" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Módulos", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Comportamento", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Depende do servidor" })).toBeVisible();

  // Só leitura, com estado detectado — e nada que se pareça com valor de segredo.
  const email = page.locator('[data-recurso="email"]');
  await expect(email).toContainText(/Configurado|Não configurado/);
  await expect(page.locator('[data-recurso="graph_parceiro"]')).toBeVisible();
  await page.screenshot({ path: evidencia("admin.png"), fullPage: true });
});

/**
 * A JORNADA QUE O MANTENEDOR RELATOU, DE PONTA A PONTA.
 *
 * O relato: "os módulos que são ativados aqui, eles não aparecem no CRM". Daqui saíram DOIS
 * defeitos medidos e um conserto PREVENTIVO, e nenhum deles era o gate de módulo (esse sempre
 * funcionou). A CAUSA do relato era outra, achada só numa revisão posterior: as telas de módulo
 * não ficam no menu do dia a dia, e o texto desta tela mandava procurar lá.
 *
 *   1. a tela do interruptor nunca dizia ONDE o módulo apareceria — o dado
 *      existia (`ondeOModuloAparece`, lido do próprio menu) e só a tela da
 *      EMPRESA o consumia, nunca a de quem liga;
 *   2. `updateModuloDaInstalacao` revalidava só `/admin/sistema`; o menu do CRM
 *      vive no layout de `/app` e continuava o de antes;
 *   3. a empresa no preset "simplificada" nunca via porta de módulo nenhuma —
 *      a lista do preset é NOSSA, escrita antes de existir módulo opcional.
 *
 * Esta spec dirige o produto como o mantenedor dirigiu: liga pela tela, LÊ o que
 * a tela promete e vai ao CRM conferir se a promessa se cumpriu. Depois desliga
 * e exige que a porta saia — senão o verde seria só a metade fácil.
 */
test("liga um módulo, a tela diz onde ele aparece, e a porta está lá no CRM", async ({ page }) => {
  await afirmarDonoDoServidor(lerCreds().users.dono!.email);
  await loginComoDono(page, lerCreds());

  const PORTA = "Empresas";
  const chave = page.getByRole("switch", { name: "Empresas e pessoas (venda para empresas)" });

  await test.step("a tela diz onde o módulo vai aparecer ANTES de ligar", async () => {
    await page.goto("/admin/sistema");
    await expect(chave).toBeVisible();
    const ligadoAntes = (await chave.getAttribute("aria-checked")) === "true";
    if (ligadoAntes) {
      await chave.click();
      await expect(chave).toHaveAttribute("aria-checked", "false");
    }
    await esperarModuloNoBanco(false);
    // A frase é o conserto: sem ela o operador liga e não sabe para onde olhar.
    //
    // ⚠️ O CAMINHO INCLUI O PASSO DO HUB ("Ver tudo em CRM"), e é isso que a opção B entrega. Este
    // regex já ficou velho uma vez: eu mudei o texto da tela e esqueci a spec, então ela cobrava
    // "CRM › Empresas" e a tela dizia "CRM › Ver tudo em CRM › Empresas". Teste que afirma texto
    // de tela envelhece junto com a tela.
    //
    // ⚠️ ANCORADA NO MÓDULO, e com `^`. A primeira versão só procurava "Ao ligar,
    // aparece no menu em:" e o Playwright recusou em strict mode: resolveu para
    // QUATRO elementos, um por módulo com interruptor. O vermelho foi bom — ele
    // imprimiu o texto dos quatro e provou que a tela renderiza o que devia,
    // inclusive "Configurações › Dados externos", que é a exceção do grupo do
    // rodapé. Mas asserção que casa com quatro linhas não diz qual delas mediu.
    await expect(
      page.getByText(/^Ao ligar, aparece no menu em: CRM › Ver tudo em CRM › Empresas/),
    ).toBeVisible();
    await page.screenshot({ path: evidencia("modulo-desligado-diz-onde.png"), fullPage: true });
  });

  await test.step("liga, e a frase passa a falar no presente", async () => {
    await chave.click();
    await expect(chave).toHaveAttribute("aria-checked", "true");
    await esperarModuloNoBanco(true);
    // `^` separa os dois estados: "Ao ligar, aparece…" CONTÉM "aparece no menu
    // em:", e sem a âncora o caso de ligado passaria com a frase de desligado.
    await expect(
      page.getByText(/^Aparece no menu em: CRM › Ver tudo em CRM › Empresas/),
    ).toBeVisible();
    await page.screenshot({ path: evidencia("modulo-ligado-diz-onde.png"), fullPage: true });
  });

  await test.step("⭐ a porta ESTÁ no hub do CRM (\"Ver tudo em CRM\")", async () => {
    // Navegação normal, como o operador faz. ⚠️ Este passo NÃO vigia a revalidação do layout:
    // `page.goto` é carregamento completo, e o hub lê `modulosLigados()` a cada request — ele
    // ficaria verde com ou sem o `revalidatePath("/app", "layout")`. O que ele mede é o recorte
    // por módulo chegando à tela que o texto promete.
    //
    // ⚠️ A MEDIÇÃO É NO HUB, não no menu lateral — e isso é escolha, não desvio.
    //
    // A primeira versão procurava `link "Empresas"` depois de abrir
    // `/app/companies`, e deu `element(s) not found`. Levantei duas hipóteses e
    // DERRUBEI as duas, medindo: (a) "o dono não é membro de organização" é falso —
    // o seed lhe dá `role: "admin"` de organização (`scripts/seed-e2e-credentials.ts`);
    // (b) "o grupo do menu está colapsado" é falso — `gruposFechados` nasce vazio,
    // então tudo abre por padrão (`components/shell/Sidebar.tsx`).
    //
    // Sem causa provada, não troco um palpite por outro: mudo de INSTRUMENTO. O que
    // esta jornada precisa provar é "a porta passou a ser oferecida a esta empresa",
    // e o hub do grupo é a superfície que responde exatamente isso — ele recebe o
    // mesmo `modulosLigados` que o menu lateral (`app/app/crm/page.tsx` → `NavHub`),
    // é caminho real de usuário ("Ver tudo em CRM") e não depende de viewport, de
    // grupo aberto nem de barra inferior. A rota segue conferida logo abaixo.
    await page.goto("/app/crm");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // ⚠️ A ÂNCORA É O TÍTULO DO CARD, e as duas correções aqui vieram de medição.
    //
    // 1. `name: "Empresas"` sem `exact` casa por SUBSTRING e sem distinguir maiúsculas — e o card
    //    "Prospecção" tem descrição "Busque EMPRESAS e conduza abordagens graduais com IA". Este
    //    passo positivo ficava VERDE com o módulo desligado: a prova não provava nada.
    // 2. Com `exact: true`, o `link` deixa de casar: o nome acessível do card do hub é o título
    //    MAIS a descrição ("Empresas Cadastro B2B — razão social, CNPJ e decisores."). O que tem
    //    nome exato é o `heading` de nível 3 dentro dele, como o snapshot da falha mostrou.
    await expect(
      page.getByRole("heading", { level: 3, name: PORTA, exact: true }),
    ).toBeVisible();

    // E a rota abre de verdade — o gate do layout (`notFound()` com o módulo
    // desligado) não a está barrando.
    await page.goto("/app/companies");
    await expect(page).toHaveURL(/\/app\/companies$/);
    await page.screenshot({ path: evidencia("porta-no-menu-do-crm.png"), fullPage: true });
  });

  await test.step("desliga e a porta SAI — senão o verde era só a metade fácil", async () => {
    await page.goto("/admin/sistema");
    await expect(chave).toBeVisible();
    await chave.click();
    await expect(chave).toHaveAttribute("aria-checked", "false");
    await esperarModuloNoBanco(false);

    await page.goto("/app/crm");
    // A mesma âncora do passo positivo, para os dois lados usarem a mesma régua. O `Received: 1`
    // da rodada anterior era o card "Prospecção" casando por substring — foi ele que me fez
    // perseguir três hipóteses erradas sobre revalidação e corrida de estado.
    await expect(page.getByRole("heading", { level: 3, name: PORTA, exact: true })).toHaveCount(0);
  });
});
