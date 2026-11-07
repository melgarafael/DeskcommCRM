/**
 * Atualização self-service pela UI (doutrina de QA visual, DoD 12) — prova
 * pela TELA, como o dono da instalação faria. O agente do host (`agent.sh`,
 * task 8) é simulado por requisições `POST /api/v1/system/agent` assinadas
 * com o mesmo segredo que ele usaria de verdade: o que se prova aqui é a
 * experiência na tela (rodapé → aviso → clique → progresso → desfecho), não
 * o bash em si — esse é provado na VPS (ver o brief da task).
 *
 * ═══ QUEM É O DONO AQUI, E POR QUE NÃO É O `e2e-admin` ═══
 *
 * O dono do servidor desta spec é `e2e-dono@deskcomm.test`, um usuário
 * DEDICADO. Antes ele era o `e2e-admin`, que 10 outras specs usam como *admin
 * de tenant* — e como nenhum seed revogava a promoção e as duas partes do job
 * `e2e` compartilham banco sem reset, a parte 2 inteira herdava um admin com
 * escape de plataforma. O escape abre justamente a tela que ESTA spec mede
 * (`app/app/settings/atualizacao/page.tsx:16` faz `notFound()` sem a flag) e o
 * `/admin/*` inteiro; a medição do que muda e do que NÃO muda está em
 * `tests/e2e/utils/precondicao.ts`.
 *
 * Trocar de usuário remove a CAUSA. Limpar depois não serviria: `afterAll` não
 * roda quando a spec estoura.
 *
 * Pré-requisitos:
 * - `.e2e-creds.json` (o spec roda `seed-e2e-credentials.ts` sozinho se
 *   ausente/incompleto, como `rbac-roles.spec.ts`) + `seed-e2e-system-update.ts`
 *   (promove o usuário `dono` do seed a dono do servidor via `platform_admins`
 *   — é uma superfície diferente do role de organização —, REVOGA a promoção do
 *   `admin` e limpa `system_version`/`system_update_runs` pra não colidir com o
 *   índice único de run em andamento).
 * - `INTERNAL_SECRET` no ambiente do Playwright (o segredo que autentica o
 *   agente do host em `/api/v1/system/agent`). Sem ele, o heartbeat simulado
 *   nem autenticaria — o arquivo INTEIRO pula em vez de falhar por motivo
 *   errado (ausência de ambiente ≠ defeito).
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import type { RuntimeConfirmation } from "../../lib/system/runtime-identity";
import type { Database } from "../../lib/database.types";
import { confirmedRuntime } from "../helpers/runtime-confirmation";

import { test, expect, type Page, type APIRequestContext } from "./helpers/test";

import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const SECRET = process.env.INTERNAL_SECRET ?? "";

test.skip(
  !SECRET,
  "INTERNAL_SECRET ausente no ambiente do Playwright — o heartbeat simulado do agente do host não teria como autenticar.",
);

interface E2ECreds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
  admin_totp?: { factor_id: string; secret: string };
  dono_totp?: { factor_id: string; secret: string };
}

function loadCreds(): E2ECreds {
  const needsSeed = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as E2ECreds;
    // `dono` entra na condição junto com `agent`: um `.e2e-creds.json` gerado
    // antes do quinto usuário existir passaria no teste antigo e faria o seed
    // seguinte estourar com "creds.users.dono ausente".
    return !c.users?.agent || !c.users?.dono || !c.admin_totp?.secret || !c.dono_totp?.secret;
  };
  if (needsSeed()) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  // Dono do servidor (platform_admins) + system_version/system_update_runs
  // limpos — idempotente, roda sempre pra deixar o teste repetível.
  execFileSync("npx", ["tsx", "scripts/seed-e2e-system-update.ts"], { stdio: "inherit" });
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as E2ECreds;
}

// Só carrega/seeda de verdade quando o teste vai rodar — sem SECRET, o arquivo
// inteiro já pulou acima, e chamar isto seria trabalho (e risco de falha de
// banco) para um teste que nunca vai executar.
const creds: E2ECreds = SECRET ? loadCreds() : ({ password: "", users: {} } as E2ECreds);

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//);
}

async function loginWithTotp(
  page: Page,
  email: string,
  secret: string,
  antesDeMfa?: () => Promise<void>,
): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/login\/mfa/);
  await antesDeMfa?.();

  // Até 2 tentativas: um código pode expirar na borda da janela de 30s.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (msUntilNextTotpWindow() < 3_000) {
      await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    }
    const code = generateTotp(secret);
    const firstDigit = page.locator('input[aria-label="Dígito 1"]');
    await firstDigit.click();
    await page.keyboard.type(code, { delay: 40 });
    try {
      await page.waitForURL(/\/app\//, { timeout: 8_000 });
      return;
    } catch {
      // código rejeitado — espera a próxima janela e tenta de novo
      await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    }
  }
  throw new Error("MFA challenge failed after 2 TOTP attempts");
}

interface HeartbeatResponse {
  data: { update_requested: boolean; run_id: string | null };
}

/** Simula um ciclo do `agent.sh` real: mesmo endpoint, mesmo bearer. */
async function heartbeat(
  request: APIRequestContext,
  opts: {
    latest_version: string;
    current_version?: string;
    changelog?: string;
    off_release?: boolean;
    compare_failed?: boolean;
    has_known_release?: boolean;
    supports_forced_update?: boolean;
    runtime_confirmation?: RuntimeConfirmation | null;
  },
): Promise<HeartbeatResponse> {
  const res = await request.post("/api/v1/system/agent", {
    headers: { Authorization: `Bearer ${SECRET}` },
    data: {
      kind: "heartbeat",
      current_version: opts.current_version ?? "1.0.0",
      current_sha: "abc1234",
      off_release: opts.off_release ?? false,
      latest_version: opts.latest_version,
      compare_failed: opts.compare_failed ?? false,
      has_known_release: opts.has_known_release ?? true,
      changelog: opts.changelog ?? "",
      // Omissão continua omissão: um helper do disco não anuncia pelo agente.
      ...(opts.supports_forced_update === undefined
        ? {}
        : { supports_forced_update: opts.supports_forced_update }),
      ...(opts.runtime_confirmation === undefined
        ? {}
        : { runtime_confirmation: opts.runtime_confirmation }),
    },
  });
  expect(res.status()).toBe(200);
  return res.json();
}

