/**
 * O AVISO CHEGA DE VERDADE — com um receptor HTTP no lugar do WhatsApp.
 *
 * ═══ Por que esta spec está em `FORA_DO_CI` ═══
 *
 * Ela exige um `NEXT_PUBLIC_APP_URL` **público**, e o CI não tem — nem por
 * esquecimento: `scripts/gerar-env-e2e.sh` grava
 * `NEXT_PUBLIC_APP_URL=http://localhost:$E2E_PORT` de propósito (é o endereço em
 * que o servidor sob teste realmente responde, e as três specs de e-mail
 * dependem disso). O produto, por sua vez, **recusa** mandar um aviso cujo link
 * não abriria no celular de outra pessoa
 * (`lib/escalacao/aviso-ao-suporte.ts:425`, `lib/escalacao/aviso-de-teste.ts:116`).
 *
 * As duas decisões estão certas e são incompatíveis dentro do mesmo processo:
 * o endereço é lido uma vez, no boot (`lib/env.ts:416`, `safeParse(process.env)`),
 * e trocá-lo para esta spec trocaria para a suíte inteira.
 *
 * O que roda no CI é `tests/e2e/aviso-de-caso-no-whatsapp.spec.ts`, que prova a
 * tela e a RECUSA honesta — que é o comportamento de uma instalação nova.
 *
 * ═══ Como rodar esta aqui ═══
 *
 *   # 1. endereço público no ambiente do build E do start (é NEXT_PUBLIC_*)
 *   sed -i '' 's#^NEXT_PUBLIC_APP_URL=.*#NEXT_PUBLIC_APP_URL=https://crm.bancada.example.com#' .env.e2e
 *   mv .env.local .env.local.bak && pnpm e2e:build && mv .env.local.bak .env.local
 *   # 2. a spec
 *   AUTH_RATE_LIMIT_LOGIN_IP=1000 pnpm exec playwright test tests/e2e/aviso-de-caso-chega-no-whatsapp.spec.ts
 *   # 3. devolver o `.env.e2e` e reconstruir
 *
 * A precondição é COBRADA, não pulada: sem endereço público a spec falha com a
 * instrução acima. `test.skip()` aqui seria um verde que não distingue "passou"
 * de "nem tentou".
 *
 * ═══ O receptor ═══
 *
 * Não é um mock de módulo: é um servidor HTTP de verdade no endereço que o
 * `.env.e2e` aponta como transporte de WhatsApp. O produto faz `fetch` real,
 * monta cabeçalho real e recebe resposta real — o que um mock não estressa é
 * exatamente onde moram os defeitos de egress.
 *
 * ⚠️ **Esta spec depende de `workers: 1`.** Enquanto o receptor está de pé,
 * QUALQUER envio de QUALQUER parte do app responde 200. Quem subir os workers
 * para 2 transforma este arquivo em fonte de vermelho nas vizinhas, com o
 * sintoma longe da causa.
 */
import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";
import { urlPublicaUsavel } from "../../lib/escalacao/url-publica";
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence", "casos-vivos", "aviso");
const ESPERA = 60_000;
const NUMERO_DA_EQUIPE = "+5531988887777";

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string }>;
  admin_totp?: { factor_id: string; secret: string };
  escalacao: { conversation_id: string; contact_id: string; contact_name: string };
}

const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** O telefone do CLIENTE — ele nunca pode aparecer na mensagem da equipe. */
const TELEFONE_DO_CLIENTE = "+5531977776666";

interface Recebido {
  caminho: string;
  chaveDeApi: string | null;
  corpo: Record<string, unknown>;
}

const recebidos: Recebido[] = [];
let servidor: Server | null = null;

/**
 * A porta vem do `.env.e2e`, não de um literal.
 *
 * É a mesma fonte que o produto usa para achar o transporte; um número digitado
 * aqui poderia divergir dela e a spec passaria a medir um servidor que o app
 * nunca procura.
 */
function portaDoTransporte(): number {
  const bruto = env.WAHA_API_BASE_URL ?? "";
  const url = new URL(bruto);
  const porta = Number(url.port);
  if (!Number.isFinite(porta) || porta === 0)
    throw new Error(`WAHA_API_BASE_URL sem porta utilizável: ${bruto}`);
  return porta;
}

