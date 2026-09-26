/**
 * QA VISUAL DO LOTE 12 — AGENDA (#931/#933, #915) e CONTATOS (#907).
 *
 * Sem Google real: o que nos cabe provar é o que o CRM ENVIA (a URL de
 * autorização e seus parâmetros) e o que a TELA diz. Que o Google DESENHE o
 * seletor de contas é dedução a partir da documentação dele — fica NÃO MEDIDO.
 */
import { test } from "./helpers/test";

import {
  abreConversa,
  admin,
  captura,
  insere,
  creds,
  expect,
  login,
  registra,
  transbordoDaPagina,
  type Creds,
} from "./qa-l12-comum";

const S = `${Date.now()}`.slice(-6);
const TEM_GOOGLE = (process.env.GOOGLE_CALENDAR_CLIENT_ID ?? "").length > 0;

test.describe("Lote 12 — #931/#933 a ida ao Google", () => {
  test.describe.configure({ timeout: 420_000 });
  let c: Creds;

  test.beforeAll(() => {
    test.setTimeout(420_000);
    c = creds();
  });

  test("instalação SEM Google: a tela explica, e não oferece um botão que não leva a lugar nenhum", async ({
    page,
  }) => {
    test.skip(TEM_GOOGLE, "esta rodada tem GOOGLE_CALENDAR_CLIENT_ID — é a rodada do caso configurado");
    await login(page, c.users.manager!.email, c.password);
    await page.goto("/app/agenda");
    await page.waitForLoadState("networkidle").catch(() => {});
    const retorno = page.locator('[data-testid="endereco-de-retorno"]');
    const temBotao = await page.locator('[data-testid="conectar-google"]').count();
    registra(`#931 fresco · [endereco-de-retorno] = ${await retorno.count()} · [conectar-google] = ${temBotao}`);
    if (await retorno.count()) {
      registra(`#931 fresco · endereço de retorno na tela = "${await retorno.innerText()}"`);
    }
    await captura(page, "931-01-agenda-sem-google");
  });

  test("com o app configurado: o botão leva à rota, e a rota manda prompt=consent select_account", async ({
    page,
  }) => {
    test.skip(!TEM_GOOGLE, "sem GOOGLE_CALENDAR_CLIENT_ID no ambiente desta rodada");
    await login(page, c.users.manager!.email, c.password);
    await page.goto("/app/agenda");
    const botao = page.locator('[data-testid="conectar-google"]');
    await expect(botao).toBeVisible({ timeout: 60_000 });
    const href = await botao.getAttribute("href");
    registra(`#933 · href do botão "Conectar Google" = ${href}`);
    expect(href).toBe("/api/v1/agenda/google/connect");
    await captura(page, "933-02-botao-conectar-google");

    // Barra a ida ao Google e lê o Location que NÓS emitimos.
    await page.route("https://accounts.google.com/**", (rota) => rota.abort());
    const resposta = page.waitForResponse((r) => r.url().includes("/api/v1/agenda/google/connect"));
    await botao.click();
    const r = await resposta;
    const location = r.headers()["location"] ?? "";
    registra(`#933 · status = ${r.status()} · Location = ${location}`);
    expect(r.status()).toBeGreaterThanOrEqual(300);

    const url = new URL(location);
    const p = url.searchParams;
    const medido = {
      host: url.host,
      prompt: p.get("prompt"),
      access_type: p.get("access_type"),
      response_type: p.get("response_type"),
      login_hint: p.get("login_hint"),
      redirect_uri: p.get("redirect_uri"),
      scope: p.get("scope"),
      tem_state: Boolean(p.get("state")),
      client_id: p.get("client_id"),
    };
    registra(`#933 · parâmetros MEDIDOS = ${JSON.stringify(medido, null, 1)}`);
    expect(url.host).toBe("accounts.google.com");
    // O conserto: o Google passa a OFERECER a escolha da conta.
    expect((p.get("prompt") ?? "").split(/[\s+]/)).toEqual(
      expect.arrayContaining(["consent", "select_account"]),
    );
    // E só SUGERE a do login — imposição seria `authuser`/`hd`.
    expect(p.get("login_hint")).toBe(c.users.manager!.email);
    expect(p.get("access_type")).toBe("offline");

    const cookies = await page.context().cookies();
    const vinculo = cookies.find((k) => k.name.includes("google") || k.name.includes("vinculo"));
    registra(`#933 · cookie de vínculo = ${JSON.stringify(vinculo ?? null)}`);
    await captura(page, "933-03-depois-do-clique");
  });
});