/** Readback pela sessão real do navegador, sem bearer nem interceptação. */
async function estadoDaTela(page: Page) {
  const res = await page.request.get("/api/v1/system/version");
  expect(res.status()).toBe(200);
  return (await res.json()).data;
}

/** Desfecho reportado pelo agente, como o `agent.sh` faz ao fim do update.sh. */
async function runResult(
  request: APIRequestContext,
  runId: string,
  status: "success" | "failed" | "failed_rolled_back",
  logTail = "",
): Promise<void> {
  const res = await request.post("/api/v1/system/agent", {
    headers: { Authorization: `Bearer ${SECRET}` },
    data: { kind: "run_result", run_id: runId, status, log_tail: logTail },
  });
  expect(res.status()).toBe(200);
}

/** Passo concluído, como o `report()` do update.sh faz enquanto o app está de pé. */
async function runProgress(
  request: APIRequestContext,
  runId: string,
  step: "backup" | "codigo" | "banco",
): Promise<void> {
  const res = await request.post("/api/v1/system/agent", {
    headers: { Authorization: `Bearer ${SECRET}` },
    data: { kind: "run_progress", run_id: runId, step },
  });
  expect(res.status()).toBe(200);
}

/** Volta o estado da instalação ao zero (sem run nenhum), como um seed. */
function resetEstado(): void {
  execFileSync("npx", ["tsx", "scripts/seed-e2e-system-update.ts"], { stdio: "inherit" });
}

test("quem pula versões vê os avisos de TODAS elas, não só o da mais nova", async ({
  page,
  request,
}) => {
  // O defeito que este caso guarda: a tela mostrava só a seção da versão-alvo.
  // Quem estava na 1.0.0 e ia para a 1.2.0 nunca lia a 1.1.0 — e no caso real
  // (commit ac9472c5) a versão do meio trazia uma instrução para o operador
  // apagar a conexão que estava funcionando.
  const changelog = [
    "## [1.2.0] — 2026-08-03",
    "",
    "**⚠️ Requer atenção**",
    "",
    "Rode o comando de migração antes.",
    "",
    "### Adicionado",
    "",
    "- Coisa da versão nova.",
    "",
    "## [1.1.0] — 2026-08-02",
    "",
    "**⚠️ Requer atenção**",
    "",
    "Reconecte o número depois.",
    "",
    "### Corrigido",
    "",
    "- Conserto da versão do meio.",
    "",
    "## [1.0.0] — 2026-08-01",
    "",
    "- Primeira versão.",
    "",
  ].join("\n");

  await loginWithTotp(page, creds.users.dono!.email, creds.dono_totp!.secret);
  await heartbeat(request, { latest_version: "1.2.0", current_version: "1.0.0", changelog });
  await page.goto("/app/settings/atualizacao");

  // Os DOIS avisos visíveis, o da alvo e o da versão do meio, cada um nomeando
  // de onde veio.
  await expect(page.getByText(/Rode o comando de migração antes/)).toBeVisible();
  await expect(page.getByText(/Reconecte o número depois/)).toBeVisible();
  await expect(page.getByText(/Da versão 1\.1\.0/)).toBeVisible();

  // E os dois ANTES do botão — medido por ferramenta, nunca a olho: aviso que
  // aparece depois do clique não é aviso.
  const y = async (rx: RegExp) => (await page.getByText(rx).boundingBox())!.y;
  const botao = (await page.getByRole("button", { name: /atualizar agora/i }).boundingBox())!.y;
  expect(await y(/Rode o comando de migração antes/)).toBeLessThan(botao);
  expect(await y(/Reconecte o número depois/)).toBeLessThan(botao);

  // O corpo da versão-alvo fica aberto; o da intermediária, recolhido. Texto
  // dentro de um `<details>` FECHADO não é visível para o Playwright, então o
  // caso abre e prova pelo estado real do elemento — e nunca põe um AVISO ali
  // dentro, que é o defeito que esta tela existe para consertar.
  await expect(page.getByText(/Coisa da versão nova/)).toBeVisible();
  const recolhido = page.locator("details", { hasText: "Versão 1.1.0" });
  await recolhido.locator("summary").click();
  await expect(recolhido).toHaveJSProperty("open", true);
  await expect(page.getByText(/Conserto da versão do meio/)).toBeVisible();

  await page.screenshot({ path: "evidence/faixa-de-versoes.png" });
});

