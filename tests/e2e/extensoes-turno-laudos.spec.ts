import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { decidirDoFluxo, type EstadoDoFluxo } from "../../lib/extensions/fluxo-do-turno";
import { parseManifest } from "../../lib/extensions/manifest";
import { expect as expectBase, test, type Page } from "./helpers/test";
import { criarAtoresDasExtensoes } from "./fixtures/catalogo-extensoes";
import { criarCatalogoDoTurno } from "./fixtures/catalogo-turno-laudos";
import { criarProvedoresDoTurnoLaudos, RESPOSTA_DA_IA } from "./fixtures/provedores-turno-laudos";
import { criarTurnosDoLaudo, type ConversaDoLaudo } from "./fixtures/turno-laudos";

const expect = expectBase.configure({ timeout: 15_000 });
const EVIDENCIA = "evidence/extensoes/turno-laudos";
const ORGANIZACAO_ESPERADA = "X-Expected-Organization-Id";
const CASOS = [
  { id: "TL01", prova: "catálogo, bytes e instalação fresca sem aceite", imagem: "01-sem-aceite.png" },
  { id: "TL02", prova: "viewer não concede e efeitos não concedem contexto", imagem: "02-aceite-separado.png" },
  { id: "TL03", prova: "biópsia, radiologia e patologia em par; dois provedores configurados", imagem: "03-passagem.png" },
  { id: "TL04", prova: "saudação devolve à IA com SDK e HTTP dos dois provedores", imagem: "04-retorno-ia.png" },
  { id: "TL05", prova: "contexto exige aceite, mesma organização e mesma conversa", imagem: "05-contexto.png" },
  { id: "TL06", prova: "org B não herda aceite nem contexto", imagem: "06-outra-organizacao.png" },
  { id: "TL07", prova: "reconfigurar, desligar e reativar encerram estado antigo", imagem: "07-desativada.png" },
] as const;

test.use({ trace: "on", viewport: { width: 1440, height: 1000 } });

async function entrar(page: Page, email: string, senha: string) {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/senha/i).fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(?:\/|$)/, { timeout: 45_000 });
}

async function trocarOrganizacao(page: Page, id: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByTestId("tenant-switcher").click();
  const item = page.getByTestId(`tenant-switcher-item-${id}`);
  if ((await item.getByText("✓", { exact: true }).count()) > 0) {
    await page.keyboard.press("Escape"); return;
  }
  const documento = page.waitForEvent("load", { timeout: 30_000 });
  await item.click({ noWaitAfter: true }); await documento;
}

/**
 * Uma única jornada, com 240s INCLUINDO setup e subpassos. Não são sete testes
 * de 240s: o orçamento da parte 2 continua o mesmo. A duração só será medida no CI.
 */
