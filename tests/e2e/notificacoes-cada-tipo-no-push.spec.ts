/**
 * CADA AVISO DO CELULAR LIGA E DESLIGA SOZINHO — provado pela tela.
 *
 * ## O defeito que ele guarda
 *
 * Até 09/11/2026 o Push de "Nova mensagem" era o interruptor do aparelho:
 * desligá-lo encerrava a inscrição (DELETE) e travava os outros interruptores,
 * porque o servidor não sabia quais tipos cada aparelho queria. Um usuário que
 * só queria "Lead atribuído a você" recebeu 7 avisos num atendimento e não
 * tinha como ficar só com o que pediu.
 *
 * Agora a inscrição leva os tipos calados (`push_subscriptions.tipos_calados`),
 * e o aparelho só sai do push quando todos estão desligados.
 *
 * ## O que é dublê, e por quê
 *
 * O Chromium do Playwright em headless responde `denied` para
 * `Notification.permission` sempre (medido em `notificacoes-diz-o-que-falta`),
 * e a inscrição real depende do serviço de push do navegador (FCM), que não
 * existe no runner. Por isso a PERMISSÃO e o `PushManager` do navegador são
 * dublados no `addInitScript`. Todo o resto é de verdade: a tela, a rota
 * `/api/v1/notifications/push`, a sessão e o banco.
 *
 * Sem o par VAPID (o estado do CI), a inscrição para antes do PUT
 * (`sem_vapid`): aí o spec prova a TELA e a ausência do DELETE. Com o par (uma
 * máquina com VAPID no `.env.e2e`), prova também o corpo do PUT e a resposta.
 *
 * Pré-requisitos: os mesmos de `notificacoes-diz-o-que-falta.spec.ts`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "./helpers/test";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence/notificacoes-cada-tipo-no-push");
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/e2e-cada-tipo-no-push";

interface Creds {
  password: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

/** Sem MFA: ver o porquê em `notificacoes-diz-o-que-falta.spec.ts`. */
const PAPEL_SEM_MFA = "agent";

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

/** Permissão concedida e um `PushManager` que inscreve sem falar com o FCM. */
async function navegadorComPush(page: Page): Promise<void> {
  await page.addInitScript((endpoint) => {
    Object.defineProperty(Notification, "permission", { get: () => "granted" });
    Notification.requestPermission = async () => "granted";
    const w = window as unknown as { __inscricao: unknown };
    w.__inscricao = null;
    PushManager.prototype.getSubscription = async function () {
      return w.__inscricao as PushSubscription | null;
    };
    PushManager.prototype.subscribe = async function () {
      const sub = {
        endpoint,
        options: { applicationServerKey: null },
        toJSON: () => ({ endpoint, keys: { p256dh: "chave-e2e", auth: "auth-e2e" } }),
        unsubscribe: async () => {
          w.__inscricao = null;
          return true;
        },
      };
      w.__inscricao = sub;
      return sub as unknown as PushSubscription;
    };
  }, ENDPOINT);
}

test.describe("Notificações — cada tipo tem o seu Push", () => {
  test.describe.configure({ timeout: 120_000 });
  // O service worker é real (o `PushManager` dele é que é dublado): o padrão da
  // suíte o bloqueia, e sem ele a inscrição para em `sem_service_worker`.
  test.use({ serviceWorkers: "allow" });

  test("desligar «Nova mensagem» não desliga o aparelho nem «Lead atribuído a você»", async ({ page }) => {
    const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    const quem = creds.users[PAPEL_SEM_MFA]!;
    await navegadorComPush(page);
    await login(page, quem.email, creds.password);

    const cfg = await page.request.get("/api/v1/notifications/push");
    const comVapid = ((await cfg.json()) as { data?: { enabled?: boolean } }).data?.enabled === true;

    const pedidos: Array<{ metodo: string; corpo: unknown; status: number }> = [];
    page.on("response", async (res) => {
      const req = res.request();
      if (!req.url().endsWith("/api/v1/notifications/push") || req.method() === "GET") return;
      pedidos.push({ metodo: req.method(), corpo: req.postDataJSON(), status: res.status() });
    });

    await page.goto("/app/settings/notifications");
    await expect(page.getByRole("heading", { name: "Notificações" })).toBeVisible();
    const push = (rotulo: string) => page.getByRole("switch", { name: `${rotulo} via push`, exact: true });

    // Os dois tipos que antes não se podiam calar estão na tela, só com Push.
    await expect(push("A IA passou uma conversa para a equipe")).toBeVisible();
    await expect(push("Negócio entrou numa etapa que avisa")).toBeVisible();
    await expect(page.getByRole("switch", { name: "A IA passou uma conversa para a equipe via in_app" })).toHaveCount(0);
    await captura(page, "01-antes");

    // Desliga o de mensagem, a passagem e a etapa: fica só o que o usuário pediu.
    for (const rotulo of ["Nova mensagem", "A IA passou uma conversa para a equipe", "Negócio entrou numa etapa que avisa"]) {
      await push(rotulo).click();
      await expect(push(rotulo)).toHaveAttribute("aria-checked", "false");
    }

    const lead = push("Lead atribuído a você");
    await expect(lead).toHaveAttribute("aria-checked", "true");
    await expect(lead).toBeEnabled();
    await expect(page.getByText(/Cada aviso liga e desliga sozinho no Push/)).toBeVisible();
    await captura(page, "02-so-lead-atribuido");

    // O aparelho NÃO saiu do push: nenhum DELETE da inscrição.
    expect(pedidos.filter((p) => p.metodo === "DELETE")).toEqual([]);

    if (comVapid) {
      // Cada clique regrava a inscrição; espera a gravação do último estado.
      const calados = (p: { corpo: unknown }) =>
        [...((p.corpo as { tipos_calados?: string[] }).tipos_calados ?? [])].sort().join(",");
      await expect
        .poll(() => pedidos.filter((p) => p.metodo === "PUT").map(calados), { timeout: 15_000 })
        .toContain("handoff,message,stage_alert");
      const ultimo = pedidos.find((p) => p.metodo === "PUT" && calados(p) === "handoff,message,stage_alert")!;
      expect(ultimo.status).toBe(200);
      expect((ultimo.corpo as { endpoint: string }).endpoint).toBe(ENDPOINT);
    }

    // Recarregar mantém a escolha (ela é do aparelho).
    await page.reload();
    await expect(push("Nova mensagem")).toHaveAttribute("aria-checked", "false");
    await expect(push("Lead atribuído a você")).toHaveAttribute("aria-checked", "true");
  });
});
