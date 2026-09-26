/**
 * REVOGAR E DEVOLVER ACESSO PINTAM A LINHA NA HORA — pela TELA (PR #719).
 *
 * ─── O que se mede aqui, e por que o momento é o ponto ────────────────────
 *
 * O conserto é otimista: `onMutate` pinta a linha ANTES de o servidor
 * responder, `onError` desfaz, `onSettled` reconcilia. Um teste que espere a
 * promessa resolver não distingue "pintou na hora" de "recarregou no fim" —
 * que é exatamente o defeito relatado ("a linha ficava parada até alguém
 * recarregar a página").
 *
 * Então este arquivo SEGURA a resposta do servidor com `page.route` e cobra a
 * tela enquanto o pedido ainda está pendente. Se o `onMutate` sair, a linha só
 * muda depois que a rota responde — e a asserção feita durante a espera
 * reprova.
 *
 * O desfazer é cobrado do mesmo jeito, e com um cuidado a mais: `onSettled`
 * invalida a lista, e um refetch bem-sucedido devolveria "Revogado" mesmo SEM
 * rollback. Por isso o GET de `/api/v1/team` também fica preso enquanto a volta
 * é medida — o que se vê na tela nesse instante só pode ter vindo do rollback.
 *
 * ─── Fixture ─────────────────────────────────────────────────────────────
 *
 * O alvo é o usuário `viewer` do seed (nunca o próprio admin logado — a linha
 * de quem está logado não tem menu de ações). O estado é reposto no início e no
 * fim: revogar um usuário do seed e deixá-lo assim quebraria as outras specs
 * que compartilham este banco.
 */
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "./helpers/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, {
  auth: { persistSession: false },
});

test.describe.configure({ timeout: 180_000 });

interface CredsComId {
  password: string;
  users: Record<string, { id: string; email: string } | undefined>;
}

const creds = lerCreds() as unknown as CredsComId;
const alvo = creds.users.viewer;

async function reporEstado(revokedAt: string | null): Promise<void> {
  if (!alvo) throw new Error(".e2e-creds.json sem o usuário `viewer`");
  const r = await db
    .from("user_organizations")
    .update({ revoked_at: revokedAt })
    .eq("user_id", alvo.id);
  if (r.error) throw r.error;
}

test.beforeEach(async () => {
  await reporEstado(null);
});

test.afterAll(async () => {
  await reporEstado(null);
});

test("revogar pinta a linha ANTES de o servidor responder", async ({ page }) => {
  if (!alvo) throw new Error(".e2e-creds.json sem o usuário `viewer`");
  await loginComoAdmin(page, lerCreds());
  await page.goto("/app/team?aba=membros");

  // ⚠️ `tr` por CSS, e NÃO `getByRole("row")`. O diálogo de confirmação do
  // Radix marca todo o resto da página como `aria-hidden`, então enquanto ele
  // está aberto — que é exatamente a janela em que se mede — a linha some da
  // árvore de acessibilidade e `getByRole` não a encontra. Medido: a primeira
  // versão deste caso reprovou por isso, dizendo "a pintura otimista saiu"
  // quando a pintura estava lá, atrás do modal.
  const linha = page.locator("tr").filter({ hasText: alvo.email });
  await expect(linha.getByText("Aceito", { exact: true })).toBeVisible({ timeout: 20_000 });

  // ── Segura a resposta do POST. Nada de `setTimeout`: a resposta só sai
  //    quando ESTE teste mandar, então "ainda não respondeu" é fato, não aposta.
  let liberar: (() => void) | undefined;
  const presa = new Promise<void>((r) => (liberar = r));
  let pedidoSaiu = false;
  await page.route("**/api/v1/team/*/revoke", async (route) => {
    pedidoSaiu = true;
    await presa;
    await route.continue();
  });

  await linha.getByRole("button", { name: "Ações" }).click();
  await page.getByRole("menuitem", { name: "Revogar acesso" }).click();
  await page.getByRole("button", { name: "Revogar", exact: true }).click();

  // A MEDIDA. O POST está pendente (a resposta está presa acima) e a linha já
  // mudou. Sem `onMutate`, aqui ainda se leria "Aceito".
  await expect(
    linha.getByText("Revogado", { exact: true }),
    "a linha não mudou enquanto o servidor ainda não respondeu — a pintura otimista saiu",
  ).toBeVisible({ timeout: 3_000 });
  expect(pedidoSaiu, "o pedido nem chegou a sair — o teste mediu outra coisa").toBe(true);

  await page.screenshot({
    path: "evidence/triagem-14set/719-revogado-antes-da-resposta.png",
    fullPage: false,
  });

  liberar?.();
  await expect(page.getByText("Acesso revogado.")).toBeVisible({ timeout: 15_000 });

  // E o efeito é do servidor, não só da tela: recarregar mantém.
  await page.reload();
  await expect(
    page.locator("tr").filter({ hasText: alvo.email }).getByText("Revogado", { exact: true }),
  ).toBeVisible({ timeout: 20_000 });
});

test("a recusa do servidor DESFAZ a pintura de devolver acesso", async ({ page }) => {
  if (!alvo) throw new Error(".e2e-creds.json sem o usuário `viewer`");
  await reporEstado(new Date().toISOString());
  await loginComoAdmin(page, lerCreds());
  await page.goto("/app/team?aba=membros");

  const linha = page.locator("tr").filter({ hasText: alvo.email });
  await expect(linha.getByText("Revogado", { exact: true })).toBeVisible({ timeout: 20_000 });

  // O servidor recusa — e demora 1,2 s, para dar tempo de ler a tela ANTES da
  // recusa (é lá que a pintura otimista aparece).
  await page.route("**/api/v1/team/*/reactivate", async (route) => {
    await new Promise((r) => setTimeout(r, 1_200));
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "internal_error", message: "recusa forçada pelo teste" },
      }),
    });
  });

  // E o refetch da lista fica PRESO: sem isto, o "Revogado" que volta à tela
  // poderia ter vindo do servidor em vez do rollback.
  let liberarLista: (() => void) | undefined;
  const listaPresa = new Promise<void>((r) => (liberarLista = r));
  await page.route("**/api/v1/team", async (route) => {
    await listaPresa;
    await route.continue();
  });

  await linha.getByRole("button", { name: "Ações" }).click();
  await page.getByRole("menuitem", { name: "Devolver acesso" }).click();

  // 1) pintou na hora (o servidor ainda está pensando)
  await expect(
    linha.getByText("Aceito", { exact: true }),
    "devolver acesso não pintou a linha antes da resposta",
  ).toBeVisible({ timeout: 1_000 });

  // 2) o servidor recusou → desfez, com a lista ainda presa
  await expect(
    linha.getByText("Revogado", { exact: true }),
    "o servidor recusou e a tela continuou dizendo que o acesso voltou",
  ).toBeVisible({ timeout: 10_000 });
  await page.screenshot({
    path: "evidence/triagem-14set/719-rollback-apos-recusa.png",
    fullPage: false,
  });

  liberarLista?.();
});