test("TL01–TL07: aceite do turno e laudos atravessam UI, banco, handler e SDKs", async ({ page, browser }, info) => {
  test.setTimeout(240_000);
  const inicio = Date.now();
  await mkdir(EVIDENCIA, { recursive: true });
  const atores = await criarAtoresDasExtensoes();
  let catalogo: Awaited<ReturnType<typeof criarCatalogoDoTurno>> | undefined;
  let provedores: Awaited<ReturnType<typeof criarProvedoresDoTurnoLaudos>> | undefined;
  let turnos: Awaited<ReturnType<typeof criarTurnosDoLaudo>> | undefined;
  let instalacao = "";
  const concluidos: string[] = [];
  const erroBrowser: string[] = [];
  const rodadas: Array<{ caso: string; provedor: string; chamadas_sdk: number; chamadas_db: number; bolhas: number }> = [];
  page.on("pageerror", () => erroBrowser.push("pageerror"));
  page.on("console", (msg) => { if (msg.type() === "error") erroBrowser.push("console.error"); });
  const fotografar = async (caso: typeof CASOS[number]) => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: `${EVIDENCIA}/${caso.imagem}`, fullPage: true });
  };
  try {
    catalogo = await criarCatalogoDoTurno(atores.db, EVIDENCIA);
    provedores = await criarProvedoresDoTurnoLaudos();
    turnos = await criarTurnosDoLaudo(atores, provedores.registry);
    const manifesto = parseManifest(new Uint8Array(await readFile("extensoes/pacotes/deskcomm/consulta-de-laudos-1.0.0.json")));
    const fluxo = manifesto.contributions.turn_flow;
    if (!fluxo) throw new Error("Consumidor real sem fluxo do turno.");
    const identidade = `${manifesto.publisher}/${manifesto.name}`;
    const configuracao = () => `/api/v1/extensions/${instalacao}/configuration`;
    const vinculo = async (org = atores.organizacaoA) => {
      const { data, error } = await atores.db.from("organization_extensions")
        .select("enabled,revision,accepted_permissions").eq("organization_id", org).eq("installation_id", instalacao).maybeSingle();
      if (error) throw new Error(error.message);
      return data;
    };
    const salvar = async () => {
      const resposta = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith(configuracao()));
      await page.getByTestId(`extension-save-${instalacao}`).click();
      expect((await resposta).status()).toBe(200);
      await expect(page.getByTestId(`extension-save-${instalacao}`)).toBeDisabled();
    };
    const gerir = async () => { await page.goto("/app/extensions"); await page.getByRole("tab", { name: "Instaladas" }).click(); };
    const executar = async (c: ConversaDoLaudo, texto: string, usaIa: boolean, caso: string) => {
      provedores!.beginTurn(c.provedor, usaIa);
      const entregasAntes = turnos!.totalEntregas();
      const r = await turnos!.executar(c, texto);
      provedores!.assertHealthy();
      const chamadas = provedores!.snapshot().requests;
      expect(r.bolhas).toHaveLength(1);
      expect(r.bolhas[0]!.status).toBe("accepted");
      expect(turnos!.totalEntregas() - entregasAntes).toBe(1);
      if (usaIa) {
        expect(chamadas).toBeGreaterThan(0);
        expect(r.chamadas.length).toBeGreaterThan(0);
        expect(r.chamadas.every((x) => x.provider === c.provedor && x.status === "ok")).toBe(true);
        expect(r.bolhas[0]!.body).toContain(RESPOSTA_DA_IA);
      } else {
        expect(chamadas).toBe(0); expect(r.chamadas).toHaveLength(0);
      }
      rodadas.push({ caso, provedor: c.provedor, chamadas_sdk: chamadas, chamadas_db: r.chamadas.length, bolhas: r.bolhas.length });
      return r;
    };

    await test.step("TL01: admite e instala os bytes reais; instalar não autoriza", async () => {
      await entrar(page, atores.usuarios.owner.email, atores.senha);
      await trocarOrganizacao(page, atores.organizacaoA);
      await page.goto("/app/extensions");
      await page.getByTestId("extension-catalog-file").setInputFiles(catalogo!.catalogo);
      await page.getByTestId("extension-catalog-submit").click();
      await expect(page.getByText("Catálogo admitido e disponível para instalação.")).toBeVisible();
      await page.getByRole("tab", { name: "Catálogo" }).click();
      await page.getByTestId(`extension-install-${manifesto.publisher}-${manifesto.name}-${manifesto.version}`).click();
      await expect.poll(async () => {
        const { data, error } = await atores.db.from("extension_installations")
          .select("id,artifact_id").eq("publisher", manifesto.publisher).eq("name", manifesto.name).eq("version", manifesto.version).single();
        if (error) return null;
        instalacao = data.id as string;
        return data;
      }).not.toBeNull();
      const { data: artefato, error } = await atores.db.from("extension_artifacts")
        .select("document,sha256").eq("sha256", catalogo!.digest).single();
      if (error) throw new Error(error.message);
      expect(Buffer.from(artefato.document as string)).toEqual(catalogo!.bytes);
      expect(await vinculo()).toBeNull();
      await gerir();
      await expect(page.getByTestId(`extension-pending-permissions-${instalacao}`)).toContainText("Enquanto você não aceitar, ela não responde ao cliente.");
      await fotografar(CASOS[0]); concluidos.push("TL01");
    });

    await test.step("TL02: viewer não concede; aceite de efeitos preserva contexto desligado", async () => {
      const contextoViewer = await browser.newContext();
      try {
        const viewer = await contextoViewer.newPage();
        await entrar(viewer, atores.usuarios.viewerA.email, atores.senha);
        await viewer.goto("/app/extensions");
        await expect(viewer.getByTestId(`extension-accept-permissions-${instalacao}`)).toHaveCount(0);
        const negada = await viewer.request.put(configuracao(), {
          headers: { "Idempotency-Key": randomUUID(), [ORGANIZACAO_ESPERADA]: atores.organizacaoA },
          data: { expected_revision: 0, enabled: true, configuration: manifesto.configuration,
            accept_permissions: ["turn.send", "turn.handoff", "turn.context"] },
        });
        expect(negada.status()).toBe(403); expect(await vinculo()).toBeNull();
      } finally { await contextoViewer.close(); }
      const semAceite = await page.request.put(configuracao(), {
        headers: { "Idempotency-Key": randomUUID(), [ORGANIZACAO_ESPERADA]: atores.organizacaoA },
        data: { expected_revision: 0, enabled: true, configuration: manifesto.configuration },
      });
      expect(semAceite.status()).toBe(409);
      expect(await semAceite.json()).toMatchObject({ error: { code: "extension_permission_not_accepted" } });
      await page.getByTestId(`extension-accept-permissions-${instalacao}`).click();
      await expect.poll(vinculo).toMatchObject({ enabled: false, accepted_permissions: ["turn.send", "turn.handoff"] });
      await expect(page.getByRole("button", { name: "Autorizar contexto desta conversa", exact: true })).toBeVisible();
      await page.getByTestId(`extension-enabled-${instalacao}`).click(); await salvar();
      expect(await vinculo()).toMatchObject({ enabled: true, accepted_permissions: ["turn.send", "turn.handoff"] });
      await fotografar(CASOS[1]); concluidos.push("TL02");
    });

    let conversaPassada: ConversaDoLaudo | undefined;
    let conversaDevolvida: ConversaDoLaudo | undefined;
    await test.step("TL03 e TL04: mesmo texto em par, coleta sem modelo e devolução com SDK real", async () => {
      for (const provedor of ["anthropic", "openai"] as const) {
        for (const textos of [
          ["Where is my biopsy report?", "Pessoa Sintética", "12/10/2026", "Dr. Sen"],
          ["Where is my radiology report?", "Pessoa Sintética, 12/10/2026, test: ECG"],
          ["Is my blood report ready?"],
          ["Where is my report?", "1"],
        ]) {
          const c = await turnos!.novaConversa(provedor);
          let estado: EstadoDoFluxo | null = null;
          for (const texto of textos) {
            const pura = decidirDoFluxo(fluxo, identidade, estado, { texto, agora: new Date().toISOString() });
            expect(["perguntar", "passar"]).toContain(pura.acao);
            const r = await executar(c, texto, false, "TL03");
            if (pura.acao === "perguntar") {
              expect(r.bolhas[0]!.body).toContain(pura.texto); estado = pura.estado;
              expect(await turnos!.estado(c)).toMatchObject({ campos: estado.campos, etapa: estado.etapa });
            } else if (pura.acao === "passar") {
              expect(r.bolhas[0]!.body).toContain(pura.aviso);
              const passagens = await turnos!.passagem(c);
              expect(passagens).toHaveLength(1);
              expect(passagens[0]).toMatchObject({ cliente_avisado: true, motivo_codigo: "verificacao_manual" });
              for (const valor of Object.values(pura.campos)) expect(passagens[0].body).toContain(valor);
              expect(await turnos!.estado(c)).toBeNull();
              // Patologia passa no primeiro turno; só a coleta que foi aberta
              // antes da passagem tem atividade de assumir.
              expect((await turnos!.atividades(c)).some((x) => x.type === "extension_turn_assumed")).toBe(estado !== null);
              if ("exame" in pura.campos) conversaPassada = c;
            }
          }
        }
        const c = await turnos!.novaConversa(provedor);
        const pura = decidirDoFluxo(fluxo, identidade, null, { texto: "Where is my biopsy report?", agora: new Date().toISOString() });
        if (pura.acao !== "perguntar") throw new Error("Par da saudação precisa de coleta aberta.");
        await executar(c, "Where is my biopsy report?", false, "TL04");
        expect(decidirDoFluxo(fluxo, identidade, pura.estado, { texto: "hello", agora: new Date().toISOString() })).toMatchObject({ acao: "devolver", porque: "fora_do_fluxo" });
        await executar(c, "hello", true, "TL04");
        expect(await turnos!.estado(c)).toBeNull();
        expect((await turnos!.atividades(c)).map((x) => x.type)).toEqual(["extension_turn_assumed", "extension_turn_returned"]);
        conversaDevolvida = c;
      }
      await page.goto(`/app/inbox?id=${conversaPassada!.conversa}&filter=all`);
      await expect(page.getByText("Your report status needs a manual check at the lab. I am passing this to a colleague at the front desk now.", { exact: false }).first()).toBeVisible();
      const cartao = page.getByTestId("cartao-passagem");
      await expect(cartao).toBeVisible();
      for (const campo of ["Pessoa Sintética", "12/10/2026", "ECG"]) await expect(cartao).toContainText(campo);
      await expect(cartao.getByTestId("passagem-aviso-ao-cliente")).toContainText("O cliente já foi avisado");
      await fotografar(CASOS[2]);
      await page.goto(`/app/inbox?id=${conversaDevolvida!.conversa}&filter=all`);
      await expect(page.getByText(RESPOSTA_DA_IA, { exact: false }).first()).toBeVisible();
      await fotografar(CASOS[3]); concluidos.push("TL03", "TL04");
    });

    await test.step("TL05: contexto real é opcional e restrito à conversa selecionada", async () => {
      const semContexto = await turnos!.novaConversa("anthropic");
      await turnos!.mensagem(semContexto, "Your radiology appointment is registered.", "outbound");
      const sem = await executar(semContexto, "Where is my report?", false, "TL05");
      expect(sem.bolhas[0]!.body).toContain("Which service is this report for?");
      await gerir();
      await page.getByRole("button", { name: "Autorizar contexto desta conversa", exact: true }).click();
      await expect.poll(vinculo).toMatchObject({ accepted_permissions: ["turn.send", "turn.handoff", "turn.context"] });
      const comContexto = await turnos!.novaConversa("anthropic");
      await turnos!.mensagem(comContexto, "Your radiology appointment is registered.", "outbound");
      const com = await executar(comContexto, "Where is my report?", false, "TL05");
      expect(com.bolhas[0]!.body).toContain("Patient name, as on the registration?");
      expect(await turnos!.estado(comContexto)).toMatchObject({ campos: { categoria: "radiologia" } });
      const vizinha = await turnos!.novaConversa("anthropic", atores.organizacaoA, comContexto.contato);
      const deFora = await executar(vizinha, "Where is my report?", false, "TL05");
      expect(deFora.bolhas[0]!.body).toContain("Which service is this report for?");
      await fotografar(CASOS[4]); concluidos.push("TL05");
    });

    await test.step("TL06: o aceite de A não ativa nem concede contexto em B", async () => {
      await trocarOrganizacao(page, atores.organizacaoB); await gerir();
      await expect(page.getByTestId(`extension-pending-permissions-${instalacao}`)).toBeVisible();
      expect(await vinculo(atores.organizacaoB)).toBeNull();
      const c = await turnos!.novaConversa("openai", atores.organizacaoB);
      await turnos!.mensagem(c, "Your radiology appointment is registered.", "outbound");
      await executar(c, "Where is my report?", true, "TL06");
      expect(await turnos!.estado(c)).toBeNull(); expect(await turnos!.passagem(c)).toHaveLength(0);
      // Nem o aceite OPCIONAL de A é herdado: B aceita só efeitos e continua
      // perguntando categoria apesar do marcador no seu próprio OUTBOUND.
      await page.getByTestId(`extension-accept-permissions-${instalacao}`).click();
      await expect.poll(() => vinculo(atores.organizacaoB)).toMatchObject({ accepted_permissions: ["turn.send", "turn.handoff"] });
      await page.getByTestId(`extension-enabled-${instalacao}`).click(); await salvar();
      const semLeitura = await turnos!.novaConversa("openai", atores.organizacaoB);
      await turnos!.mensagem(semLeitura, "Your radiology appointment is registered.", "outbound");
      expect((await executar(semLeitura, "Where is my report?", false, "TL06")).bolhas[0]!.body).toContain("Which service is this report for?");
      await fotografar(CASOS[5]); concluidos.push("TL06");
      await trocarOrganizacao(page, atores.organizacaoA); await gerir();
    });

    await test.step("TL07: hot config, desativação e reativação invalidam a coleta", async () => {
      const reconfigurada = await turnos!.novaConversa("anthropic");
      await executar(reconfigurada, "Where is my biopsy report?", false, "TL07");
      await page.getByTestId(`extension-density-${instalacao}`).click();
      await page.getByRole("option", { name: "Compacta", exact: true }).click(); await salvar();
      await executar(reconfigurada, "Pessoa Sintética", true, "TL07");
      expect(await turnos!.estado(reconfigurada)).toBeNull();
      expect((await turnos!.atividades(reconfigurada)).at(-1)?.payload).toMatchObject({ motivo: "revisao_alterada" });
      const desligada = await turnos!.novaConversa("openai");
      await executar(desligada, "Where is my biopsy report?", false, "TL07");
      await page.getByTestId(`extension-enabled-${instalacao}`).click(); await salvar();
      expect(await vinculo()).toMatchObject({ enabled: false });
      await fotografar(CASOS[6]);
      await executar(desligada, "Pessoa Sintética", true, "TL07");
      expect(await turnos!.estado(desligada)).toBeNull();
      expect((await turnos!.atividades(desligada)).at(-1)?.payload).toMatchObject({ motivo: "extensao_nao_dirige_mais" });
      await page.getByTestId(`extension-enabled-${instalacao}`).click(); await salvar();
      const reativada = await turnos!.novaConversa("openai");
      await executar(reativada, "Where is my biopsy report?", false, "TL07");
      await page.getByTestId(`extension-enabled-${instalacao}`).click(); await salvar();
      await page.getByTestId(`extension-enabled-${instalacao}`).click(); await salvar();
      await executar(reativada, "Pessoa Sintética", true, "TL07");
      expect(await turnos!.estado(reativada)).toBeNull();
      expect((await turnos!.atividades(reativada)).at(-1)).toMatchObject({ type: "extension_turn_returned", payload: { motivo: "revisao_alterada" } });
      concluidos.push("TL07");
    });
    expect(erroBrowser).toEqual([]);
    expect(concluidos).toEqual(CASOS.map((x) => x.id));
  } finally {
    await writeFile(`${EVIDENCIA}/manifesto.json`, JSON.stringify({
      test: "extensoes-turno-laudos.spec.ts", deadline_ms: 240_000, elapsed_before_cleanup_ms: Date.now() - inicio,
      cases: CASOS.map((x) => ({ ...x, imagem: `${EVIDENCIA}/${x.imagem}`, passed: concluidos.includes(x.id) })),
      rounds: rodadas, browser_errors: erroBrowser,
      scope: "Browser/API/Postgres/handler/SDK HTTP locais; não mede fornecedor externo nem egress do registry padrão.",
    }, null, 2));
    await info.attach("manifesto-turno-laudos", { path: `${EVIDENCIA}/manifesto.json`, contentType: "application/json" });
    await turnos?.close(); await provedores?.close(); await catalogo?.limpar(); await atores.limpar();
  }
});