test("o dono vê a versão nova na sidebar e atualiza pela tela", async ({ page, request }) => {
  const changelog =
    "## [1.1.0] — 2026-08-02\n\n**⚠️ Requer atenção**\n\nReconecte o número depois.\n\n### Adicionado\n\n- Botão de atualizar pela tela.\n";

  await loginWithTotp(page, creds.users.dono!.email, creds.dono_totp!.secret);
  await heartbeat(request, { latest_version: "1.1.0", changelog });
  await page.goto("/app/inbox");

  const aviso = page.getByRole("link", { name: /nova versão/i });
  await expect(aviso).toBeVisible();
  await aviso.click();
  await page.waitForURL(/\/app\/settings\/atualizacao/);

  await expect(page.getByRole("heading", { name: /versão 1\.1\.0 disponível/i })).toBeVisible();
  await expect(page.getByText(/Reconecte o número depois/)).toBeVisible();
  await expect(page.getByText(/Botão de atualizar pela tela/)).toBeVisible();
  await page.screenshot({ path: "evidence/task9-1-tem-novidade.png" });

  // O bloco de atenção precisa vir ANTES do botão na ordem visual — medido
  // por ferramenta (boundingBox), nunca a olho: quem precisa agir à mão (ex.:
  // reconectar o número) tem que ver isso ANTES de clicar, não descobrir depois.
  const atencao = await page.getByText(/Reconecte o número depois/).boundingBox();
  const botao = await page.getByRole("button", { name: /atualizar agora/i }).boundingBox();
  expect(atencao).not.toBeNull();
  expect(botao).not.toBeNull();
  expect(atencao!.y).toBeLessThan(botao!.y);

  await page.getByRole("button", { name: /atualizar agora/i }).click();

  // ── PONTA 1: o clique NÃO começa a atualização ──────────────────────────
  //
  // O `POST /update` só registra o pedido; quem executa é o `agent.sh`, que
  // roda de 5 em 5 minutos no host. Este caso AFIRMAVA o defeito: esperava a
  // lista de passos ("Guardando uma cópia de segurança") logo depois do clique
  // — a tela dizia que o sistema estava trabalhando quando ele ainda nem tinha
  // recebido a ordem, e ficava assim, imóvel, por até cinco minutos.
  await expect(
    page.getByRole("heading", { name: /pedido enviado/i }),
    "logo após o clique a tela ainda afirma que está atualizando",
  ).toBeVisible();
  await expect(page.getByText(/ficar parada nesse tempo é normal/i)).toBeVisible();
  await expect(page.getByTestId("espera-decorrida")).toBeVisible();
  await page.screenshot({ path: "evidence/task9-2a-pedido-enviado.png" });

  // O agente do host detecta o pedido no próximo heartbeat...
  const { data } = await heartbeat(request, { latest_version: "1.1.0" });
  expect(data.update_requested).toBe(true);
  expect(data.run_id).not.toBeNull();

  // ...e aí sim a lista de passos aparece, porque aí sim há um passo.
  await runProgress(request, data.run_id!, "backup");
  // ⏱️ 20s, e não os 5s do padrão. ESTE é o único ponto do arquivo em que a tela
  // descobre a mudança pelo POLL, sem recarga — e o poll é de 5 segundos
  // (`useSystemVersion({ refetchInterval: 5_000 })`). Timeout de 5s contra ciclo
  // de 5s é cara ou coroa: passou nas rodadas de CI de 16:25 e 16:54 e reprovou
  // na de 17:21, sem ninguém tocar neste teste entre elas. As demais asserções
  // do arquivo vêm depois de `page.reload()`, onde o dado já chega na carga.
  await expect(
    page.getByRole("heading", { name: /atualizando para a versão 1\.1\.0/i }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Guardando uma cópia de segurança/)).toBeVisible({
    timeout: 20_000,
  });
  await page.screenshot({ path: "evidence/task9-2b-atualizando.png" });

  // ...executa (fora deste teste — é o `agent.sh`/`update.sh` reais, provados
  // na task 8) e reporta o desfecho.
  await runResult(request, data.run_id!, "success", "ok");

  // ── PONTA 2: terminou, e o host ainda não teve chance de contar ─────────
  //
  // `run_result` fecha o run e NÃO escreve `current_version` — quem escreve é o
  // heartbeat, até 5 minutos depois. Sem o conserto, esta recarga trazia de
  // volta "Versão 1.1.0 disponível" e o botão "Atualizar agora", oferecendo a
  // versão que acabou de ser instalada. Repare que NENHUM heartbeat foi enviado
  // entre o `run_result` e esta linha: é exatamente a janela do defeito.
  //
  // E a tela NÃO pode preencher esse silêncio afirmando a 1.1.0: o host nunca
  // confirmou essa versão. O que ela diz é que o pedido terminou e que a última
  // versão confirmada pelo host é a 1.0.0 — que é a que está no ar até ele
  // falar.
  await page.reload();
  await expect(
    page.getByRole("heading", { name: /a atualização para a versão 1\.1\.0 terminou/i }),
    "a tela voltou oferecendo a versão que acabou de ser instalada",
  ).toBeVisible();
  await expect(page.getByText(/a última versão que ele confirmou é a 1\.0\.0/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /atualizar agora/i })).toHaveCount(0);
  await page.screenshot({ path: "evidence/task9-3a-acabou-de-atualizar.png" });

  // E quando o host finalmente confirma, a janela se fecha sozinha: volta o
  // texto normal de quem está em dia, sem ninguém limpar estado nenhum.
  await heartbeat(request, { current_version: "1.1.0", latest_version: "1.1.0" });
  await page.reload();
  await expect(page.getByRole("heading", { name: /^você está na versão 1\.1\.0/i })).toBeVisible();
  await page.screenshot({ path: "evidence/task9-3b-em-dia.png" });
});