// ════════════════════════════════════════════════════════════════════════════
test.describe("Lote 12 — #915 compromisso que cruza a borda da janela", () => {
  test.describe.configure({ timeout: 420_000 });
  let c: Creds;
  let conexaoId = "";

  test.beforeAll(async () => {
    test.setTimeout(420_000);
    c = creds();
    const usuario = c.users.manager!.id;
    await admin
      .from("calendar_connections")
      .delete()
      .eq("organization_id", c.org_id)
      .eq("user_id", usuario)
      .like("account_email", "qa.l12.%");
    conexaoId = await insere("calendar_connections", {
      organization_id: c.org_id,
      user_id: usuario,
      provider: "google_calendar",
      account_email: `qa.l12.${S}@gmail.test`,
      status: "healthy",
      last_sync_at: new Date().toISOString(),
      scopes: ["https://www.googleapis.com/auth/calendar"],
    });
    await insere("calendar_connection_calendars", {
      organization_id: c.org_id,
      connection_id: conexaoId,
      external_calendar_id: `qa.l12.${S}@gmail.test`,
      name: "Pessoal",
      is_primary: true,
      counts_for_conflicts: true,
      is_destination: false,
      access_role: "owner",
      available: true,
      time_zone: "America/Sao_Paulo",
      last_sync_at: new Date().toISOString(),
      sync_coverage: { window_start: "2026-01-01T00:00:00Z", window_end: "2027-12-31T00:00:00Z" },
    });
    // Ontem 23:30 → hoje 00:30, no fuso de São Paulo. Ele ATRAVESSA a borda do
    // dia; a tela de hoje só sabe desenhá-lo se o recorte o cortar na borda.
    const hoje = new Date();
    const ontem2330 = new Date(hoje);
    ontem2330.setDate(hoje.getDate() - 1);
    ontem2330.setHours(23, 30, 0, 0);
    const hoje0030 = new Date(hoje);
    hoje0030.setHours(0, 30, 0, 0);
    await insere("calendar_external_events", {
      organization_id: c.org_id,
      connection_id: conexaoId,
      external_calendar_id: `qa.l12.${S}@gmail.test`,
      external_event_id: `evt-borda-${S}`,
      title: `SEGREDO ${S}`,
      starts_at: ontem2330.toISOString(),
      ends_at: hoje0030.toISOString(),
      is_all_day: false,
      status: "confirmed",
      transparency: "opaque",
    });
    registra(
      `#915 · evento semeado: ${ontem2330.toISOString()} → ${hoje0030.toISOString()} (atravessa a meia-noite)`,
    );
  });

  test.afterAll(async () => {
    test.setTimeout(420_000);
    if (conexaoId) {
      await admin.from("calendar_external_events").delete().eq("connection_id", conexaoId);
      await admin.from("calendar_connection_calendars").delete().eq("connection_id", conexaoId);
      await admin.from("calendar_connections").delete().eq("id", conexaoId);
    }
  });

  test('o bloco aparece como "Ocupado", recortado na borda, e o título sensível NUNCA sai', async ({
    page,
  }) => {
    await login(page, c.users.manager!.email, c.password);

    // A rota que a tela consome, medida pelo corpo.
    const resposta = page.waitForResponse((r) => r.url().includes("/api/v1/agenda/agendamentos"));
    let janela = "";
    await page.goto("/app/agenda");
    await page.waitForLoadState("networkidle").catch(() => {});

    let corpoRota = "";
    try {
      const r = await Promise.race([
        resposta,
        new Promise<null>((res) => setTimeout(() => res(null), 20_000)),
      ]);
      if (r) {
        const resp = r as import("@playwright/test").Response;
        const u = new URL(resp.url());
        janela = `de=${u.searchParams.get("de")} ate=${u.searchParams.get("ate")}`;
        corpoRota = await resp.text();
      }
    } catch {
      /* a página pode servir o primeiro desenho do servidor */
    }
    registra(`#915 · janela PEDIDA pela tela: ${janela}`);
    registra(`#915 · corpo de /agenda/agendamentos = ${corpoRota.slice(0, 1200)}`);
    // A promessa do fragmento: "o instante de começo nunca é anterior ao
    // período, e o de fim nunca é posterior". Sem a janela ao lado, o corpo
    // sozinho não diz se houve recorte — ele só mostra dois instantes.
    if (janela.includes("de=2") && corpoRota.includes("iniciaEm")) {
      const de = new Date(janela.split(" ")[0]!.slice(3));
      const ate = new Date(janela.split(" ")[1]!.slice(4));
      const itens = JSON.parse(corpoRota).data as { iniciaEm: string; terminaEm: string }[];
      for (const it of itens) {
        const recortado =
          new Date(it.iniciaEm) >= de && new Date(it.terminaEm) <= ate;
        registra(
          `#915 · bloco ${it.iniciaEm}→${it.terminaEm} dentro da janela ${de.toISOString()}→${ate.toISOString()}? ${recortado}`,
        );
      }
    }

    const texto = await page.locator("main").innerText();
    registra(`#915 · a tela contém "Ocupado" = ${texto.includes("Ocupado")}`);
    registra(`#915 · a tela contém o título sensível "SEGREDO ${S}" = ${texto.includes(`SEGREDO ${S}`)}`);
    expect(texto, "o título do evento do Google não pode chegar à tela").not.toContain(`SEGREDO ${S}`);
    expect(corpoRota, "nem à rota").not.toContain(`SEGREDO ${S}`);
    await captura(page, "915-04-agenda-com-bloco-ocupado");
  });
});

