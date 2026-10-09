/**
 * RELATÓRIO POR ETIQUETA — a aba nova de Relatórios (#1891, PR #2285), PELA TELA.
 *
 * O PR trouxe teste de unidade da tabela e do `?tag=` do Inbox, cada um com o
 * vizinho mockado. Nenhum deles prova o que o gestor vive: abrir a aba, ler o
 * número da etiqueta e clicar nela até as conversas. É o que este spec faz.
 *
 * ─── O caso que o link antigo escondia ─────────────────────────────────────
 * A linha conta TODA conversa da etiqueta no período — aberta, com dono ou
 * resolvida. O Inbox abre por padrão na Fila, que esconde as duas últimas; por
 * isso o link leva `filter=all`. A semente tem uma de cada, e a prova exige as
 * três na lista. O CONTROLE (link sem `filter=all`) mostra que a resolvida e a
 * com dono somem na Fila: sem ele, este spec passaria também num produto que
 * nunca precisou do `filter=all`.
 *
 * ─── Semente pelo caminho de produção ──────────────────────────────────────
 * Contato e conversa nascem por `POST /conversations/open-with-contact` (o
 * mesmo do cartão de contato do Inbox), o dono por `POST /claim`, e etiqueta e
 * encerramento por `PATCH /conversations/:id` — tudo na sessão do gestor
 * logado. A sessão de canal é a do seed de passo (`seed-e2e-followup-agent`),
 * que roda em toda parte `!= 4`. Só a LIMPEZA usa service role.
 *
 * Pré-requisitos (banco local do baseline, app buildada):
 *   pnpm e2e:env && pnpm e2e:build
 *   pnpm exec playwright test tests/e2e/relatorio-por-etiqueta.spec.ts
 */
import { randomInt } from "node:crypto";

import { test, type Page } from "./helpers/test";

import { admin, captura, creds, expect, login, type Creds } from "./qa-l12-comum";

/** Minúscula de propósito: o schema de etiqueta normaliza para minúsculas. */
const TAG = `rel-etq-${`${Date.now()}`.slice(-7)}`;

let c: Creds;
const conversas: string[] = [];
const contatos: string[] = [];

/** Abre contato + conversa pela rota de produção e devolve os ids. */
async function abreConversa(page: Page, nome: string): Promise<string> {
  const r = await page.request.post("/api/v1/conversations/open-with-contact", {
    data: { phone_number: `+55119${randomInt(10_000_000, 100_000_000)}`, name: nome },
  });
  expect(r.ok(), `open-with-contact (${nome}): ${await r.text()}`).toBe(true);
  // A rota devolve `{ conversation_id, contact_id }`, não `id`.
  const { data } = (await r.json()) as { data: { conversation_id: string; contact_id: string } };
  conversas.push(data.conversation_id);
  contatos.push(data.contact_id);
  return data.conversation_id;
}

async function patch(page: Page, id: string, corpo: Record<string, unknown>): Promise<void> {
  const r = await page.request.patch(`/api/v1/conversations/${id}`, { data: corpo });
  expect(r.ok(), `PATCH ${id} ${JSON.stringify(corpo)}: ${await r.text()}`).toBe(true);
}

const itemDaLista = (page: Page, id: string) =>
  page.locator(`button[data-conversation-id="${id}"]`);

