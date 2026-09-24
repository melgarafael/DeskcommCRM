/**
 * AVISO NO WHATSAPP — a tela que uma instalação NOVA encontra (DoD 12, P0).
 *
 * Esta é a primeira impressão de quem acaba de subir o produto numa VPS e vai
 * ligar o recurso que avisa a equipe quando a IA trava. Ela é `[P0]` por isso:
 * o que esta tela diz (ou deixa de dizer) decide se a pessoa configura ou
 * desiste.
 *
 * ═══ O que esta spec prova ═══
 *
 * 1. **A tela é de quem administra.** Um `manager` não a alcança — ela escolhe
 *    um número conectado e manda dado de cliente para um celular.
 * 2. **Ela declara o estado EFETIVO antes do formulário.** Numa instalação sem
 *    endereço público o produto RECUSA ligar o aviso, diz por quê em português
 *    e deixa o interruptor travado. Configuração aceita que nunca entrega nada
 *    é o pior desfecho possível aqui.
 * 3. **Ela não mente sobre o que o teste faz.** O botão avisa, antes do clique,
 *    que manda mensagem de verdade e conta no limite diário do número.
 * 4. **A recusa é honesta ponta a ponta.** Com o aviso configurado e um caso
 *    aberto de verdade, o dreno do `event_log` NÃO inventa um envio: a entrega
 *    nasce recusada com o motivo, e a tela mostra a linha dizendo isso.
 * 5. **Layout e vocabulário medidos por ferramenta**, nunca a olho.
 *
 * ═══ O que esta spec NÃO prova, e onde isso é provado ═══
 *
 * **O envio de verdade.** `lib/escalacao/aviso-de-teste.ts:116` e
 * `lib/escalacao/aviso-ao-suporte.ts:425` recusam quando
 * `urlPublicaUsavel(env.NEXT_PUBLIC_APP_URL)` é falso, e
 * `scripts/gerar-env-e2e.sh` grava `NEXT_PUBLIC_APP_URL=http://localhost:$E2E_PORT`
 * — ou seja, **no CI o produto nunca envia, por construção**. Quem prova o
 * envio é `tests/e2e/aviso-de-caso-chega-no-whatsapp.spec.ts`, que está em
 * `FORA_DO_CI` com o motivo escrito e cuja prova local está em
 * `evidence/casos-vivos/aviso/`.
 *
 * Isto não é um buraco disfarçado: a recusa É o comportamento de uma instalação
 * nova, e o passo 4 a cobra de verdade em vez de pular o assunto.
 *
 * ═══ Higiene de estado compartilhado ═══
 *
 * `config_aviso_de_caso` tem `organization_id` como CHAVE PRIMÁRIA e toda a
 * suíte divide uma organização. A configuração que esta spec grava é APAGADA no
 * fim — deixá-la de pé faria `central-de-avisos-capacidades` (mesma parte) ver
 * itens que não espera. **Ordem de arquivo não é contrato.**
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence", "casos-vivos", "aviso");
const ESPERA = 60_000;

/** Um número que não é de ninguém nesta bancada — só a equipe recebe aviso. */
const NUMERO_DA_EQUIPE = "+5531988887777";

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
  admin_totp?: { factor_id: string; secret: string };
  escalacao: { conversation_id: string; contact_id: string; case_id: string };
}

const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Ver o comentário do helper homônimo em `conversa-do-caso.spec.ts`. */
async function preencheLogin(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await expect(page.locator("#email")).toBeVisible({ timeout: ESPERA });
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
}

async function loginSimples(page: Page, email: string): Promise<void> {
  let ultimo = "";
  for (let tentativa = 1; tentativa <= 4; tentativa++) {
    await preencheLogin(page, email);
    try {
      await page.waitForURL(/\/app(\/|$)/, { timeout: 25_000 });
      return;
    } catch (erro) {
      ultimo = erro instanceof Error ? erro.message : String(erro);
      await page.waitForTimeout(1_500 * tentativa);
    }
  }
  throw new Error(`login de ${email} falhou nas 4 tentativas — última: ${ultimo}`);
}