// ════════════════════════════════════════════════════════════════════════════
test.describe("Lote 12 — #907 o nome editado vence o nome do perfil do WhatsApp", () => {
  test.describe.configure({ timeout: 420_000 });
  let c: Creds;
  let contatoId = "";
  let conversaId = "";

  test.beforeAll(async () => {
    test.setTimeout(420_000);
    c = creds();
    // Nasce SÓ com o nome do perfil do WhatsApp.
    contatoId = await insere("contacts", {
      organization_id: c.org_id,
      display_name: `Ze do Pix ${S}`,
      phone_number: `+55118${S}`,
    });
    const canal = await insere("channel_sessions", {
      organization_id: c.org_id,
      waha_session_name: `qa-l12-nome-${S}`,
      display_name: "Canal Nome",
      status: "WORKING",
      webhook_secret_encrypted: "\\x00",
    });
    conversaId = await insere("conversations", {
      organization_id: c.org_id,
      contact_id: contatoId,
      channel_session_id: canal,
      status: "open",
    });
    await insere("messages", {
      organization_id: c.org_id,
      contact_id: contatoId,
      conversation_id: conversaId,
      channel_session_id: canal,
      direction: "inbound",
      type: "text",
      status: "received",
      sent_via: "ai",
      body: "Bom dia",
      sent_at: new Date().toISOString(),
    });
  });

  test.afterAll(async () => {
    test.setTimeout(420_000);
    if (contatoId) await admin.from("contacts").delete().eq("id", contatoId);
  });

  test("antes de editar mostra o nome do WhatsApp; depois de editar pela tela, o escolhido vence", async ({
    page,
  }) => {
    await login(page, c.users.manager!.email, c.password);

    await page.goto(`/app/contacts/${contatoId}`);
    await expect(page.getByText(`Ze do Pix ${S}`).first()).toBeVisible({ timeout: 60_000 });
    registra(`#907 · antes de editar, a ficha mostra o nome do perfil do WhatsApp`);
    await captura(page, "907-05-ficha-com-nome-do-whatsapp");

    // Editar PELA TELA — nada de PATCH direto.
    await page.getByRole("button", { name: "Editar", exact: true }).first().click();
    await expect(page.locator("#ec-name")).toBeVisible({ timeout: 30_000 });
    await page.locator("#ec-name").fill(`Maria Silva ${S}`);
    const resposta = page.waitForResponse(
      (r) => r.url().includes(`/contacts/${contatoId}`) && r.request().method() === "PATCH",
    );
    await page.getByRole("button", { name: "Salvar", exact: true }).click();
    const r = await resposta;
    registra(`#907 · PATCH do nome = ${r.status()}`);
    expect(r.status()).toBe(200);

    const { data } = await admin
      .from("contacts")
      .select("name, display_name")
      .eq("id", contatoId)
      .single();
    registra(`#907 · banco = ${JSON.stringify(data)} (as DUAS colunas continuam preenchidas)`);
    expect((data as { display_name: string }).display_name).toBe(`Ze do Pix ${S}`);

    await page.reload();
    // Esperar o que é DETERMINÍSTICO antes de medir: a ficha é cliente e busca
    // sozinha; ler `innerText` logo depois do reload mede a casca vazia.
    await expect(page.getByText(`Maria Silva ${S}`).first()).toBeVisible({ timeout: 60_000 });
    const ficha = await page.locator("main").innerText();
    registra(`#907 ficha · "Maria Silva" = ${ficha.includes(`Maria Silva ${S}`)} · "Ze do Pix" = ${ficha.includes(`Ze do Pix ${S}`)}`);
    expect(ficha).toContain(`Maria Silva ${S}`);
    await captura(page, "907-06-ficha-com-nome-escolhido");

    // ── O Inbox: lista, cabeçalho e painel ────────────────────────────────
    await abreConversa(page, conversaId);
    await expect(page.getByText(`Maria Silva ${S}`).first()).toBeVisible({ timeout: 60_000 });
    await page.waitForLoadState("networkidle").catch(() => {});
    const inbox = await page.locator("body").innerText();
    registra(`#907 inbox · "Maria Silva" = ${inbox.includes(`Maria Silva ${S}`)} · "Ze do Pix" = ${inbox.includes(`Ze do Pix ${S}`)}`);
    expect(inbox).toContain(`Maria Silva ${S}`);
    expect(inbox, "o nome do perfil não pode sobrar em canto nenhum do Inbox").not.toContain(
      `Ze do Pix ${S}`,
    );
    await captura(page, "907-07-inbox-com-nome-escolhido");

    // ── A NOTIFICAÇÃO do navegador ───────────────────────────────────────
    // `useInboundMessageAlerts` monta o título com `nomeDoContato(row)` sobre a
    // MESMA linha que a lista de conversas recebe. Medir a linha é medir o
    // título; simular a permissão de notificação não acrescentaria nada.
    const resp = await page.request.get(`/api/v1/conversations?limit=50`);
    const corpo = await resp.text();
    registra(`#907 · GET /api/v1/conversations = ${resp.status()} · contém "Maria Silva" = ${corpo.includes(`Maria Silva ${S}`)} · contém "Ze do Pix" = ${corpo.includes(`Ze do Pix ${S}`)}`);
  });
});
