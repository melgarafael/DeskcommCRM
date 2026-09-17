/**
 * A ABA DIZ O NOME DA TELA — as 17 páginas de `/app/*` que caíam no default.
 *
 * ─── O defeito, e por que ele sobreviveu ──────────────────────────────────
 *
 * `app/layout.tsx` declara `title.default` (o nome da marca MAIS a descrição
 * inteira da landing) e `title.template` (`%s · <marca>`). Página que não
 * declara `metadata.title` não cai no template: ela herda o **default**. Então
 * 17 telas do produto abriam a aba com a frase de venda inteira, e quem tem
 * cinco abas abertas não distingue uma da outra.
 *
 * Ninguém pegou porque título de aba não quebra nada e não aparece em
 * screenshot de teste. É preciso LER `document.title` por ferramenta — que é o
 * que este arquivo faz (`page.title()`), em vez de olhar a tela.
 *
 * ─── O que se cobra aqui ──────────────────────────────────────────────────
 *
 * Três propriedades, três modos de falha:
 *
 * 1. **Nome próprio**: cada rota abre com o título curto que ela declara.
 * 2. **Não é o default**: a descrição da landing não aparece em título nenhum —
 *    é a assinatura exata do defeito.
 * 3. **Distinguíveis**: 17 rotas, 17 títulos diferentes. Sem isto, duas telas
 *    poderiam declarar o mesmo nome e o teste passaria pelas duas primeiras
 *    propriedades enquanto a aba continua sem servir para escolher.
 */
import { expect, test } from "@playwright/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

test.describe.configure({ timeout: 180_000 });

/** O pedaço do título DEFAULT — se ele aparece, a página não declarou o seu. */
const FRASE_DA_LANDING = "atendimento e vendas por WhatsApp com agentes de IA";

const TELAS: ReadonlyArray<readonly [string, string]> = [
  ["/app/inbox", "Inbox"],
  ["/app/crm", "CRM"],
  ["/app/contacts", "Contatos"],
  ["/app/kanban", "Funis"],
  ["/app/team", "Equipe"],
  ["/app/tasks", "Tarefas"],
  ["/app/activities", "Atividades"],
  ["/app/settings", "Configurações"],
  ["/app/templates", "Respostas rápidas"],
  ["/app/webhooks", "Webhooks"],
  ["/app/metrics", "Desempenho"],
  ["/app/radar", "Radar"],
  ["/app/audit", "Audit Log"],
  ["/app/ai", "Agente de IA"],
  ["/app/analise", "Análise"],
  ["/app/products", "Produtos"],
  ["/app/connections", "Conexões"],
];

test("as telas do app dizem o próprio nome na aba, e nenhuma cai no título da landing", async ({
  page,
}) => {
  await loginComoAdmin(page, lerCreds());

  const lidos: Array<{ rota: string; titulo: string }> = [];
  for (const [rota, nome] of TELAS) {
    await page.goto(rota, { waitUntil: "domcontentloaded" });
    // `page.title()` lê o DOM depois da hidratação do App Router — e é
    // FERRAMENTA, não olho: um título que "parece certo" na captura de tela
    // pode ser o default truncado pela largura da aba.
    const titulo = await page.title();
    lidos.push({ rota, titulo });

    expect(titulo, `${rota} caiu no título default da landing`).not.toContain(FRASE_DA_LANDING);
    expect(titulo, `${rota} não abriu com o nome curto da tela`).toMatch(
      new RegExp(`^${nome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} · .+$`),
    );
  }

  const distintos = new Set(lidos.map((l) => l.titulo));
  expect(
    distintos.size,
    `duas telas abrem a aba com o mesmo título: ${JSON.stringify(lidos, null, 2)}`,
  ).toBe(TELAS.length);

  // O título é invisível em screenshot — a evidência é a lista medida.
  await page.goto("/app/team", { waitUntil: "domcontentloaded" });
  await page.screenshot({ path: "evidence/triagem-14set/727-titulo-equipe.png", fullPage: false });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(lidos, null, 2));
});
