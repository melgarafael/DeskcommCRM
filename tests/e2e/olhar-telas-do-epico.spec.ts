/**
 * OLHAR as telas que o épico produziu — não "testar o encanamento delas".
 *
 * Por que existe: medido em `dffa823a`, o app tem 47 telas e 24 delas não
 * aparecem em spec nenhum. Entre as descobertas estavam telas DO PRÓPRIO
 * ÉPICO — entregamos capacidades de acervo e nunca abrimos a tela de acervo,
 * fechamos o ciclo IA↔humano e a caixa onde o humano recebe o chamado não tinha
 * teste de tela.
 *
 * O que este spec cobra é o mínimo que ninguém tinha cobrado: a tela ABRE, tem
 * conteúdo legível, e não cospe erro no console. Não é sofisticado de propósito
 * — o defeito que ele caça é "tela em branco", "500 em produção" e "erro de
 * runtime que só aparece no build de produção", que é justamente o que passa
 * despercebido quando só se testa o caminho feliz com estado semeado.
 *
 * Uma tela sadia provada TAMBÉM é resultado: a captura fica versionada.
 */
import { test, expect } from "./helpers/test";
import fs from "node:fs";
import path from "node:path";
import { afirmarAdminDeTenantPuro } from "./utils/precondicao";
import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence", "ia-360-w5");

interface Creds {
  password: string;
  users: { admin?: { email: string } };
  admin_totp?: { secret: string };
}

/** Telas do épico que estavam SEM cobertura alguma na medição de `dffa823a`. */
const TELAS = [
  { rota: "/app/ai/knowledge/sources", nome: "acervo-de-conhecimento", dono: "W5" },
  { rota: "/app/ai/skills", nome: "habilidades", dono: "W5" },
  { rota: "/app/ai/memory", nome: "memoria-da-organizacao", dono: "W5" },
  { rota: "/app/ai/usage", nome: "consumo", dono: "W1" },
  { rota: "/app/ai/inbox", nome: "caixa-do-humano", dono: "W3" },
  { rota: "/app/ai/routers", nome: "roteadores", dono: "W3" },
  { rota: "/app/ai/agents/new", nome: "criar-agente", dono: "W1" },
] as const;

let creds: Creds;

test.beforeAll(async () => {
  expect(fs.existsSync(CREDS_PATH), "rode scripts/seed-e2e-credentials.ts").toBe(true);
  creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  // ── Precondição de identidade ──────────────────────────────────────────────
  // Este arquivo afirma ALCANCE: que estas telas abrem para uma pessoa. Alcance
  // medido com um usuário promovido a dono do servidor seria alcance emprestado.
  //
  // ⚠️ Medido: as 7 rotas de `TELAS` são todas `/app/ai/*`, gateadas em
  // `ROLE_RANK < manager` — um admin de tenant já passa por rank, e a promoção
  // não muda o desfecho hoje. Ela mudaria no instante em que a lista ganhasse
  // uma tela exclusiva do dono (`/app/settings/atualizacao` faz `notFound()` sem
  // a flag), e é esse acréscimo silencioso que a precondição barra.
  await afirmarAdminDeTenantPuro(creds.users.admin!.email);
});

test.describe("as telas do épico abrem para uma pessoa", () => {
  test.describe.configure({ timeout: 180_000 });

  test("cada tela abre, tem conteúdo e não cospe erro no console", async ({ page }) => {
    const erros: string[] = [];
    // A URL entra no registro porque sem ela o achado é indiagnosticável: a
    // mensagem do browser para uma requisição barrada é "Failed to load resource:
    // the server responded with a status of 429", sem dizer QUEM respondeu. Uma
    // reprovação assim custou uma investigação inteira no CI — o relatório não
    // guarda trace, então a única cópia do endereço morria aqui.
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const onde = m.location().url;
      erros.push(`${m.text().slice(0, 200)}${onde ? ` @ ${onde}` : ""}`);
    });
    page.on("pageerror", (e) => erros.push(`PAGEERROR: ${String(e).slice(0, 200)}`));

    // Login REAL pela tela, com MFA — não injeção de sessão.
    await page.goto("/login");
    await page.locator("#email").fill(creds.users.admin!.email);
    await page.locator("#password").fill(creds.password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL(/\/login\/mfa/, { timeout: 30_000 });
    // Espera a janela virar: um código gerado no fim da janela expira durante a
    // digitação e o sintoma é "MFA falhou", que não parece o que é.
    await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    await page.locator('input[aria-label="Dígito 1"]').click();
    await page.keyboard.type(generateTotp(creds.admin_totp!.secret), { delay: 60 });
    await page.waitForURL(/\/app\//, { timeout: 30_000 });

    const quebradas: string[] = [];

    for (const tela of TELAS) {
      erros.length = 0;
      const resp = await page.goto(tela.rota, { waitUntil: "networkidle" });
      await page.waitForTimeout(800);

      const status = resp?.status() ?? 0;
      const texto = (await page.locator("body").innerText().catch(() => ""))
        .replace(/\s+/g, " ")
        .trim();

      await page.screenshot({
        path: path.join(EVIDENCIA, `tela-${tela.nome}.png`),
        fullPage: true,
      });

      // O que conta como quebrada: HTTP ruim, tela sem conteúdo legível, ou
      // erro de runtime. 120 chars é baixo de propósito — uma tela vazia de
      // verdade tem só o menu; qualquer conteúdo real passa disso com folga.
      if (status >= 400) quebradas.push(`${tela.rota} [${tela.dono}]: HTTP ${status}`);
      else if (texto.length < 120) {
        quebradas.push(`${tela.rota} [${tela.dono}]: só ${texto.length} chars — tela em branco`);
      }
      if (erros.length > 0) {
        quebradas.push(`${tela.rota} [${tela.dono}]: console → ${erros.slice(0, 2).join(" | ")}`);
      }
    }

    expect(quebradas, `telas do épico com problema:\n  ${quebradas.join("\n  ")}`).toEqual([]);
  });
});