test.beforeAll(async () => {
  const porta = portaDoTransporte();
  servidor = createServer((req, res) => {
    let bruto = "";
    req.on("data", (p) => (bruto += p));
    req.on("end", () => {
      let corpo: Record<string, unknown> = {};
      try {
        corpo = JSON.parse(bruto || "{}") as Record<string, unknown>;
      } catch {
        corpo = { _naoEraJson: bruto };
      }
      recebidos.push({
        caminho: req.url ?? "",
        chaveDeApi: (req.headers["x-api-key"] as string | undefined) ?? null,
        corpo,
      });
      res.writeHead(200, { "content-type": "application/json" });
      // A forma mínima que o adapter lê de volta (o id externo da mensagem).
      res.end(JSON.stringify({ id: `receptor-${recebidos.length}`, _data: {} }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    servidor!.once("error", reject);
    servidor!.listen(porta, "127.0.0.1", resolve);
  });
});

test.afterAll(async () => {
  // ESPERAR o `close`, nunca `unref`: um servidor meio fechado segura a porta e
  // a próxima corrida falha em `listen` com EADDRINUSE, longe daqui.
  if (servidor) await new Promise<void>((r) => servidor!.close(() => r()));
  await admin.from("entregas_de_aviso_de_caso").delete().eq("organization_id", creds.org_id);
  await admin.from("config_aviso_de_caso").delete().eq("organization_id", creds.org_id);
});

async function preencheLogin(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await expect(page.locator("#email")).toBeVisible({ timeout: ESPERA });
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
}

/** Ver o comentário do helper homônimo em `aviso-de-caso-no-whatsapp.spec.ts`:
 *  a segunda tentativa RECARREGA, porque os campos ficam `disabled` com os
 *  dígitos da tentativa anterior dentro enquanto o código é conferido. */
async function loginComTotp(page: Page, email: string, secret: string): Promise<void> {
  await preencheLogin(page, email);
  await page.waitForURL(/\/login\/mfa/, { timeout: ESPERA });
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    if (tentativa > 0) {
      await page.reload();
      await page.waitForURL(/\/login\/mfa/, { timeout: ESPERA });
    }
    const primeiroDigito = page.locator('input[aria-label="Dígito 1"]');
    await expect(primeiroDigito).toBeEnabled({ timeout: ESPERA });
    if (msUntilNextTotpWindow() < 3_000) await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    await primeiroDigito.click();
    await page.keyboard.type(generateTotp(secret), { delay: 40 });
    try {
      await page.waitForURL(/\/app\//, { timeout: 30_000 });
      return;
    } catch {
      await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    }
  }
  throw new Error("a verificação em duas etapas não passou em 3 tentativas");
}

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

function segredoInterno(): string {
  const secret = env.INTERNAL_SECRET?.trim();
  if (!secret) throw new Error("INTERNAL_SECRET não encontrado no ambiente");
  return secret;
}

async function drena(page: Page): Promise<void> {
  const r = await page.request.post("/api/v1/cron/event-log-drain", {
    headers: { authorization: `Bearer ${segredoInterno()}` },
  });
  expect(r.status(), "o dreno tem de responder 200").toBe(200);
}

/** Só os envios de texto — o receptor também anota qualquer outra chamada. */
function textosEnviados(): string[] {
  return recebidos
    .filter((r) => r.caminho.includes("/api/sendText"))
    .map((r) => String(r.corpo.text ?? ""));
}

test.describe("o aviso de caso chega no WhatsApp da equipe", () => {
  test("o teste pela tela sai, o caso dispara o aviso certo, e ele não se repete", async ({
    page,
  }) => {
    test.setTimeout(300_000);

    /**
     * O QUE A REDE RESPONDEU, guardado — senão o vermelho não tem dono.
     *
     * Quando a tela mostra "Não foi possível abrir esta tela agora", o único
     * dado que separa "o servidor recusou" de "o servidor demorou" é o status da
     * resposta — e ele morre no console do browser. Três investigações deste
     * repositório já foram gastas adivinhando o dono de um código HTTP que o
     * próprio teste tinha em mãos.
     */
    const respostasRuins: string[] = [];
    page.on("response", (r) => {
      if (r.url().includes("/api/v1/") && r.status() >= 400)
        respostasRuins.push(`${r.status()} ${new URL(r.url()).pathname}`);
    });
    page.on("requestfailed", (r) => {
      if (r.url().includes("/api/v1/"))
        respostasRuins.push(`FALHOU ${new URL(r.url()).pathname}: ${r.failure()?.errorText ?? "?"}`);
    });

    // ── A precondição é COBRADA, com a receita na mensagem ────────────────
    expect(
      urlPublicaUsavel(env.NEXT_PUBLIC_APP_URL),
      "Esta spec precisa de NEXT_PUBLIC_APP_URL público — o produto recusa mandar " +
        "um aviso com link que não abre. A receita está no cabeçalho do arquivo. " +
        `Valor atual: ${env.NEXT_PUBLIC_APP_URL ?? "(ausente)"}`,
    ).toBe(true);
    const urlPublica = env.NEXT_PUBLIC_APP_URL!.replace(/\/+$/, "");
    expect(creds.admin_totp?.secret, "o seed tem de gravar admin_totp").toBeTruthy();

    // ── o canal precisa estar no ar (é o que um número pareado é) ─────────
    const { data: canalAntes } = await admin
      .from("channel_sessions")
      .select("id, status")
      .eq("organization_id", creds.org_id)
      .limit(1)
      .single();
    const canal = canalAntes as { id: string; status: string };
    await admin.from("channel_sessions").update({ status: "WORKING" }).eq("id", canal.id);

    let casoId = "";
    try {
      // ── 1. configurar e TESTAR pela tela ───────────────────────────────
      await loginComTotp(page, creds.users.admin!.email, creds.admin_totp!.secret);

      /**
       * ESVAZIAR A FILA DE EVENTOS **ANTES** DE LIGAR O AVISO.
       *
       * O banco da bancada tem casos abertos por outros cenários (o
       * `seed-e2e-escalacao` abre um por execução) e os `ai.case_opened` deles
       * ficam no `event_log` esperando. Com o aviso DESLIGADO eles saem por
       * `skipped(sem_configuracao)` e nada é enviado; se a configuração entrar
       * antes, o primeiro dreno manda aviso de casos que este teste não abriu.
       *
       * Medido: a contagem deu 3 envios onde a spec esperava 2, e o terceiro era
       * o caso do seed. Um vermelho que acusa "o aviso saiu duas vezes" quando o
       * produto avisou, corretamente, sobre dois casos diferentes.
       */
      await drena(page);
      await drena(page);
      await page.goto("/app/ai/cases/avisos");
      await expect(page.getByRole("heading", { name: "Aviso no WhatsApp" })).toBeVisible({
        timeout: ESPERA,
      });
      // Com endereço público, o alerta bloqueante NÃO aparece.
      await expect(page.getByTestId("alerta-sem_endereco_publico")).toHaveCount(0);

      // try/catch e não a mensagem do `expect`: a mensagem é avaliada ANTES da
      // espera, e as respostas ruins que interessam chegam DURANTE ela.
      try {
        await expect(page.locator("#conexao")).toBeVisible({ timeout: ESPERA });
      } catch (erro) {
        throw new Error(
          `o formulário do aviso não montou. Respostas ruins da API: ${
            respostasRuins.length === 0 ? "(nenhuma)" : respostasRuins.join(" · ")
          }. Original: ${erro instanceof Error ? erro.message : String(erro)}`,
        );
      }
      await page.locator("#conexao").click();
      await page.getByRole("option").first().click();
      await page.locator("#telefone").fill(NUMERO_DA_EQUIPE);
      await page.locator("#rotulo").fill("Plantão E2E");
      // Agora o interruptor DESTRAVA — é a contraparte medida da spec do CI.
      const interruptor = page.getByRole("switch", { name: "Receber avisos no WhatsApp" });
      await expect(interruptor).toBeEnabled();
      await interruptor.click();
      await page.getByRole("button", { name: /^Salvar$/ }).click();
      await expect(page.getByText("Aviso salvo.").first()).toBeVisible({ timeout: ESPERA });
      await captura(page, "70-configurado-e-ligado");

      const antesDoTeste = textosEnviados().length;
      await page.getByRole("button", { name: /Enviar aviso de teste/ }).click();
      await expect(
        page.getByText(/Aviso de teste enviado/i).first(),
        "a tela tem de confirmar o envio de teste",
      ).toBeVisible({ timeout: ESPERA });
      await expect
        .poll(() => textosEnviados().length, {
          timeout: 20_000,
          message: "o receptor tinha de ter recebido UM envio do teste",
        })
        .toBe(antesDoTeste + 1);
      await captura(page, "71-teste-enviado");

      const textoDoTeste = textosEnviados().at(-1)!;
      // O teste NÃO imita um caso: se imitasse, a equipe aprenderia a ler o
      // cabeçalho de caso como ruído e ignoraria o primeiro de verdade.
      expect(textoDoTeste).toContain("teste de aviso");
      expect(textoDoTeste).not.toContain("novo caso esperando você");
      expect(textoDoTeste).toContain(`${urlPublica}/app/ai/cases`);
      expect(textoDoTeste).toContain("Responder aqui não chega ao cliente");
      // A chave vai no CABEÇALHO, nunca na URL (ela vaza em log de proxy).
      const ultimo = recebidos.at(-1)!;
      expect(ultimo.chaveDeApi, "a chave do transporte tem de ir no cabeçalho").toBeTruthy();
      expect(ultimo.caminho).not.toContain("api_key");

      // ── 2. o caminho de verdade: a IA abre um caso ─────────────────────
      //
      // ⚠️ ESPERAR O ESPAÇAMENTO ANTES DE ABRIR O CASO — e o motivo é caro.
      //
      // O aviso de teste acabou de contar um envio no `pacing_ledger`, e o
      // intervalo anti-banimento é 1,2 s + até 0,8 s de jitter
      // (`lib/agent-engine/pacing/defaults.ts`). Se o dreno encontra a entrega
      // DENTRO desse intervalo, ele devolve `retry` e — aqui está o custo — a
      // escrita desse `retry` toca `updated_at`, que é o relógio da JANELA DE
      // REIVINDICAÇÃO (2 min, `aviso-ao-suporte.ts:101`). A rodada seguinte lê
      // `updated_at` recente, conclui "outra rodada está enviando este aviso" e
      // adia mais 2 minutos. Medido: a entrega ficou `pendente` por 60 s de
      // drenos seguidos, e o vermelho dizia "o caso não produziu aviso".
      //
      // Não é defeito de produto — em produção o cron roda 1×/min e o atraso é
      // aceitável —, mas é um relógio que a spec precisa respeitar em vez de
      // correr contra.
      await page.waitForTimeout(3_000);
      const antesDoCaso = textosEnviados().length;
      /**
       * A marca da corrida é de LETRAS, e isso é o produto, não capricho.
       *
       * `sanitizarTextoDoLead` apaga corrida de 8+ dígitos do texto que sai —
       * é a defesa contra telefone e CPF escritos pelo cliente irem parar numa
       * mensagem assinada com a marca da empresa. Um `Date.now()` no título é
       * exatamente esse padrão: medido, o aviso saiu com "Desconto fora da
       * alçada" e sem o carimbo, e a spec acusou o produto de comer o assunto.
       */
      const marca = Math.random().toString(36).slice(2, 8).replace(/[0-9]/g, "x");
      const titulo = `Desconto fora da alçada lote ${marca}`;
      const caso = await admin
        .from("agent_cases")
        .insert({
          organization_id: creds.org_id,
          conversation_id: creds.escalacao.conversation_id,
          status: "awaiting_human",
          title: titulo,
          summary: "Cliente de 200 unidades pedindo 20% de desconto.",
          blocker: "a política do agente vai até 10%",
          source: "agent",
        })
        .select("id")
        .single();
      expect(caso.error?.message ?? null).toBeNull();
      casoId = (caso.data as { id: string }).id;

      // ⚠️ DRENAR DENTRO DO POLL, e não uma vez antes dele. O handler pode
      // devolver `retry` — o espaçamento anti-banimento do número acabou de
      // contar o envio do teste — e um `retry` só é reprocessado na RODADA
      // SEGUINTE do dreno. Com um dreno só, a espera vira 30 s de nada e o
      // vermelho diz "o caso não produziu aviso" quando o que houve foi o
      // produto respeitando o intervalo entre mensagens.
      //
      // E o que a sonda devolve é o PAR (o que chegou no receptor, o que o banco
      // registrou). Só a contagem dizia "não chegou" e deixava quem lê
      // adivinhando entre "o motor pulou", "está represado" e "recusou" — os
      // três produzem o mesmo número e exigem consertos diferentes.
      await expect
        .poll(
          async () => {
            await drena(page);
            const { data } = await admin
              .from("entregas_de_aviso_de_caso")
              .select("status, erro_codigo")
              .eq("case_id", casoId)
              .maybeSingle();
            const linha = data as { status: string; erro_codigo: string | null } | null;
            return {
              enviados: textosEnviados().length,
              entrega: linha === null ? "(sem linha)" : `${linha.status}/${linha.erro_codigo ?? "-"}`,
            };
          },
          {
            // 4 minutos: o teto é a JANELA DE REIVINDICAÇÃO (2 min) mais uma
            // folga. Ele quase nunca é usado — a espera de 3 s acima evita a
            // colisão —, mas existe para o caso em que o jitter caiu longe.
            timeout: 240_000,
            intervals: [2_000],
            message: "o caso aberto tinha de produzir UM aviso, e a entrega tinha de ficar enviada",
          },
        )
        .toEqual({ enviados: antesDoCaso + 1, entrega: "enviado/-" });

      const aviso = textosEnviados().at(-1)!;
      // ── 3. O QUE SAIU: detalhes suficientes, dado sensível nenhum ──────
      expect(aviso, "o aviso tem de dizer o assunto").toContain(titulo);
      expect(aviso, "o aviso tem de dizer o PRIMEIRO nome do cliente").toContain("Escalação");
      expect(
        aviso,
        "o sobrenome identifica a pessoa se a mensagem for encaminhada",
      ).not.toContain(creds.escalacao.contact_name);
      expect(aviso, "o link tem de abrir o caso").toContain(`${urlPublica}/app/ai/cases?caso=${casoId}`);
      expect(aviso, "responder ali não chega a ninguém, e isso precisa estar escrito").toContain(
        "Responder aqui não chega ao cliente",
      );
      expect(aviso, "o telefone do cliente NUNCA sai no aviso").not.toContain(TELEFONE_DO_CLIENTE);
      expect(aviso, "o telefone do cliente NUNCA sai no aviso").not.toContain("977776666");
      expect(aviso, "trecho de conversa do cliente não sai no aviso").not.toContain("Oi, tudo bem");
      fs.mkdirSync(EVIDENCIA, { recursive: true });
      fs.writeFileSync(path.join(EVIDENCIA, "aviso-que-saiu.txt"), aviso, "utf8");

      // ── 4. IDEMPOTÊNCIA: drenar de novo não manda de novo ──────────────
      await drena(page);
      await drena(page);
      await page.waitForTimeout(2_000);
      expect(
        textosEnviados().length,
        "avisar duas vezes o mesmo caso ensina a equipe a ignorar o aviso",
      ).toBe(antesDoCaso + 1);

      // ── 5. na tela: a entrega aparece como enviada ─────────────────────
      await page.reload();
      await expect(page.getByTestId("lista-de-entregas")).toBeVisible({ timeout: ESPERA });
      await expect(page.getByTestId("entrega-situacao-enviado").first()).toBeVisible({
        timeout: ESPERA,
      });
      await captura(page, "72-entrega-enviada");

      // ── 6. e na linha do tempo do caso, para quem atende ───────────────
      await page.goto(`/app/ai/cases?caso=${casoId}`);
      await expect(
        page.getByText("Avisamos o suporte no WhatsApp").first(),
        "quem abre o caso precisa saber que a equipe já foi avisada",
      ).toBeVisible({ timeout: ESPERA });
      await captura(page, "73-linha-do-tempo-do-caso");
    } finally {
      if (casoId) {
        await admin.from("entregas_de_aviso_de_caso").delete().eq("case_id", casoId);
        await admin.from("agent_cases").delete().eq("id", casoId);
      }
      await admin.from("channel_sessions").update({ status: canal.status }).eq("id", canal.id);
    }
  });
});
