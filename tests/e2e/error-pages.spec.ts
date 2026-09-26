import { test, expect } from "./helpers/test";

test.describe("error pages", () => {
  test("/404 renders PT-BR copy", async ({ page }) => {
    const res = await page.goto("/404");
    // Next renders the not-found.tsx component; status may be 404 or 200 depending on routing.
    expect([200, 404]).toContain(res?.status() ?? 0);
    await expect(page.getByText(/não encontrada/i)).toBeVisible();
  });

  test("/403 renders sem permissão", async ({ page }) => {
    await page.goto("/403");
    await expect(page.getByText(/sem permissão/i)).toBeVisible();
  });

  test("/500 renders erro interno", async ({ page }) => {
    await page.goto("/500");
    await expect(page.getByText(/erro interno/i)).toBeVisible();
  });

  test("/503 renders manutenção", async ({ page }) => {
    await page.goto("/503");
    await expect(page.getByText(/manutenção/i)).toBeVisible();
  });
});

/**
 * Os documentos legais moram aqui, e não numa spec nova, por dois motivos: esta
 * já navega deslogada (que é a condição sob teste) e já está declarada no
 * workflow — spec nova sem entrada em `.github/workflows/e2e.yml` reprova
 * `tests/unit/e2e-cobertura-completa.test.ts` no check obrigatório.
 *
 * O que se prova: o checkbox de aceite da PRIMEIRA tela do produto linka estes
 * dois endereços, e eles respondiam 404. Um aceite obrigatório apontando para o
 * vazio é o pior defeito de confiança que uma instalação nova pode ter.
 */
test.describe("documentos legais", () => {
  test("/legal/terms abre SEM sessão — é o que o aceite do onboarding linka", async ({ page }) => {
    const res = await page.goto("/legal/terms");
    expect(res?.status()).toBe(200);
    // E não é o login disfarçado: o proxy manda anônimo para /login?next=...
    expect(new URL(page.url()).pathname).toBe("/legal/terms");
    await expect(page.getByRole("heading", { name: /termos de uso/i })).toBeVisible();
  });

  test("/legal/privacy abre SEM sessão e nomeia o responsável", async ({ page }) => {
    const res = await page.goto("/legal/privacy");
    expect(res?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe("/legal/privacy");
    await expect(page.getByRole("heading", { name: /política de privacidade/i })).toBeVisible();
    // Sem sessão não dá para saber a razão social, mas o documento não pode
    // fingir que quem responde pelos dados é o projeto de software.
    await expect(page.getByText(/operador desta instalação/i).first()).toBeVisible();
  });

  test("o vizinho de /legal continua fechado — a liberação é dos dois, não do prefixo", async ({
    page,
  }) => {
    await page.goto("/legal/qualquer-outra");
    await expect(page).toHaveURL(/\/login/);
  });
});
