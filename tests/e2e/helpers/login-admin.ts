/**
 * Login de admin com MFA que sobrevive ao banco compartilhado.
 *
 * Duas coisas derrubam bateria inteira aqui, e nenhuma é bug de tela:
 *
 * 1. **O código TOTP não pode ser reusado.** Ele vale pela janela de 30 s, mas o
 *    servidor aceita cada um UMA vez (proteção contra replay). Testes que logam
 *    em sequência caem na mesma janela e mandam o mesmo código; o segundo é
 *    recusado. Por isso o último código enviado fica guardado no módulo.
 *
 * 2. **O segredo pode ter sido rotacionado por outra sessão.**
 *    `seed-e2e-credentials.ts` remove e reenrola o fator TOTP do admin, e várias
 *    frentes compartilham este Supabase local. Quando isso acontece no meio de
 *    uma execução, o `.e2e-creds.json` em disco aponta para um fator que não
 *    existe mais e todo login falha com "MFA falhou" — sintoma que lê como bug
 *    de senha, de relógio ou da tela de MFA. Medido nesta sessão: quatro vezes.
 *    A saída é re-semear UMA vez e tentar de novo, em vez de acusar a tela.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, type Page } from "@playwright/test";

import { generateTotp, msUntilNextTotpWindow } from "../utils/totp";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

export interface CredsE2E {
  password: string;
  users: Record<string, { email: string }>;
  admin_totp?: { secret: string; factor_id?: string };
  /** O fator do DONO DO SERVIDOR (`e2e-dono`), promovido a `platform_admins`. */
  dono_totp?: { secret: string; factor_id?: string };
  /**
   * O agente que o seed de credenciais cria. **É um `rag_bot`** — a tela de
   * configuração por papéis é do `mcp_agent`, então não serve para ela.
   */
  default_agent_id?: string;
  /** `mcp_agent` + versão criados por `scripts/seed-e2e-capacidades.ts`. */
  capacidades?: { agent_id: string; version_id: string };
}

export function lerCreds(): CredsE2E {
  if (!fs.existsSync(CREDS_PATH)) semearCredenciais();
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as CredsE2E;
}

/**
 * Re-semeia as credenciais **e reconstitui a cadeia que elas derrubam**.
 *
 * `seed-e2e-credentials.ts` reescreve o `.e2e-creds.json` INTEIRO. Os blocos
 * que os outros seeds acrescentam ao mesmo arquivo (`capacidades`, a credencial
 * de IA e a sessão de canal do follow-up) vão junto — e como este helper roda
 * no MEIO de um login, o efeito aparece longe da causa: um spec que já tinha
 * semeado sua fixture vê o campo sumir e falha dizendo "rode o seed antes",
 * logo depois de um seed que imprimiu sucesso. Medido nesta sessão, duas vezes.
 *
 * `seed-e2e-followup-agent` entra aqui porque é pré-requisito declarado de
 * `seed-e2e-capacidades` (que aborta com "Rode antes: …") e escreve no mesmo
 * arquivo. O bloco `capacidades` NÃO entra: nem todo spec precisa de um
 * `mcp_agent`, e quem precisa já o semeia — e precisa semear depois do login,
 * de qualquer forma.
 */
export function semearCredenciais(): CredsE2E {
  execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  execFileSync("npx", ["tsx", "scripts/seed-e2e-followup-agent.ts"], { stdio: "inherit" });
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as CredsE2E;
}

let ultimoCodigoEnviado: string | null = null;

async function tentarMfa(page: Page, secret: string, tentativas: number): Promise<boolean> {
  for (let i = 0; i < tentativas; i++) {
    if (msUntilNextTotpWindow() < 3_000 || generateTotp(secret) === ultimoCodigoEnviado) {
      await page.waitForTimeout(msUntilNextTotpWindow() + 300);
    }
    const codigo = generateTotp(secret);
    ultimoCodigoEnviado = codigo;

    const digito = page.locator('input[aria-label="Dígito 1"]');
    await digito.waitFor({ state: "visible", timeout: 15_000 });
    // O campo desabilita enquanto o código anterior é verificado.
    for (let espera = 0; espera < 20 && (await digito.isDisabled()); espera++) {
      await page.waitForTimeout(500);
    }
    await digito.click();
    await page.keyboard.type(codigo, { delay: 40 });
    try {
      await page.waitForURL(/\/app\//, { timeout: 10_000 });
      return true;
    } catch {
      await page.waitForTimeout(msUntilNextTotpWindow() + 300);
    }
  }
  return false;
}

/**
 * Loga como admin. Devolve as credenciais em vigor — que podem ter sido
 * re-semeadas no meio do caminho, e nesse caso são diferentes das que o chamador
 * tinha em mãos.
 */
/**
 * `admin` é administrador de ORGANIZAÇÃO; `dono` é o administrador da
 * INSTALAÇÃO (o seed o promove a `platform_admins`). São superfícies
 * diferentes, e confundi-las faz um teste medir o gate errado — foi o que me
 * aconteceu: a spec do painel logava como `admin` e concluía que a porta do
 * modo administrador não aparecia. Ela NÃO deve aparecer para ele.
 */
export type PapelDeLogin = "admin" | "dono";

export async function loginComoAdmin(page: Page, creds: CredsE2E): Promise<CredsE2E> {
  return loginComoPapel(page, creds, "admin");
}

/** O DONO DO SERVIDOR — quem alcança `/admin/**`. */
export async function loginComoDono(page: Page, creds: CredsE2E): Promise<CredsE2E> {
  return loginComoPapel(page, creds, "dono");
}

export async function loginComoPapel(
  page: Page,
  creds: CredsE2E,
  papel: PapelDeLogin,
): Promise<CredsE2E> {
  let atuais = creds;

  for (let volta = 0; volta < 2; volta++) {
    const usuario = papel === "dono" ? atuais.users.dono : atuais.users.admin;
    const fator = papel === "dono" ? atuais.dono_totp : atuais.admin_totp;
    expect(
      usuario?.email,
      `sem \`${papel}\` em \`users\` do .e2e-creds.json — rode seed-e2e-credentials.ts`,
    ).toBeTruthy();
    expect(
      fator?.secret,
      `sem \`${papel}_totp\` no .e2e-creds.json — rode seed-e2e-credentials.ts`,
    ).toBeTruthy();

    await page.goto("/login");
    await page.locator("#email").fill(usuario!.email);
    await page.locator("#password").fill(atuais.password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL(/\/login\/mfa/, { timeout: 30_000 });

    if (await tentarMfa(page, fator!.secret, 3)) return atuais;

    if (volta === 0) {
      // O segredo em disco não vale mais: outra sessão rodou o seed. Re-semeia
      // UMA vez e tenta de novo — na segunda falha o problema é outro e o teste
      // deve morrer dizendo isso, em vez de re-semear em círculo.
      atuais = semearCredenciais();
      ultimoCodigoEnviado = null;
    }
  }

  expect(
    false,
    "MFA falhou mesmo depois de re-semear as credenciais — o problema não é o fator rotacionado",
  ).toBe(true);
  return atuais;
}