test.describe("Relatórios › Por etiqueta, pela tela (#1891)", () => {
  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(() => {
    c = creds();
  });

  test.afterAll(async () => {
    if (conversas.length) {
      const { error: e1 } = await admin.from("conversations").delete().in("id", conversas);
      expect(e1).toBeNull();
    }
    if (contatos.length) {
      const { error: e2 } = await admin.from("contacts").delete().in("id", contatos);
      expect(e2).toBeNull();
    }
  });

  test("a linha conta as três conversas e o clique leva às três na aba Todas", async ({ page }) => {
    const gestor = c.users.manager!;
    await login(page, gestor.email, c.password);

    // ── Semente: aberta sem dono, aberta com dono, resolvida. ──────────────
    const aberta = await abreConversa(page, `Etiqueta ${TAG} aberta`);
    const comDono = await abreConversa(page, `Etiqueta ${TAG} com dono`);
    const resolvida = await abreConversa(page, `Etiqueta ${TAG} resolvida`);
    // CONTROLE sem a etiqueta: sem ela, o `toHaveCount(3)` lá embaixo passaria
    // num servidor que ignora `?tag=` sempre que a org tivesse só estas três.
    const controle = await abreConversa(page, `Etiqueta ${TAG} controle`);

    const claim = await page.request.post(`/api/v1/conversations/${comDono}/claim`, { data: {} });
    expect(claim.ok(), `claim: ${await claim.text()}`).toBe(true);
    await patch(page, aberta, { tags: [TAG] });
    await patch(page, comDono, { tags: [TAG] });
    // O handler aplica o status ANTES das etiquetas: encerrar não as apaga.
    await patch(page, resolvida, { status: "closed", tags: [TAG] });

    // Pré-condição lida no banco, para um vermelho adiante apontar a TELA e
    // não a semente.
    const { data: lidas, error } = await admin
      .from("conversations")
      .select("id, status, assigned_to_user_id, tags")
      .in("id", [aberta, comDono, resolvida]);
    expect(error).toBeNull();
    const porId = new Map((lidas ?? []).map((l) => [l.id as string, l]));
    expect(porId.get(resolvida)?.status).toBe("closed");
    expect(porId.get(comDono)?.assigned_to_user_id).toBe(gestor.id);
    expect(porId.get(aberta)?.assigned_to_user_id).toBeNull();
    for (const l of porId.values()) expect(l.tags).toEqual([TAG]);

    // ── O relatório: a linha da etiqueta, com os números exatos. ───────────
    await page.goto("/app/activities?aba=etiquetas");
    await expect(page.getByRole("tab", { name: "Por etiqueta" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByTestId("tabela-por-etiqueta")).toBeVisible({ timeout: 30_000 });

    const link = page.getByTestId("link-de-etiqueta").getByText(TAG, { exact: true });
    const linha = page.getByTestId("linha-de-etiqueta").filter({ has: link });
    await expect(linha).toHaveCount(1);
    // Etiqueta · Conversas · Abertas · Resolvidas · Espera média · Fatia.
    // A com dono é ABERTA: dono não é desfecho.
    await expect(linha.locator("td")).toHaveText([TAG, "3", "2", "1", /\S/, /^\d{1,3}%$/]);
    expect(await link.getAttribute("href")).toBe(
      `/app/inbox?filter=all&tag=${encodeURIComponent(TAG)}`,
    );
    await captura(page, "relatorio-por-etiqueta-01-linha");

    // ── O clique: Inbox na aba Todas, filtrado, com as TRÊS. ───────────────
    await link.click();
    await page.waitForURL(new RegExp(`/app/inbox\\?filter=all&tag=${TAG}`), { timeout: 30_000 });
    await expect(page.getByRole("tab", { name: /Todas/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    for (const id of [aberta, comDono, resolvida]) {
      await expect(itemDaLista(page, id)).toBeVisible({ timeout: 30_000 });
    }
    // Filtrada de verdade: a etiqueta é única desta rodada, então a lista
    // inteira são as três — nenhuma conversa alheia da org compartilhada.
    await expect(page.locator("button[data-conversation-id]")).toHaveCount(3);
    await expect(itemDaLista(page, controle), "a sem etiqueta fica fora").toHaveCount(0);
    await captura(page, "relatorio-por-etiqueta-02-inbox-todas");

    // ── CONTROLE: o link sem `filter=all` (o Inbox abre na Fila). ──────────
    // Espera a lista DA FILA (é ela que pede `comando=`) e filtrada chegar
    // antes de contar zero; sem isso o zero mediria a tela ainda carregando.
    const listaDaFila = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/conversations?") &&
        r.url().includes("comando=") &&
        r.url().includes(`tag=${TAG}`) &&
        r.status() === 200,
      { timeout: 30_000 },
    );
    await page.goto(`/app/inbox?tag=${encodeURIComponent(TAG)}`);
    // O que a Fila RECEBEU, além do que desenhou: um zero só na tela poderia
    // ser render atrasado.
    const { data: daFila } = (await (await listaDaFila).json()) as { data: Array<{ id: string }> };
    const idsDaFila = daFila.map((cv) => cv.id);
    expect(idsDaFila).not.toContain(resolvida);
    expect(idsDaFila).not.toContain(comDono);
    await expect(page.getByRole("tab", { name: /Fila/i }).first()).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(itemDaLista(page, resolvida), "a Fila esconde a resolvida").toHaveCount(0);
    await expect(itemDaLista(page, comDono), "a Fila esconde a que tem dono").toHaveCount(0);
  });
});
