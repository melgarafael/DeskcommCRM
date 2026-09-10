import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

// Opt-in: executado contra instalação local dedicada, com dono criado por bootstrap-owner.
test("grade semanal: criar simultâneas, editar, conflito, desativar, reativar e usar no celular", async ({ page }) => {
  test.skip(!process.env.ACADEMIA_E2E_EMAIL || !process.env.ACADEMIA_E2E_PASSWORD);
  test.setTimeout(120000);
  const browserErrors: string[] = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  await page.goto("/login");
  await page.locator("#email").fill(process.env.ACADEMIA_E2E_EMAIL!);
  await page.locator("#password").fill(process.env.ACADEMIA_E2E_PASSWORD!);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(?:\/|$)/);
  await page.goto("/app/settings/modules");
  const moduleSwitch = page.getByRole("switch");
  if (!(await moduleSwitch.isChecked())) {
    await moduleSwitch.click();
    await page.getByRole("button", { name: "Salvar alteração", exact: true }).click();
    await expect(page.getByRole("link", { name: "Abrir Minha Academia", exact: true })).toBeVisible();
  }
  await expect(moduleSwitch).toBeChecked();
  await page.getByRole("link", { name: "Minha Academia", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Grade semanal", exact: true })).toBeVisible();
  const suffix = randomUUID().slice(0, 8);
  const labels = ["Modalidades", "Públicos", "Professores", "Ambientes"];
  const singular = ["Modalidade", "Público", "Professor", "Ambiente"];
  const names = singular.map(label => `${label} de teste ${suffix}`);
  await page.getByRole("button", { name: "Cadastros", exact: true }).click();
  for (const [i, label] of labels.entries()) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.getByRole("button", { name: "Novo cadastro", exact: true }).click();
    await page.getByRole("dialog").getByLabel("Nome", { exact: true }).fill(names[i]!);
    await page.getByRole("button", { name: "Salvar cadastro", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await page.getByRole("button", { name: "Grade semanal", exact: true }).click();
  const records: { id: string; revision: number; values: Record<string, unknown> }[] = [];
  for (let n = 0; n < 2; n++) {
    await page.getByRole("button", { name: "Nova aula", exact: true }).click();
    const dialog = page.getByRole("dialog");
    for (const [i, label] of singular.entries()) await dialog.getByLabel(label, { exact: true }).selectOption({ label: names[i]! });
    await dialog.getByLabel("Dia da semana", { exact: true }).selectOption("1");
    await dialog.getByLabel("Início", { exact: true }).fill("08:30");
    await dialog.getByLabel("Duração (minutos)", { exact: true }).fill("45");
    const created = page.waitForResponse(r => r.url().endsWith("/academia/schedule") && r.request().method() === "POST");
    await dialog.getByRole("button", { name: "Salvar aula", exact: true }).click();
    const response = await created; expect(response.status()).toBe(201);
    const result = await response.json();
    const values = response.request().postDataJSON().values;
    records.push({ id: result.data.id, revision: result.data.revision, values });
    expect((await page.request.post("/api/v1/academia/schedule", { headers: { "Idempotency-Key": result.data.id }, data: { values } })).status()).toBe(200);
    await expect(dialog).toHaveCount(0);
  }
  const cards = page.locator("article").filter({ has: page.getByRole("heading", { name: names[0]!, exact: true }) });
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText("08:30 – 09:15");
  await expect(cards.first()).toContainText(names[2]!);
  await expect(cards.first()).toContainText(names[3]!);
  await expect(page.getByText("Aula salva.", { exact: true })).toHaveCount(0, { timeout: 10000 });
  await page.screenshot({ path: ".superpowers/evidence/grade-desktop.png", fullPage: true });
  await cards.first().getByRole("button", { name: /Editar aula/ }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Início", { exact: true }).fill("23:30");
  await dialog.getByLabel("Duração (minutos)", { exact: true }).fill("90");
  const edited = page.waitForResponse(r => r.url().endsWith("/academia/schedule") && r.request().method() === "PATCH");
  await dialog.getByRole("button", { name: "Salvar aula", exact: true }).click();
  const changed = await (await edited).json();
  await expect(dialog).toHaveCount(0);
  const original = records.find(row => row.id === changed.data.id)!;
  expect((await page.request.patch("/api/v1/academia/schedule", { data: original })).status()).toBe(409);
  const changedCard = cards.filter({ hasText: "23:30" });
  await expect(changedCard).toContainText("01:00 (+1 dia)");
  await changedCard.getByRole("button", { name: /Editar aula/ }).click();
  const concurrent = await page.request.patch("/api/v1/academia/schedule", { data: {
    id: changed.data.id, revision: changed.data.revision,
    values: { ...original.values, start_time: "23:30", duration_minutes: 90, notes: "Alteração concorrente" },
  } });
  expect(concurrent.status()).toBe(200);
  await page.getByRole("dialog").getByRole("button", { name: "Salvar aula", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Atualize a grade");
  await page.getByRole("button", { name: "Cancelar", exact: true }).click();
  await page.getByRole("button", { name: "Atualizar grade", exact: true }).click();
  await expect(changedCard).toContainText("Alteração concorrente");
  await changedCard.getByRole("button", { name: /Editar aula/ }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Aula ativa").uncheck();
  await dialog.getByRole("button", { name: "Salvar aula", exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(cards).toHaveCount(1);
  await page.getByLabel("Mostrar aulas inativas").check();
  await expect(changedCard.getByText("Inativa", { exact: true })).toBeVisible();
  await changedCard.getByRole("button", { name: /Editar aula/ }).click();
  await page.getByRole("dialog").getByLabel("Aula ativa").check();
  await page.getByRole("button", { name: "Salvar aula", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(changedCard.getByText("Ativa", { exact: true })).toBeVisible();
  await page.getByLabel("Dia da semana", { exact: true }).selectOption("2");
  await expect(cards).toHaveCount(0);
  await page.getByLabel("Dia da semana", { exact: true }).selectOption("0");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Nova aula", exact: true }).click();
  await expect(page.getByRole("dialog").getByLabel("Professor", { exact: true })).toBeVisible();
  const bounds = await page.getByRole("dialog").boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  dialog = page.getByRole("dialog");
  for (const [i, label] of singular.entries()) await dialog.getByLabel(label, { exact: true }).selectOption({ label: names[i]! });
  await dialog.getByLabel("Dia da semana", { exact: true }).selectOption("2");
  await dialog.getByLabel("Início", { exact: true }).fill("07:00");
  await dialog.getByLabel("Duração (minutos)", { exact: true }).fill("30");
  await expect(page.getByText("Aula salva.", { exact: true })).toHaveCount(0, { timeout: 10000 });
  await dialog.getByRole("button", { name: "Salvar aula", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".superpowers/evidence/grade-mobile.png" });
  await dialog.getByRole("button", { name: "Salvar aula", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(cards).toHaveCount(3);
  expect(browserErrors).toEqual([]);
  // O conjunto sintético fica no banco descartável desta instalação de QA.
});