/**
 * O admin do cenário tem verificação em duas etapas (é como o seed o cria).
 *
 * ⚠️ **A SEGUNDA TENTATIVA RECARREGA A PÁGINA, e não é zelo.** Enquanto o
 * código está sendo conferido, os seis campos ficam `disabled` **com os dígitos
 * da tentativa anterior dentro**. Um laço que só clicasse de novo ficaria
 * batendo num campo desabilitado até o teste estourar — medido: a spec morreu
 * em `locator.click` depois de 5 minutos, com o log do servidor mostrando a
 * causa real (`canceling statement due to statement timeout` ao resolver as
 * permissões, isto é, o banco engasgado). Recarregar devolve o formulário
 * limpo e habilitado, que é o que a pessoa faria.
 */
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
  const secret = carregarEnvLocal().INTERNAL_SECRET?.trim();
  if (!secret) throw new Error("INTERNAL_SECRET não encontrado no ambiente");
  return secret;
}

test.describe("aviso de caso no WhatsApp", () => {
  test.afterAll(async () => {
    // A configuração e as entregas desta spec somem — ver o cabeçalho.
    await admin.from("entregas_de_aviso_de_caso").delete().eq("organization_id", creds.org_id);
    await admin.from("config_aviso_de_caso").delete().eq("organization_id", creds.org_id);
  });

  test("a tela de uma instalação nova: quem entra, o que ela recusa e por quê", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    expect(creds.admin_totp?.secret, "o seed tem de gravar admin_totp").toBeTruthy();

    // ─── 1. a tela é de quem administra ───────────────────────────────────
    await loginSimples(page, creds.users.manager!.email);
    await page.goto("/app/ai/cases/avisos");
    // ⚠️ `toHaveURL` e NÃO `waitForURL(/\/403|\/app\//)`. O endereço da tela já
    // contém `/app/`, então aquele padrão casa com a URL de PARTIDA e a espera
    // volta antes do redirecionamento — a asserção seguinte então mede a página
    // errada e acusa o produto de deixar entrar quem ele barrou. Medido: a
    // primeira versão desta spec reprovou exatamente assim, com o gate correto.
    await expect(
      page,
      "um manager não pode abrir a tela que escolhe o número e manda dado de cliente",
    ).toHaveURL(/\/403/, { timeout: ESPERA });
    await expect(page.getByRole("heading", { name: "Aviso no WhatsApp" })).toHaveCount(0);
    await captura(page, "10-manager-nao-entra");
    await page.context().clearCookies();

    // ─── 2. o admin entra, com verificação em duas etapas ─────────────────
    await loginComTotp(page, creds.users.admin!.email, creds.admin_totp!.secret);
    await page.goto("/app/ai/cases/avisos");
    await expect(page.getByRole("heading", { name: "Aviso no WhatsApp" })).toBeVisible({
      timeout: ESPERA,
    });
    await captura(page, "20-tela-do-aviso");

    // ─── 3. o estado EFETIVO vem ANTES do formulário ──────────────────────
    //
    // `sem_endereco_publico` é o único alerta que esta spec cobra porque é o
    // único que depende SÓ do ambiente (`NEXT_PUBLIC_APP_URL`), e não do que
    // as specs vizinhas fizeram com canais e agentes desta organização. Cobrar
    // a lista inteira seria cobrar a ordem de execução da suíte.
    const alerta = page.getByTestId("alerta-sem_endereco_publico");
    await expect(
      alerta,
      "sem endereço público o aviso não pode ser ligado — e a tela tem de dizer isso",
    ).toBeVisible({ timeout: ESPERA });
    await expect(alerta).toContainText("Este sistema ainda não tem um endereço na internet");
    await expect(alerta).toContainText(/o link do aviso não abriria nada/i);
    // E o alerta vem antes do formulário no fio do DOM — medido, não suposto.
    const ordem = await page.evaluate(() => {
      const a = document.querySelector('[data-testid="alertas-do-aviso"]');
      const campo = document.querySelector("#conexao");
      if (!a || !campo) return null;
      return (a.compareDocumentPosition(campo) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    });
    expect(ordem, "o formulário tem de vir DEPOIS dos alertas").toBe(true);

    // ─── 4. o interruptor está travado, e o motivo está escrito ───────────
    const interruptor = page.getByRole("switch", { name: "Receber avisos no WhatsApp" });
    await expect(interruptor).toBeDisabled();
    await expect(
      page.getByText(/O aviso sai na hora, inclusive fora do horário comercial/),
      "a decisão de mandar fora do horário é do dono e mora na tela, não num comentário",
    ).toBeVisible();

    // ─── 5. o número: o produto recusa um telefone pela metade ────────────
    await page.locator("#telefone").fill("+5531");
    await expect(page.getByTestId("telefone-invalido")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Salvar$/ })).toBeDisabled();
    await page.locator("#telefone").fill(NUMERO_DA_EQUIPE);
    await expect(page.getByTestId("telefone-invalido")).toHaveCount(0);

    // ─── 6. o seletor fala de CAPACIDADE, nunca de provedor ───────────────
    await expect(
      page.getByText("Só aparecem aqui os números que conseguem mandar uma mensagem a qualquer hora."),
    ).toBeVisible();
    await page.locator("#conexao").click();
    const opcoes = page.getByRole("option");
    await expect(opcoes.first()).toBeVisible({ timeout: ESPERA });
    await opcoes.first().click();
    await expect(page.getByRole("button", { name: /^Salvar$/ })).toBeEnabled();

    // ─── 7. o preço do teste vem ANTES do clique ──────────────────────────
    await expect(
      page.getByText(/O teste manda uma mensagem de verdade e conta no limite diário/),
    ).toBeVisible();
    // E sem nada salvo, o botão de teste nem se oferece.
    await expect(page.getByRole("button", { name: /Enviar aviso de teste/ })).toBeDisabled();

    await page.getByRole("button", { name: /^Salvar$/ }).click();
    await expect(page.getByText("Aviso salvo.").first()).toBeVisible({ timeout: ESPERA });
    await captura(page, "30-configurado-mas-recusado");

    // ─── 8. o teste RECUSA, e diz o motivo em português ───────────────────
    //
    // Nada de "não deu certo": a frase nomeia o que falta e quem resolve.
    await page.getByRole("button", { name: /Enviar aviso de teste/ }).click();
    await expect(
      page.getByText(/endereço público do sistema ainda não foi configurado/i).first(),
      "a recusa do teste tem de dizer o que fazer, não só que falhou",
    ).toBeVisible({ timeout: ESPERA });
    await captura(page, "40-teste-recusado-com-motivo");

    // ─── 9. LAYOUT medido por ferramenta ──────────────────────────────────
    const medida = await page.evaluate(() => {
      const salvar = [...document.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Salvar",
      );
      const campo = document.querySelector("#telefone") as HTMLElement | null;
      if (!salvar || !campo) return null;
      const r = salvar.getBoundingClientRect();
      const estilo = getComputedStyle(salvar);
      return {
        salvar: {
          x: Math.round(r.x),
          largura: Math.round(r.width),
          altura: Math.round(r.height),
          visivel: salvar.offsetParent !== null,
          fonte: estilo.fontFamily,
          fundo: estilo.backgroundColor,
        },
        campoLargura: Math.round(campo.getBoundingClientRect().width),
        rolagemHorizontal:
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
        janela: window.innerWidth,
      };
    });
    expect(medida, "o formulário tem de estar no DOM").not.toBeNull();
    const m = medida!;
    expect(m.salvar.visivel, "o botão Salvar não está alcançável").toBe(true);
    expect(m.salvar.altura).toBeGreaterThanOrEqual(32);
    expect(m.salvar.x + m.salvar.largura).toBeLessThanOrEqual(m.janela);
    expect(m.rolagemHorizontal, "a tela do aviso não pode rolar para o lado").toBeLessThanOrEqual(0);
    expect(m.salvar.fonte).toMatch(/Atkinson/i);
    expect(m.salvar.fundo).not.toBe("rgba(0, 0, 0, 0)");

    // Em largura de telefone continua sem rolagem lateral.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    const noTelefone = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(noTelefone, "em 390px a tela do aviso não pode rolar para o lado").toBeLessThanOrEqual(0);
    await captura(page, "50-telefone");
    await page.setViewportSize({ width: 1440, height: 1000 });

    // ─── 10. sem jargão ───────────────────────────────────────────────────
    const texto = (await page.locator("main").innerText()).toLowerCase();
    for (const proibido of [
      "config_aviso_de_caso",
      "channel_session_id",
      "sem_endereco_publico",
      "undefined",
      "null",
      "waha",
      "http://",
    ])
      expect(texto, `jargão "${proibido}" visível na tela`).not.toContain(proibido);

    // ─── 11. A RECUSA É HONESTA PONTA A PONTA ─────────────────────────────
    //
    // Com o aviso ligado no banco (o interruptor está travado na tela, e é POR
    // ISSO que aqui a chave é virada por fora: o que se prova neste passo é o
    // MOTOR, não o formulário), um caso aberto de verdade dispara o evento e o
    // dreno o consome. O produto não pode "dar certo" com um link que não abre.
    const ligou = await admin
      .from("config_aviso_de_caso")
      .update({ ligado: true })
      .eq("organization_id", creds.org_id);
    expect(ligou.error?.message ?? null, "não consegui ligar o aviso no banco").toBeNull();

    /**
     * O canal precisa estar NO AR para que a recusa medida seja a que esta
     * spec é sobre.
     *
     * A ordem das guardas em `lib/escalacao/aviso-ao-suporte.ts` é canal (8) →
     * endereço público (9). Com a sessão do cenário em `STARTING`, o motor para
     * antes e devolve `canal_desconectado` com `retry` — o que também é honesto,
     * mas responde outra pergunta. Medido: sem esta linha a entrega nasce
     * `pendente/canal_desconectado` e a spec acusaria o endereço de não ter sido
     * cobrado, quando o produto nunca chegou lá.
     */
    /**
     * ⚠️ O canal que precisa estar no ar é O QUE A CONFIGURAÇÃO APONTA, e não
     * "o primeiro da organização".
     *
     * Medido no CI (run 35351866228): a suíte da parte 2 roda dezenas de specs
     * na MESMA organização, e mais de uma conexão existe quando esta spec
     * chega. O `.limit(1)` pegava uma sessão qualquer, a configuração apontava
     * para outra, e o motor parava na guarda de canal — a entrega nascia
     * `pendente/canal_desconectado` e a spec acusava o endereço público de não
     * ter sido cobrado, quando o produto nunca chegou lá. Localmente, com uma
     * conexão só, as duas eram a mesma e o teste passava: o defeito só aparece
     * onde há vizinhos.
     */
    const { data: configuracao } = await admin
      .from("config_aviso_de_caso")
      .select("channel_session_id")
      .eq("organization_id", creds.org_id)
      .single();
    const canalId = (configuracao as { channel_session_id: string | null } | null)?.channel_session_id;
    expect(canalId, "a configuração salva pela tela não tem conexão — o passo anterior não pegou").toBeTruthy();
    const { data: canalAntes } = await admin
      .from("channel_sessions")
      .select("id, status")
      .eq("id", canalId!)
      .single();
    const canal = canalAntes as { id: string; status: string };
    await admin.from("channel_sessions").update({ status: "WORKING" }).eq("id", canal.id);

    const casoNovo = await admin
      .from("agent_cases")
      .insert({
        organization_id: creds.org_id,
        conversation_id: creds.escalacao.conversation_id,
        status: "awaiting_human",
        title: `Caso do aviso ${Date.now()}`,
        summary: "Cliente pediu algo fora da política.",
        blocker: "precisa de alguém com alçada",
        source: "agent",
      })
      .select("id")
      .single();
    expect(casoNovo.error?.message ?? null, "não consegui abrir o caso").toBeNull();
    const casoId = (casoNovo.data as { id: string }).id;

    try {
      // O MESMO dreno da produção, chamado à mão em vez de esperar o cron.
      const dreno = await page.request.post("/api/v1/cron/event-log-drain", {
        headers: { authorization: `Bearer ${segredoInterno()}` },
      });
      expect(dreno.status(), "o dreno tem de responder 200").toBe(200);

      // A entrega existe e NÃO foi enviada — com o motivo gravado, não um
      // genérico. É a diferença entre "recusou por endereço" e "sumiu".
      await expect
        .poll(
          async () => {
            const { data } = await admin
              .from("entregas_de_aviso_de_caso")
              .select("status, erro_codigo")
              .eq("organization_id", creds.org_id)
              .eq("case_id", casoId)
              .maybeSingle();
            return (data as { status: string; erro_codigo: string | null } | null) ?? null;
          },
          { timeout: 30_000, message: "a tentativa de aviso tem de virar linha, mesmo recusada" },
        )
        .toEqual({ status: "falhou", erro_codigo: "sem_endereco_publico" });

      // E a tela mostra a linha — o registro do sistema, em português.
      await page.reload();
      await expect(page.getByTestId("lista-de-entregas")).toBeVisible({ timeout: ESPERA });
      await expect(
        page.getByText(/endereço público do sistema ainda não foi configurado/i).first(),
        "a lista de entregas tem de explicar por que aquele aviso não saiu",
      ).toBeVisible({ timeout: ESPERA });
      await captura(page, "60-entrega-recusada-na-tela");
    } finally {
      await admin.from("entregas_de_aviso_de_caso").delete().eq("case_id", casoId);
      await admin.from("agent_cases").delete().eq("id", casoId);
      // O canal volta ao estado em que estava — ele é da organização inteira.
      await admin
        .from("channel_sessions")
        .update({ status: canal.status })
        .eq("id", canal.id);
    }
  });
});
