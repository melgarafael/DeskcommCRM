import { expect, test } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readContext } from './common.mjs';
import { runtimeExecutablePaths } from './runtime/workspace.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const evidence = path.join(repoRoot, '.superpowers/evidence/extensoes-bancada');

test.beforeAll(async ({ request }) => {
  const owned = await readContext(repoRoot);
  const status = await request.get('/api/status');
  expect(status.status()).toBe(200);
  const actual = await status.json();
  expect(actual.scope).toBe('architecture_experiments');
  expect(actual.workspace_id).toBe(createHash('sha256').update(owned.repoRoot).digest('hex'));
});

test('ambiente ausente aparece como pendência real, sem resultado inventado', async ({ page }) => {
  const context = await readContext(repoRoot);
  expect((await runtimeExecutablePaths(context)).available).toBe(true);
  const source = path.join(evidence, 'venv');
  const reserved = path.join(evidence, `venv-ui-recovery-${randomUUID()}`);
  // Recurso exclusivo, validado acima. Finalmente sempre o restaura, mesmo se a tela falhar.
  await rename(source, reserved);
  try {
    await page.goto('/');
    const started = page.waitForResponse(response => response.url().endsWith('/api/run/runtime') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Executar prova de execução' }).click();
    const response = await started;
    expect(response.status()).toBe(202);
    const { run_id: runId } = await response.json();
    await expect(page.getByTestId('runtime-result')).toHaveAttribute('data-run-id', runId);
    await expect(page.getByTestId('runtime-status')).toHaveText('Ambiente pendente');
    await expect(page.getByText('Nenhuma verificação foi concluída nesta rodada.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Executar prova de execução' })).toBeEnabled();
    const saved = JSON.parse(await readFile(path.join(evidence, 'console-results/runtime.json'), 'utf8'));
    expect(saved.run_id).toBe(runId);
    expect(saved.status).toBe('blocked');
    expect(saved.report.checks).toEqual([]);
    await page.reload();
    await expect(page.getByTestId('runtime-status')).toHaveText('Ambiente pendente');
    await page.screenshot({ path: path.join(evidence, 'console-fix-ui-ambiente-pendente.png'), fullPage: true });
  } finally { await rename(reserved, source); }
});