test("quando a atualização falha, a tela nomeia a versão certa, mostra o log e dá saída", async ({
  page,
  request,
}) => {
  // Duas falhas encadeadas num só percurso — é o mesmo dono, na mesma sessão,
  // vendo o pior dia da instalação dele.
  test.setTimeout(120_000);
  resetEstado();
  await heartbeat(request, { current_version: "1.0.0", latest_version: "1.1.0" });
  await loginWithTotp(page, creds.users.dono!.email, creds.dono_totp!.secret, async () => {
    await test.step("força exige o MFA desta sessão antes de criar um pedido", async () => {
      await expect(page.getByLabel("Dígito 1", { exact: true })).toBeVisible();
      expect((await estadoDaTela(page)).run).toBeNull();
      const recusa = await page.request.post("/api/v1/system/update", { data: { force: true } });
      expect(recusa.status()).toBe(403);
      expect((await recusa.json()).error.code).toBe("mfa_required");
      expect((await estadoDaTela(page)).run).toBeNull();
      await page.screenshot({ path: "evidence/forca-runtime-mfa.png" });
    }, { timeout: 5_000 });
  });
  await page.goto("/app/settings/atualizacao");
  await page.getByRole("button", { name: /atualizar agora/i }).click();
  // ⛔ NÃO é "Atualizando para a versão 1.1.0". O clique registra um PEDIDO; quem
  // executa é o agente no host, que confere de poucos em poucos minutos — e a
  // tela passou a dizer isso com todas as letras em vez de afirmar trabalho que
  // ainda não começou. A versão de destino continua nomeada, que é o que este
  // teste vigia.
  await expect(page.getByRole("heading", { name: /pedido enviado/i })).toBeVisible();
  await expect(page.getByText(/Anotei o pedido de atualizar para a versão/)).toContainText("1.1.0");

  // ── Falha COM rollback ─────────────────────────────────────────────────────
  const primeiro = await heartbeat(request, { latest_version: "1.1.0" });
  await runProgress(request, primeiro.data.run_id!, "banco");
  await runResult(
    request,
    primeiro.data.run_id!,
    "failed_rolled_back",
    "▶ Conferindo se o app voltou no ar\n⚠ Atualizei, mas o app não respondeu 'ok'.",
  );
  // O host reporta o `git describe` DEPOIS do checkout: para ele, a versão
  // instalada é a 1.1.0 — a que acabou de quebrar. É esta mentira que a tela
  // repetia ("Voltei para a versão anterior (1.1.0)") e que o run desfaz.
  await heartbeat(request, { current_version: "1.1.0", latest_version: "1.1.0" });
  await page.reload();

  await expect(
    page.getByRole("heading", { name: /a atualização para a versão 1\.1\.0 não deu certo/i }),
  ).toBeVisible();
  await expect(page.getByText(/Voltei o sistema para a versão 1\.0\.0/)).toBeVisible();

  // O log só existe se der pra ler: recolhido, mas presente e abrível.
  const detalhes = page.getByText(/Detalhes técnicos/);
  await expect(detalhes).toBeVisible();
  await expect(page.getByText(/o app não respondeu 'ok'/)).toBeHidden();
  await detalhes.click();
  await expect(page.getByText(/o app não respondeu 'ok'/)).toBeVisible();

  // O aviso da sidebar só acende porque o app sabe que está rodando a 1.0.0 —
  // se ele tivesse acreditado no "1.1.0" que o host reportou, `update_available`
  // seria falso e o rodapé mostraria "versão 1.1.0" como instalada, que é
  // justamente a versão que quebrou.
  await expect(page.getByRole("link", { name: /nova versão/i })).toBeVisible();

  // Saída garantida: o botão NÃO aparece (um novo pedido faria o servidor
  // responder "já estou na 1.1.0" e reportar sucesso sem trocar imagem
  // nenhuma) — quem resolve ali é o comando com --force, sempre presente.
  await expect(page.getByRole("button", { name: /atualizar agora/i })).toHaveCount(0);
  // E o comando leva de volta para a versão que FUNCIONAVA — reinstalar a 1.1.0,
  // que acabou de quebrar, não é saída nenhuma se o problema for a release.
  await expect(
    page.getByText("bash hostgator-setup-kit/update.sh --to v1.0.0 --force"),
  ).toBeVisible();
  await page.screenshot({ path: "evidence/final-1-falha-com-rollback.png" });

  // ── Falha SEM rollback: a tela não pode prometer que voltou ────────────────
  resetEstado();
  await heartbeat(request, { current_version: "1.1.0", latest_version: "1.2.0" });
  await page.reload();
  await page.getByRole("button", { name: /atualizar agora/i }).click();
  await expect(page.getByRole("heading", { name: /pedido enviado/i })).toBeVisible();

  const segundo = await heartbeat(request, { current_version: "1.1.0", latest_version: "1.2.0" });
  expect(segundo.data.update_requested).toBe(true);
  await runProgress(request, segundo.data.run_id!, "banco");
  await runResult(request, segundo.data.run_id!, "failed", "✖ rollback não foi possível");
  await heartbeat(request, { current_version: "1.2.0", latest_version: "1.2.0" });
  await page.reload();

  await expect(
    page.getByRole("heading", { name: /a atualização para a versão 1\.2\.0 não deu certo/i }),
  ).toBeVisible();
  await expect(page.getByText(/não consegui/i)).toBeVisible();
  await expect(page.getByText(/Voltei o sistema para a versão/)).toHaveCount(0);
  await expect(
    page.getByText("bash hostgator-setup-kit/update.sh --to v1.1.0 --force"),
  ).toBeVisible();
  await page.screenshot({ path: "evidence/final-2-falha-sem-rollback.png" });

  // ── Sem nenhum passo reportado, a saída NÃO pode sumir ────────────────────
  // `run_progress` não tem retry e engole falha; `run_result` insiste por ~2
  // min. Uma atualização que mexeu em tudo e quebrou no fim chega aqui com
  // `last_step` nulo sempre que os POSTs de progresso não passaram — foi por
  // ler esse nulo como "o host recusou, nada mudou" que a tela ficou sem
  // comando nenhum justamente no pior estado possível.
  resetEstado();
  await heartbeat(request, { current_version: "1.1.0", latest_version: "1.2.0" });
  await page.reload();
  await page.getByRole("button", { name: /atualizar agora/i }).click();
  // Espera a tela confirmar o pedido antes de bater o heartbeat: sem isso, o
  // agente simulado corre com o POST do clique e não acha run nenhum.
  await expect(page.getByRole("heading", { name: /pedido enviado/i })).toBeVisible();
  const terceiro = await heartbeat(request, { current_version: "1.1.0", latest_version: "1.2.0" });
  await runResult(
    request,
    terceiro.data.run_id!,
    "failed",
    "✖ A versão v1.2.0 é ANTERIOR à que já está instalada neste servidor.",
  );
  await page.reload();

  await expect(
    page.getByRole("heading", { name: /a atualização para a versão 1\.2\.0 não deu certo/i }),
  ).toBeVisible();
  await expect(
    page.getByText("bash hostgator-setup-kit/update.sh --to v1.1.0 --force"),
  ).toBeVisible();
  await page.getByText(/Detalhes técnicos/).click();
  await expect(page.getByText(/é ANTERIOR à que já está instalada/)).toBeVisible();
  await page.screenshot({ path: "evidence/final-4-sem-passo-reportado.png" });

  // ── A falha que já foi SUPERADA por outro caminho solta a tela ────────────
  //
  // Sem este bloco, o conserto do #945 não tem guarda nenhuma: a spec acima
  // reporta sempre uma versão que o run DESCREVE (from=1.1.0, to=1.2.0), e
  // `superseded` só vira verdadeiro quando o host informa uma TERCEIRA versão.
  // Medido antes de escrever: reverter o `falhaVigente` do UpdatePanel deixava
  // este arquivo inteiro verde.
  //
  // O caso é o da instalação real que originou o PR: a falha é de dias atrás, o
  // dono atualizou pelo terminal (`update.sh`), o servidor está numa versão que
  // a tentativa nem menciona — e a tela precisa voltar a oferecer, senão o único
  // jeito de sair do aviso é clicar no botão que ele mesmo escondeu.
  //
  // `latest_version` precisa ser MAIOR que a instalada: com as duas iguais, o
  // botão sumiria por "Você está na versão X" (UpdatePanel.tsx:297) e o teste
  // passaria pelo motivo errado.
  await heartbeat(request, { current_version: "1.3.0", latest_version: "1.4.0" });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: /não deu certo/i }),
    "a tela repetiu uma falha que o servidor já superou",
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: /atualizar agora/i })).toBeVisible();
  await page.screenshot({ path: "evidence/final-5-falha-superada.png" });

  // Reusa o terceiro run e a sessão já provada, depois de TODOS os controles
  // legados acima. A base 1.1.0 é from_version: a falha continua vigente e a
  // força terá alvo IGUAL à versão confirmada, sem criar outro run preparatório.
  await test.step("força respeita capacidade, identidade e a mesma tag", async () => {
    const forcar = page.getByRole("button", { name: "Forçar atualização", exact: true });
    const instalada = page.getByRole("region", { name: "Versão instalada", exact: true });
    const comando = "bash hostgator-setup-kit/update.sh --to v1.1.0 --force";
    const c = credenciaisSupabaseDeTeste();
    expect(["127.0.0.1", "localhost"]).toContain(new URL(c.url).hostname);
    const db = createClient(c.url, c.serviceRole, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    let runForcado: string | null = null;
    const conferirRecusa = async (
      nome: string,
      runtime: RuntimeConfirmation | null,
      status: "legacy" | "confirmed" | "partial",
      customized: boolean | null,
      anuncia?: boolean,
    ) => {
      await heartbeat(request, {
        current_version: "1.1.0", latest_version: "1.1.0",
        runtime_confirmation: runtime, supports_forced_update: anuncia,
      });
      await page.reload();
      const antes = await estadoDaTela(page);
      expect(antes.identity).toMatchObject({ status, customized });
      expect(antes.force_update_supported).toBe(false);
      expect(antes.run).toMatchObject({ id: terceiro.data.run_id, status: "failed", superseded: false });
      await expect(page.getByRole("heading", { name: /a atualização para a versão 1\.2\.0 não deu certo/i })).toBeVisible();
      await expect(forcar).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Atualizar agora", exact: true })).toHaveCount(0);
      if (nome === "legado") {
        await expect(instalada).toContainText("Execução não confirmada");
        await expect(page.getByText(comando, { exact: true })).toBeVisible();
      } else {
        await expect(page.getByText("O agente do servidor ainda não confirmou suporte para refazer a atualização pela tela.", { exact: true })).toBeVisible();
      }
      if (customized) await expect(instalada).toContainText("Personalizada");
      if (customized || status === "partial") {
        await expect(page.getByRole("button", { name: "Voltar para a versão anterior", exact: true })).toHaveCount(0);
      }
      if (status === "partial") {
        await expect(instalada).toContainText("Ainda não confirmada");
        await expect(instalada.locator("li", { hasText: "voice-agent" })).toContainText("Não confirmado");
      }
      await page.screenshot({ path: `evidence/forca-runtime-${nome}.png` });
      const recusa = await page.request.post("/api/v1/system/update", { data: { force: true } });
      expect(recusa.status()).toBe(409);
      expect((await recusa.json()).error.code).toBe("state_conflict");
      expect((await estadoDaTela(page)).run).toEqual(antes.run);
    };

    try {
      await conferirRecusa("legado", null, "legacy", null);
      // O helper até oferece true; sem anúncio no topo ele não ganha capacidade.
      await conferirRecusa("capacidade-ausente", {
        ...confirmedRuntime("1.1.0"), supports_forced_update: true,
      }, "confirmed", false);
      await conferirRecusa("personalizada", confirmedRuntime("1.1.0", new Date().toISOString(), true), "confirmed", true, true);
      const ausente = confirmedRuntime("1.1.0");
      ausente.services.push({
        role: "voice-agent", container_id: null, image_id: null, revision: null,
        base_version: null, base_revision: null, source_verified: false,
        running: false, healthy: false,
      });
      await conferirRecusa("servico-ausente", ausente, "partial", null, true);

      const oficial = { current_version: "1.1.0", latest_version: "1.1.0",
        runtime_confirmation: confirmedRuntime("1.1.0"), supports_forced_update: true };
      await heartbeat(request, oficial);
      await page.reload();
      const estado = await estadoDaTela(page);
      expect(estado.identity).toMatchObject({ status: "confirmed", base_version: "1.1.0", customized: false });
      expect(estado).toMatchObject({ force_update_supported: true, update_available: false, manual_reconciliation_required: false });
      expect(estado.run).toMatchObject({ id: terceiro.data.run_id, from_version: "1.1.0", superseded: false });
      await expect(instalada).toContainText("Versão instalada: 1.1.0");
      await expect(instalada).toContainText("Última confirmação");
      await expect(instalada).not.toContainText("Execução não confirmada");
      await expect(page.getByRole("button", { name: "Atualizar agora", exact: true })).toHaveCount(0);
      await expect(forcar).toBeVisible();
      await expect(forcar).toBeEnabled();
      const yBotao = (await forcar.boundingBox())!.y;
      const yComando = (await page.getByText(comando, { exact: true }).boundingBox())!.y;
      expect(yBotao).toBeLessThan(yComando);
      await page.screenshot({ path: "evidence/forca-runtime-oficial.png" });
      const resposta = page.waitForResponse((res) =>
        new URL(res.url()).pathname === "/api/v1/system/update" && res.request().method() === "POST",
      );
      await forcar.focus();
      await expect(forcar).toBeFocused();
      await forcar.press("Enter");
      const pedido = await resposta;
      expect(pedido.request().postDataJSON()).toEqual({ force: true });
      expect(pedido.status()).toBe(200);
      const { data: ordem } = await pedido.json();
      runForcado = ordem.run_id;
      expect(ordem.to_version).toBe("v1.1.0");
      const { data: gravado, error } = await db.from("system_update_runs")
        .select("id, from_version, to_version, force_requested, status")
        .eq("id", ordem.run_id).single();
      expect(error).toBeNull();
      expect(gravado).toMatchObject({ id: ordem.run_id, status: "dispatched",
        from_version: "1.1.0", to_version: "v1.1.0", force_requested: true });
      await expect(page.getByRole("heading", { name: /pedido enviado/i })).toBeVisible();
      expect((await estadoDaTela(page)).run).toMatchObject({ id: ordem.run_id, status: "dispatched", to_version: "v1.1.0" });
      await page.screenshot({ path: "evidence/forca-runtime-pedido.png" });
      const entrega = await heartbeat(request, oficial);
      expect(entrega.data).toMatchObject({ update_requested: true, run_id: ordem.run_id, to_version: "v1.1.0", force_requested: true });
    } finally {
      // A sessão de teste é dona da fila: o heartbeat legado recusa/encerra
      // qualquer força que este bloco tenha deixado pendente, sem executar update.
      const recusaDoAntigo = await heartbeat(request, {
        current_version: "1.1.0", latest_version: "1.1.0", runtime_confirmation: null,
      });
      expect(recusaDoAntigo.data).toMatchObject({ update_requested: false, run_id: null, force_requested: false });
      if (runForcado) {
        const { data: fechado, error } = await db.from("system_update_runs")
          .select("id, status, force_requested").eq("id", runForcado).single();
        expect(error).toBeNull();
        expect(fechado).toMatchObject({ id: runForcado, status: "failed", force_requested: true });
      }
    }
  }, { timeout: 30_000 });
});

