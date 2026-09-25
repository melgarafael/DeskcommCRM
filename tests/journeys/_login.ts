/**
 * Login de admin com MFA — UMA cópia, porque três não sobreviveram ao contato com
 * a realidade.
 *
 * Este helper existia copiado em `canais-baseline`, `templates-screen` e
 * `canal-oficial`. Ao consertar dois defeitos reais do laço de TOTP, o conserto
 * entrou em UMA das cópias; as outras duas seguiram quebrando — e falharam de novo
 * assim que as jornadas passaram a rodar juntas. Copiar um helper não duplica o
 * código: duplica o defeito, e divide o conserto.
 *
 * Os dois defeitos, ambos medidos com o app carregado na tela:
 *
 *   1. **Não percebia o sucesso da tentativa anterior.** Se o MFA já tinha passado,
 *      o campo de dígito não existe mais, e `click()` fica esperando até o timeout
 *      do teste inteiro. Daí o `if` de saída no topo do laço.
 *   2. **Janela de espera curta demais.** Com 10s, a validação do MFA sob carga
 *      passa do prazo, o laço re-digita num campo que já sumiu e cai no defeito 1
 *      pela outra ponta. 30s é folga para a carga, não para o TOTP — a janela do
 *      código continua sendo respeitada por `msUntilNextTotpWindow()`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { Page } from "@playwright/test";

import { generateTotp, msUntilNextTotpWindow } from "../e2e/utils/totp";

export interface E2eCreds {
  /** A org semeada por `scripts/seed-e2e-credentials.ts` — as jornadas filtram por ela. */
  org_id: string;
  password: string;
  users: Record<string, { email: string } | undefined>;
  admin_totp?: { secret: string };
}

export function lerCreds(): E2eCreds {
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), ".e2e-creds.json"), "utf8"),
  ) as E2eCreds;
}

const JA_LOGADO = /\/(app|onboarding)\//;

/**
 * Último código TOTP enviado NESTE worker.
 *
 * Um código de 30s é de uso único: o GoTrue recusa o segundo envio como replay, o
 * app limpa a sessão e volta para `/login` — que é a foto que a falha produzia.
 * Isolada, cada jornada passava; em série, a segunda caía na mesma janela da
 * primeira. O sintoma ("o campo de dígito não aparece") apontava para o lugar
 * errado: o campo não aparecia porque nem estávamos mais na tela de MFA.
 */
let ultimoCodigo: string | null = null;

export async function loginAdmin(page: Page): Promise<void> {
  const creds = lerCreds();
  const secret = creds.admin_totp?.secret;
  if (!secret) {
    throw new Error(".e2e-creds.json sem admin_totp — rode scripts/seed-e2e-credentials.ts");
  }

  await page.goto("/login");
  await page.locator("#email").fill(creds.users.admin!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/login\/mfa/, { timeout: 30_000 });

  for (let tentativa = 0; tentativa < 3; tentativa++) {
    // Defeito 1: a tentativa anterior pode ter passado enquanto esperávamos.
    if (JA_LOGADO.test(page.url())) return;

    if (msUntilNextTotpWindow() < 3_000) await page.waitForTimeout(msUntilNextTotpWindow() + 200);

    // Espera a próxima janela em vez de reenviar um código já queimado.
    let codigo = generateTotp(secret);
    if (codigo === ultimoCodigo) {
      await page.waitForTimeout(msUntilNextTotpWindow() + 500);
      codigo = generateTotp(secret);
    }
    ultimoCodigo = codigo;

    await page.locator('input[aria-label="Dígito 1"]').click({ timeout: 15_000 });
    await page.keyboard.type(codigo, { delay: 40 });
    try {
      // Defeito 2: 30s, não 10s.
      await page.waitForURL(JA_LOGADO, { timeout: 30_000 });
      return;
    } catch {
      if (JA_LOGADO.test(page.url())) return;
      await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    }
  }
  throw new Error("MFA falhou após 3 tentativas de TOTP");
}