test('uma pessoa executa as provas, lê o resultado real e retoma a tela', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Bancada de extensões', exact: true })).toBeVisible();
  await expect(page.getByText('Estas provas não são a jornada integrada do CRM.', { exact: false })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Executar prova de execução' })).toBeFocused();
  await page.screenshot({ path: path.join(evidence, 'console-fix-ui-inicio.png'), fullPage: true });

  const cases = [
    ['runtime', 'Executar prova de execução', ['cross_org', 'fuel', 'host_timeout']],
    ['events', 'Executar prova de eventos', ['done_capture', 'commit_order', 'uncertain_effect']],
    ['state', 'Executar prova de dados', ['deactivation_race', 'old_job_schema', 'privacy_after_removal']],
  ];
  for (const [id, button, checks] of cases) {
    await expect(page.getByRole('button', { name: button })).toBeEnabled();
    const started = page.waitForResponse(response => response.url().endsWith(`/api/run/${id}`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: button }).click();
    const response = await started;
    expect(response.status()).toBe(202);
    const { run_id: runId } = await response.json();
    if (id === 'runtime') {
      expect((await page.request.post('/api/run/events', {
        headers: { origin: 'http://127.0.0.1:38761', 'x-request-id': randomUUID() }, data: {},
      })).status()).toBe(409);
    }
    await expect(page.getByTestId(`${id}-result`)).toHaveAttribute('data-run-id', runId);
    await expect(page.getByTestId(`${id}-status`)).toHaveText('Concluída', { timeout: 65000 });
    const saved = JSON.parse(await readFile(path.join(evidence, 'console-results', `${id}.json`), 'utf8'));
    expect(saved.status).toBe('passed');
    expect(saved.run_id).toBe(runId);
    for (const check of checks) {
      expect(saved.report.checks.some(item => item.id === check && item.passed)).toBe(true);
      await expect(page.getByTestId(`${id}-result`)).toContainText(check);
    }
    await testInfo.attach(`${id}-resultado-real`, { body: Buffer.from(JSON.stringify(saved, null, 2)), contentType: 'application/json' });
    const details = page.getByTestId(`${id}-result`).locator('details').first();
    await expect(details).not.toHaveAttribute('open');
    const summary = details.locator('summary');
    await summary.click();
    await expect(details.locator('.check').first()).toBeVisible();
    await summary.press('Enter');
    await expect(details).not.toHaveAttribute('open');
  }
  await page.reload();
  for (const [id] of cases) await expect(page.getByTestId(`${id}-status`)).toHaveText('Concluída');
  await page.screenshot({ path: path.join(evidence, 'console-fix-ui-desktop.png'), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  for (const [, name] of cases) {
    const button = page.getByRole('button', { name });
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box.width).toBeGreaterThan(200);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  const layout = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    font: getComputedStyle(document.body).fontFamily,
    language: document.documentElement.lang,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);
  expect(layout.font).toContain('system-ui');
  expect(layout.language).toBe('pt-BR');
  await page.screenshot({ path: path.join(evidence, 'console-fix-ui-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('a porta da bancada recusa outra origem, nomes livres e payload de código', async ({ request }) => {
  const url = 'http://127.0.0.1:38761';
  expect((await request.post('/api/run/runtime', { headers: { origin: 'https://example.test' }, data: {} })).status()).toBe(403);
  expect((await request.post('/api/run/arbitrary', { headers: { origin: url }, data: {} })).status()).toBe(404);
  expect((await request.post('/api/run/runtime', { headers: { origin: url }, data: 'x'.repeat(64) })).status()).toBe(413);
  expect((await request.get('/api/status', { headers: { host: 'example.test' } })).status()).toBe(403);
  expect((await request.post('/api/run/runtime', { headers: { origin: url, 'x-request-id': '../outside' } })).status()).toBe(400);
  expect((await request.get('/api/request/not-a-uuid')).status()).toBe(400);
});

test('perda de conexão preserva resultados e recupera os controles', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByTestId('runtime-status')).toHaveText('Concluída');
  const before = await page.getByTestId('runtime-result').getAttribute('data-run-id');
  await context.setOffline(true);
  await expect(page.getByText('Sem conexão com a bancada.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Executar prova de execução' })).toBeDisabled();
  await expect(page.getByTestId('runtime-status')).toHaveText('Concluída');
  await context.setOffline(false);
  await expect(page.getByRole('button', { name: 'Executar prova de execução' })).toBeEnabled();
  await expect(page.getByText('Sem conexão com a bancada.', { exact: false })).not.toBeVisible();
  await expect(page.getByTestId('runtime-result')).toHaveAttribute('data-run-id', before);
});

test('resposta perdida depois do aceite reconcilia a solicitação com o resultado real', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Executar prova de execução' })).toBeEnabled();
  let accepted;
  let confirmReceipt;
  const receiptGate = new Promise(resolve => { confirmReceipt = resolve; });
  await page.route('**/api/request/*', async route => { await receiptGate; await route.continue(); });
  await page.route('**/api/run/runtime', async route => {
    // O backend real executa; só a entrega da resposta ao navegador é interrompida.
    const response = await route.fetch();
    expect(response.status()).toBe(202);
    accepted = await response.json();
    expect(accepted.request_id).toBe(route.request().headers()['x-request-id']);
    await route.abort('connectionreset');
  });
  await page.getByRole('button', { name: 'Executar prova de execução' }).click();
  await expect.poll(() => accepted?.run_id).toBeTruthy();
  await expect(page.locator('#connection')).toContainText('Ainda não foi possível confirmar o início.');
  await page.screenshot({ path: path.join(evidence, 'console-fix-response-uncertain.png'), fullPage: true });
  confirmReceipt();
  await expect(page.getByTestId('runtime-result')).toHaveAttribute('data-run-id', accepted.run_id);
  await expect(page.getByTestId('runtime-status')).toHaveText('Concluída', { timeout: 65000 });
  const saved = JSON.parse(await readFile(path.join(evidence, 'console-results/runtime.json'), 'utf8'));
  expect(saved.run_id).toBe(accepted.run_id);
  expect(saved.report.checks.length).toBeGreaterThan(0);
  await page.screenshot({ path: path.join(evidence, 'console-fix-response-lost.png'), fullPage: true });
  await expect(page.locator('#connection')).toBeEmpty();
  const replay = await page.request.post('/api/run/runtime', { headers: { origin: 'http://127.0.0.1:38761', 'x-request-id': accepted.request_id } });
  expect(replay.status()).toBe(200);
  expect((await replay.json()).run_id).toBe(accepted.run_id);
  await page.reload();
  await expect(page.locator('#connection')).toBeEmpty();
  await expect(page.getByTestId('runtime-result')).toHaveAttribute('data-run-id', accepted.run_id);
  await testInfo.attach('resultado-depois-da-resposta-perdida', { body: Buffer.from(JSON.stringify(saved)), contentType: 'application/json' });
});