test("retrato antigo informa a última conferência sem antecipar o comando manual", async ({ page, request }, testInfo) => {
  test.setTimeout(90_000);
  // Só a idade é preparada no banco de teste: login, heartbeat, leitura da API
  // e a tela continuam reais. Nenhum relógio do produto ou resposta é alterado.
  const c = credenciaisSupabaseDeTeste();
  expect(["127.0.0.1", "localhost"]).toContain(new URL(c.url).hostname);
  const db = createClient(c.url, c.serviceRole, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const envelhecer = async (minutos: number): Promise<string> => {
    const ultimaConferencia = new Date(Date.now() - minutos * 60_000).toISOString();
    const { data, error } = await db.from("system_version")
      .update({ agent_last_seen_at: ultimaConferencia })
      .eq("id", 1).select("agent_last_seen_at").single();
    expect(error).toBeNull();
    expect(Date.parse(data!.agent_last_seen_at)).toBe(Date.parse(ultimaConferencia));
    return ultimaConferencia;
  };

  resetEstado();
  try {
    await heartbeat(request, { current_version: "1.0.0", latest_version: "" });
    await loginWithTotp(page, creds.users.dono!.email, creds.dono_totp!.secret);
    await page.goto("/app/settings/atualizacao");
    await expect(page.getByText("É a mais recente. Não há nada a fazer.")).toBeVisible();
    await expect(page.getByText("bash hostgator-setup-kit/update.sh")).toHaveCount(0);

    const ultimaConferencia = await envelhecer(31);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Não sei se há versão nova" })).toBeVisible();
    await expect(page.getByText("É a mais recente. Não há nada a fazer.")).toHaveCount(0);
    await expect(page.getByText(/verifique a conexão do servidor com a internet/)).toBeVisible();
    await expect(page.getByText("bash hostgator-setup-kit/update.sh")).toHaveCount(0);
    const hora = await page.evaluate((iso) => {
      const d = new Date(iso);
      return `${String(d.getHours()).padStart(2, "0")}h${String(d.getMinutes()).padStart(2, "0")}`;
    }, ultimaConferencia);
    await expect(page.getByText(hora, { exact: true })).toBeVisible();
    await expect(page.getByText(/Versão instalada:.*1\.0\.0/)).toBeVisible();
    const pastaDaEvidencia = path.join("evidence", "retrato-host-3504");
    fs.mkdirSync(pastaDaEvidencia, { recursive: true });
    await testInfo.attach("retrato-antigo", {
      body: await page.screenshot({ path: path.join(pastaDaEvidencia, "retrato-antigo.png") }),
      contentType: "image/png",
    });

    await heartbeat(request, { current_version: "1.0.0", latest_version: "1.1.0" });
    await envelhecer(31);
    await page.reload();
    await expect(page.getByRole("button", { name: "Atualizar agora", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Não sei se há versão nova" })).toHaveCount(0);
    await expect(page.getByText("bash hostgator-setup-kit/update.sh")).toHaveCount(0);

    await envelhecer(25 * 60);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Atualização automática indisponível" })).toBeVisible();
    await expect(page.getByText("bash hostgator-setup-kit/update.sh")).toBeVisible();
    await testInfo.attach("agente-offline", {
      body: await page.screenshot({ path: path.join(pastaDaEvidencia, "agente-offline.png") }),
      contentType: "image/png",
    });
  } finally {
    // Não deixar a idade preparada para as outras jornadas desta instalação.
    await heartbeat(request, { current_version: "1.0.0", latest_version: "" });
  }
});

test("quando o host não conseguiu comparar, a tela não diz que está em dia", async ({
  page,
  request,
}) => {
  // Instalação numa tag (off_release falso) cujo host não conseguiu completar a
  // história para comparar. Sem o sinal explícito, `latest_version` vazio virava
  // "Você está na versão 0.9.0 — É a mais recente", e uma instalação atrasada
  // ficaria para sempre sem saber que existe correção de segurança esperando.
  resetEstado();
  await heartbeat(request, {
    current_version: "0.9.0",
    latest_version: "",
    off_release: false,
    compare_failed: true,
  });
  await loginWithTotp(page, creds.users.dono!.email, creds.dono_totp!.secret);
  await page.goto("/app/settings/atualizacao");

  await expect(page.getByRole("heading", { name: /não consegui checar/i })).toBeVisible();
  await expect(page.getByText(/é a mais recente/i)).toHaveCount(0);
  await expect(page.getByText(/quer dizer que eu não sei/i)).toBeVisible();
  await expect(page.getByText("bash hostgator-setup-kit/update.sh")).toBeVisible();
  await page.screenshot({ path: "evidence/final-5-nao-consegui-checar.png" });
});

test("instalação à frente da versão publicada não vira tela quebrada nem alarme", async ({
  page,
  request,
}) => {
  // `off_release` com `latest_version` vazio: o agente não anuncia uma tag que
  // já está contida no HEAD (instalá-la seria retroceder) nem uma que ele não
  // consegue comparar. Não é defeito — e a tela não pode tratar como se fosse.
  resetEstado();
  await heartbeat(request, { current_version: "abc1234", latest_version: "", off_release: true });
  await loginWithTotp(page, creds.users.dono!.email, creds.dono_totp!.secret);

  await page.goto("/app/inbox");
  await expect(page.getByRole("link", { name: /nova versão/i })).toHaveCount(0);
  await expect(page.getByText("versão abc1234")).toBeVisible();

  await page.goto("/app/settings/atualizacao");
  await expect(
    page.getByRole("heading", { name: /você está à frente da versão publicada/i }),
  ).toBeVisible();
  await expect(page.getByText(/não há nada a atualizar/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /atualizar agora/i })).toHaveCount(0);
  await expect(page.getByText("bash hostgator-setup-kit/update.sh")).toBeVisible();
  await page.screenshot({ path: "evidence/final-3-a-frente-da-publicada.png" });
});

test("fork sem nenhuma release publicada não afirma 'à frente' sem base", async ({ page, request }) => {
  // Mesma combinação bruta do teste anterior (off_release=true, latest_version
  // vazio, compare_failed=false) — a diferença é `has_known_release: false`:
  // o agente NUNCA viu nenhuma tag `v*` neste repositório (fork sem releases),
  // então "à frente da publicada" seria afirmar a existência de algo que não
  // existe. Achado real da revisão: a tela dizia isso mesmo sem base nenhuma.
  resetEstado();
  await heartbeat(request, {
    current_version: "abc1234",
    latest_version: "",
    off_release: true,
    has_known_release: false,
  });
  await loginWithTotp(page, creds.users.dono!.email, creds.dono_totp!.secret);

  await page.goto("/app/settings/atualizacao");
  await expect(
    page.getByRole("heading", { name: /ainda não há nenhuma versão publicada/i }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: /à frente da versão publicada/i })).toHaveCount(0);
  await expect(page.getByText(/não há nada a atualizar agora/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /atualizar agora/i })).toHaveCount(0);
  await expect(page.getByText("bash hostgator-setup-kit/update.sh")).toBeVisible();
  await page.screenshot({ path: "evidence/minors-1-sem-release-publicada.png" });
});

test("quem não é dono do servidor não vê o botão", async ({ page, request }) => {
  // Update disponível de verdade nesse instante — a ausência do aviso tem que
  // vir da falta de is_platform_admin, não de coincidentemente já estar em dia.
  await heartbeat(request, { current_version: "1.0.0", latest_version: "1.1.0" });

  await login(page, creds.users.agent!.email);
  await page.goto("/app/inbox");
  await expect(page.getByRole("link", { name: /nova versão/i })).toHaveCount(0);

  await page.goto("/app/settings/atualizacao");
  await expect(page.getByText(/404 — Página não encontrada/i)).toBeVisible();
  await page.screenshot({ path: "evidence/task9-4-nao-dono-404.png" });

  // HTTP real no Auth/PostgREST já existentes. Não é SET ROLE, token inventado
  // nem um novo caso; o custo marginal fica separado da prova UI e será medido.
  await test.step(
    "JWT real não altera força nem confirmação pelas tabelas globais",
    () => provarJwtSemAcessoGlobal(page),
    { timeout: 20_000 },
  );
});

async function provarJwtSemAcessoGlobal(page: Page): Promise<void> {
  const inicio = performance.now();
  let inicioLimpeza: number | null = null;
  let provasConcluidas = false;
  let dadosRestaurados = false;
  // O helper canônico tem fallback de desenvolvimento em arquivo. Aqui só se
  // aceita o ambiente completo do CI, antes de resolver qualquer credencial.
  for (const chave of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_DB_URL",
  ]) {
    if (!process.env[chave]) throw new Error(`JWT de teste exige ${chave} no ambiente.`);
  }
  const c = credenciaisSupabaseDeTeste();
  expect(["127.0.0.1", "localhost"]).toContain(new URL(c.url).hostname);
  expect(c.origem).toBe("ambiente");
  // Só os clientes deste helper: prazo finito sem sobrescrever o fetch global.
  // O sinal passado pelo SDK (ou pelo Request) continua podendo cancelar antes.
  const buscarComPrazo: typeof fetch = (input, init) => {
    const sinais = [AbortSignal.timeout(5_000)];
    if (input instanceof Request) sinais.push(input.signal);
    if (init?.signal) sinais.push(init.signal);
    return fetch(input, { ...init, signal: AbortSignal.any(sinais) });
  };
  const opcoes = {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: buscarComPrazo },
  };
  const servico = createClient<Database>(c.url, c.serviceRole, opcoes);
  const usuario = createClient<Database>(c.url, c.anonKey, opcoes);
  const loginJwt = await usuario.auth.signInWithPassword({
    email: creds.users.agent!.email,
    password: creds.password,
  });
  // Nunca passar a sessão ou o bearer ao expect/trace/anexo: só fatos seguros.
  expect(loginJwt.error === null).toBe(true);
  const bearer = loginJwt.data.session?.access_token;
  if (!bearer) throw new Error("Auth de teste não emitiu JWT para o usuário existente.");
  try {
    const validado = await usuario.auth.getUser(bearer);
    expect(validado.error === null).toBe(true);
    expect(validado.data.user?.id).toBe(creds.users.agent!.id);
    expect(validado.data.user?.role).toBe("authenticated");
    const vinculo = await servico
      .from("user_organizations")
      .select("user_id, organization_id, role, accepted_at, revoked_at")
      .eq("user_id", creds.users.agent!.id)
      .eq("organization_id", creds.org_id)
      .is("revoked_at", null)
      .not("accepted_at", "is", null)
      .single();
    expect(vinculo.error).toBeNull();
    expect(vinculo.data?.role).toBe("agent");
    const plataforma = await servico
      .from("platform_admins")
      .select("user_id")
      .eq("user_id", creds.users.agent!.id)
      .is("revoked_at", null)
      .maybeSingle();
    expect(plataforma.error).toBeNull();
    expect(plataforma.data).toBeNull();

    const ler = async () => {
      const [runs, versao] = await Promise.all([
        servico.from("system_update_runs").select("*").order("id"),
        servico.from("system_version").select("*").eq("id", 1).single(),
      ]);
      expect(runs.error).toBeNull();
      expect(versao.error).toBeNull();
      if (!runs.data || !versao.data) throw new Error("Readback de teste sem dados nativos.");
      return { runs: runs.data, versao: versao.data };
    };
    const original = await ler();
    const existente = randomUUID();
    const tentativa = randomUUID();
    const criadosPelaRota: string[] = [];
    const runtime = confirmedRuntime("1.1.0");
    const nova = { id: tentativa, status: "success", force_requested: true };
    // Node fetch/SDK não entram no APIRequestContext traceado do Playwright.
    // URL sem credencial; bearer só nesta closure e nunca em evidência/log.
    const escrever = (
      token: string,
      chave: string,
      metodo: "POST" | "PATCH",
      recurso: string,
      corpo: unknown,
    ) =>
      fetch(`${c.url}/rest/v1/${recurso}`, {
        method: metodo,
        headers: {
          apikey: chave,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(5_000),
      });
    try {
      const fixture = await servico.from("system_update_runs").insert({
        id: existente,
        status: "success",
        force_requested: false,
      });
      expect(fixture.error).toBeNull();
      const antes = await ler();
      const inalterado = async () => expect(await ler()).toEqual(antes);
      const insercao = await escrever(bearer, c.anonKey, "POST", "system_update_runs", nova);
      expect(insercao.status).toBe(403);
      await insercao.arrayBuffer();
      await inalterado();
      for (const [recurso, corpo] of [
        [`system_update_runs?id=eq.${existente}`, { force_requested: true }],
        ["system_version?id=eq.1", { runtime_confirmation: runtime }],
      ] as const) {
        const recusa = await escrever(bearer, c.anonKey, "PATCH", recurso, corpo);
        expect([200, 204, 403]).toContain(recusa.status);
        if (recusa.status === 200) expect(await recusa.json()).toEqual([]);
        else await recusa.arrayBuffer();
        // 200/[] sozinho não prova RLS. A leitura independente precisa ser igual.
        await inalterado();
      }
      const rota = await page.request.post("/api/v1/system/update", { data: { force: true } });
      const aposRota = await ler();
      // Se o guard regredir, ainda limpamos os runs novos desta chamada e
      // deste usuário. Nunca incluir um UUID que já existia antes dela.
      criadosPelaRota.push(
        ...aposRota.runs
          .filter(
            (run) =>
              run.requested_by === creds.users.agent!.id &&
              !antes.runs.some((anterior) => anterior.id === run.id),
          )
          .map((run) => run.id),
      );
      expect(rota.status()).toBe(403);
      expect((await rota.json()).error.code).toBe("forbidden");
      expect(aposRota).toEqual(antes);

      // Mesmas três mutações, agora com o controle positivo de serviço.
      for (const [metodo, recurso, corpo] of [
        ["POST", "system_update_runs", nova],
        ["PATCH", `system_update_runs?id=eq.${existente}`, { force_requested: true }],
        ["PATCH", "system_version?id=eq.1", { runtime_confirmation: runtime }],
      ] as const) {
        const positivo = await escrever(c.serviceRole, c.serviceRole, metodo, recurso, corpo);
        expect(positivo.ok).toBe(true);
        await positivo.arrayBuffer();
      }
      const depois = await ler();
      expect(depois.runs.find((r) => r.id === existente)?.force_requested).toBe(true);
      expect(depois.runs.find((r) => r.id === tentativa)?.force_requested).toBe(true);
      expect(depois.versao.runtime_confirmation).toEqual(runtime);
      provasConcluidas = true;
    } finally {
      inicioLimpeza = performance.now();
      // Só a coluna e os dois UUIDs desta fase; nenhum dispatched é criado.
      const resultados = await Promise.all([
        servico
          .from("system_version")
          .update({ runtime_confirmation: original.versao.runtime_confirmation })
          .eq("id", 1),
        servico
          .from("system_update_runs")
          .delete()
          .in("id", [existente, tentativa, ...criadosPelaRota]),
      ]);
      for (const resultado of resultados) expect(resultado.error).toBeNull();
      expect(await ler()).toEqual(original);
      dadosRestaurados = true;
    }
  } finally {
    // Revoga só a sessão SDK emitida aqui, inclusive se uma precondição falhar.
    // A sessão UI do mesmo usuário continua independente.
    const encerramento = await usuario.auth.signOut({ scope: "local" });
    fs.mkdirSync("evidence", { recursive: true });
    fs.writeFileSync(
      "evidence/forca-runtime-jwt-tempos.json",
      JSON.stringify(
        {
          total_ms: Math.round(performance.now() - inicio),
          cleanup_ms: inicioLimpeza === null ? null : Math.round(performance.now() - inicioLimpeza),
          proofs_completed: provasConcluidas,
          data_restored: dadosRestaurados,
          sdk_session_revoked: encerramento.error === null,
          token_recorded: false,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    expect(encerramento.error === null).toBe(true);
  }
}
