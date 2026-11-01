/**
 * Wave 1 — CORE 1: a IA é dona do negócio. Prova visual dos 4 cenários da §7.
 *
 * 1. Atribuir lead a um agente pela UI → avatar VAZADO COM ANEL + tooltip
 *    "Nome · vN". Falha se aparecer "Sem responsável" ou emoji.
 * 2. Filtro "Responsável" lista agentes JUNTO dos humanos e filtra certo.
 * 3. Transferir agente→humano e humano→agente; ambos persistem após reload.
 * 4. `viewer` NÃO consegue reatribuir (RBAC intacto).
 *
 * Mais axe-core (sem violação nova) e a foto do board para o teste do metro.
 *
 * O lead usado volta a "Sem responsável" no fim, pela própria UI — o fixture
 * sai como entrou.
 *
 * Run: E2E_PORT=3020 npx tsx tests/capture-wave-1.ts
 */

import AxeBuilder from "@axe-core/playwright";
import { chromium, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";

import { CREDS, EVIDENCE, cardLocator, gotoBoard, login, shotCard, shotPage } from "./qa-helpers";
import { carregarEnvLocal } from "../scripts/lib/env-de-teste";

/** Lead do seed que nasce sem dono — é ele que exercita as transferências. */
const LEAD = "Marina Costa — clareamento";

/** Donos-agente que o seed já cria (Wave 1). Cobrem os DOIS casos de tooltip. */
const LEAD_AGENTE_COM_VERSAO = "Rogério Paiva — avaliação inicial"; // Lia — AgendaPlus · v24
const LEAD_AGENTE_SEM_VERSAO = "Caio Ribeiro — dor de dente"; // Bot Padrão E2E, sem versão

const results: { n: number; nome: string; ok: boolean; detalhe: string }[] = [];
function record(n: number, nome: string, ok: boolean, detalhe: string): void {
  results.push({ n, nome, ok, detalhe });
  console.info(`${ok ? "PASS" : "FALHA"}  [cenário ${n}] ${nome} — ${detalhe}`);
}

/** Agente destino: mesma regra do endpoint /assignable (não arquivado + ativo). */
async function pickAgent(): Promise<{ id: string; name: string; version: number | null }> {
  const env = carregarEnvLocal();
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await admin
    .from("ai_agents")
    .select("id,name,published_version_id,is_active")
    .eq("organization_id", CREDS.org_id)
    .is("archived_at", null)
    .eq("is_active", true)
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw new Error(`ai_agents: ${error.message}`);
  const agent = (data ?? [])[0] as { id: string; name: string; published_version_id: string | null };
  if (!agent) throw new Error("nenhum agente ativo e não-arquivado na org — cenário 1 impossível");

  let version: number | null = null;
  if (agent.published_version_id) {
    const { data: v } = await admin
      .from("ai_agent_versions")
      .select("version_number")
      .eq("id", agent.published_version_id)
      .maybeSingle();
    version = (v as { version_number: number } | null)?.version_number ?? null;
  }
  return { id: agent.id, name: agent.name, version };
}

/** Abre o menu ⋮ do card e entra no submenu "Responsável". */
async function openOwnerMenu(page: Page, title: string): Promise<void> {
  const { card } = await cardLocator(page, title);
  await card.hover();
  const trigger = card.getByRole("button", { name: "Ações da oportunidade" });
  if ((await trigger.count()) === 0) {
    throw new Error(`[cenário] card "${title}" sem botão "Ações da oportunidade"`);
  }
  await trigger.click();
  const sub = page.getByRole("menuitem", { name: "Responsável" });
  await sub.waitFor({ state: "visible", timeout: 10_000 });
  await sub.click();
}

/** Estado do dono desenhado no card: forma do avatar + rótulo + tooltip. */
async function ownerState(page: Page, title: string) {
  const { card } = await cardLocator(page, title);
  return card.evaluate((el: Element) => {
    const txt = el.textContent ?? "";
    const badge = el.querySelector("[aria-label^='Responsável:']");
    const avatar = badge?.querySelector("span[aria-hidden]");
    const cls = avatar?.className ?? "";
    return {
      semResponsavel: /Sem responsável/.test(txt),
      tooltip: badge?.getAttribute("title") ?? null,
      ariaLabel: badge?.getAttribute("aria-label") ?? null,
      iniciais: avatar?.textContent?.trim() ?? null,
      // agente = círculo vazado (border + ring, fundo transparente)
      vazadoComAnel: /border/.test(cls) && /ring/.test(cls),
      preenchido: /bg-accent-soft/.test(cls),
      temEmoji: /\p{Extended_Pictographic}/u.test(txt),
      temBadgeAI: /\bAI\b/.test(txt),
    };
  });
}

async function main(): Promise<void> {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const agent = await pickAgent();
  console.info(
    `[setup] agente destino: "${agent.name}"${agent.version != null ? ` v${agent.version}` : " (sem versão publicada)"}`,
  );

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  await login(page, "manager");
  await gotoBoard(page);

  // ---- Cenário 1a: os donos-agente que o seed já criou ---------------------
  // Dois tooltips, dois casos: agente COM versão publicada e agente SEM.
  const comVersao = await ownerState(page, LEAD_AGENTE_COM_VERSAO);
  record(
    1,
    `dono-agente do seed com versão publicada (${LEAD_AGENTE_COM_VERSAO.slice(0, 20)}…)`,
    comVersao.vazadoComAnel && / · v\d+$/.test(comVersao.tooltip ?? "") && !comVersao.temEmoji && !comVersao.temBadgeAI,
    `vazadoComAnel=${comVersao.vazadoComAnel} tooltip="${comVersao.tooltip}" emoji=${comVersao.temEmoji} badgeAI=${comVersao.temBadgeAI}`,
  );
  await shotCard(page, LEAD_AGENTE_COM_VERSAO, "wave-1-cenario-1-agente-com-versao.png");

  const semVersao = await ownerState(page, LEAD_AGENTE_SEM_VERSAO);
  const tooltipSemVersao = semVersao.tooltip ?? "";
  record(
    1.2 as unknown as number,
    "agente SEM versão publicada: tooltip só com o nome, sem ' · v' pendurado nem 'undefined'",
    semVersao.vazadoComAnel &&
      !/ · v/.test(tooltipSemVersao) &&
      !/undefined|null|NaN/i.test(tooltipSemVersao) &&
      tooltipSemVersao.length > 0,
    `tooltip="${tooltipSemVersao}" vazadoComAnel=${semVersao.vazadoComAnel}`,
  );
  await shotCard(page, LEAD_AGENTE_SEM_VERSAO, "wave-1-cenario-1-agente-sem-versao.png");

  // O agente é PAR do humano (§5): mesmo diâmetro, não um enfeite menor.
  // Sem função nomeada dentro do evaluate: o esbuild injeta um helper `__name`
  // que não existe no navegador e o script quebra com ReferenceError.
  const dims = await page.evaluate((titulos: string[]) => {
    const out: ({ w: number; h: number; peso: string } | null)[] = [];
    const cards = Array.from(document.querySelectorAll("[data-rfd-draggable-id]"));
    for (const titulo of titulos) {
      let achado: { w: number; h: number; peso: string } | null = null;
      for (const card of cards) {
        if (!(card.textContent ?? "").includes(titulo)) continue;
        const av = card.querySelector("[aria-label^='Responsável:'] span[aria-hidden]");
        if (!av) break;
        const r = av.getBoundingClientRect();
        achado = {
          w: Math.round(r.width),
          h: Math.round(r.height),
          peso: getComputedStyle(av).fontWeight,
        };
        break;
      }
      out.push(achado);
    }
    return { agente: out[0]!, humano: out[1]! };
  }, [LEAD_AGENTE_COM_VERSAO, "Clínica Vitalis — implantes"]);
  record(
    1.3 as unknown as number,
    "avatar do agente tem MESMO tamanho e peso do humano (§5)",
    !!dims.agente &&
      !!dims.humano &&
      dims.agente.w === dims.humano.w &&
      dims.agente.h === dims.humano.h &&
      dims.agente.peso === dims.humano.peso,
    `agente=${JSON.stringify(dims.agente)} humano=${JSON.stringify(dims.humano)}`,
  );

  // ---- Cenário 2: filtro lista agentes junto dos humanos --------------------
  // Roda ANTES de qualquer atribuição nova: assim "filtrar por Lia devolve só o
  // Rogério" é uma afirmação sobre o seed, não sobre o que o teste acabou de criar.
  const ownerFilter = page.getByRole("button", { name: /^Responsável:/ });
  await ownerFilter.click();
  const menuItens = await page.getByRole("menuitem").allTextContents();
  const temHumano = menuItens.some((t) => /E2E (Admin|Manager|Agent)/.test(t));
  const temAgente = menuItens.some((t) => t.includes(agent.name));
  record(
    2,
    "filtro lista agentes JUNTO dos humanos",
    temHumano && temAgente,
    `humano=${temHumano} agente=${temAgente} · itens: ${menuItens.join(" | ").slice(0, 170)}`,
  );

  // "Junto" não é só "ambos aparecem no mesmo menu": um separador entre o último
  // humano e o primeiro agente SEGREGA a lista, e a asserção acima passaria feliz.
  // Este é o teste que reprova a segregação — o anterior, sozinho, era frouxo.
  const segregacao = await page.evaluate((nomeAgente: string) => {
    const itens = Array.from(
      document.querySelectorAll('[role="menuitem"], [role="separator"]'),
    );
    let ultimoHumano = -1;
    let primeiroAgente = -1;
    itens.forEach((el, i) => {
      const t = (el.textContent ?? "").trim();
      if (el.getAttribute("role") !== "menuitem") return;
      // O item agora traz o avatar junto do nome ("EA" + "E2E Admin"), então a
      // detecção casa por INCLUSÃO. "Eu" é opção meta (fica acima da lista de
      // pessoas) e não conta como humano da lista.
      if (t === "Eu") return;
      if (/E2E (Admin|Manager|Agent)/.test(t)) ultimoHumano = i;
      if (primeiroAgente === -1 && t.includes(nomeAgente)) primeiroAgente = i;
    });
    if (ultimoHumano === -1 || primeiroAgente === -1) {
      return { medivel: false, separadoresEntre: -1, ordem: itens.map((e) => (e.textContent ?? "").trim().slice(0, 18)) };
    }
    const inicio = Math.min(ultimoHumano, primeiroAgente);
    const fim = Math.max(ultimoHumano, primeiroAgente);
    const separadoresEntre = itens
      .slice(inicio + 1, fim)
      .filter((e) => e.getAttribute("role") === "separator").length;
    return { medivel: true, separadoresEntre, ordem: [] as string[] };
  }, agent.name);
  record(
    2.2 as unknown as number,
    "sem separador segregando agentes dos humanos (a lista é MESMA de verdade)",
    segregacao.medivel && segregacao.separadoresEntre === 0,
    segregacao.medivel
      ? `separadores entre o último humano e o primeiro agente: ${segregacao.separadoresEntre}`
      : `não deu para medir — ordem do menu: ${segregacao.ordem.join(" | ")}`,
  );
  await shotPage(page, "wave-1-cenario-2-filtro-aberto.png", false);

  await page.getByRole("menuitem").filter({ hasText: agent.name }).first().click();
  await page.waitForTimeout(1200);
  const visiveis = await page.locator("[data-rfd-draggable-id]").allTextContents();
  const temRogerio = visiveis.some((t) => t.includes(LEAD_AGENTE_COM_VERSAO));
  const temCaio = visiveis.some((t) => t.includes(LEAD_AGENTE_SEM_VERSAO));
  const temHumanoLead = visiveis.some((t) => t.includes("Grupo Odonto Sul"));
  record(
    2.1 as unknown as number,
    `filtrar por "${agent.name}" devolve SÓ os leads dele`,
    temRogerio && !temCaio && !temHumanoLead,
    `Rogério(Lia)=${temRogerio} · Caio(OUTRO agente)=${temCaio} · lead humano=${temHumanoLead}`,
  );
  await shotPage(page, "wave-1-cenario-2-filtrado-por-agente.png");

  // volta o filtro para Todos
  await page.getByRole("button", { name: /^Responsável:/ }).click();
  await page.getByRole("menuitem", { name: "Todos" }).click();
  await page.waitForTimeout(800);

  // ---- Cenário 1b: atribuir a um agente pela UI ----------------------------
  await openOwnerMenu(page, LEAD);
  const agentItem = page.getByRole("menuitem").filter({ hasText: agent.name }).first();
  if ((await agentItem.count()) === 0) {
    throw new Error(`[cenário 1] agente "${agent.name}" não aparece no submenu Responsável`);
  }
  await agentItem.click();
  await page.waitForTimeout(1500); // mutação + refetch do board

  const s1 = await ownerState(page, LEAD);
  const tooltipEsperado = agent.version != null ? `${agent.name} · v${agent.version}` : agent.name;
  record(
    1.1 as unknown as number,
    "atribuir a agente PELA UI: card vira avatar vazado com anel + tooltip certo",
    s1.vazadoComAnel &&
      !s1.semResponsavel &&
      !s1.temEmoji &&
      !s1.temBadgeAI &&
      s1.tooltip === tooltipEsperado,
    `vazadoComAnel=${s1.vazadoComAnel} semResponsavel=${s1.semResponsavel} emoji=${s1.temEmoji} badgeAI=${s1.temBadgeAI} tooltip="${s1.tooltip}"`,
  );
  await shotCard(page, LEAD, "wave-1-cenario-1-card-agente.png");

  // ---- Cenário 3: transferir agente→humano e humano→agente ------------------
  await openOwnerMenu(page, LEAD);
  const humano = page.getByRole("menuitem").filter({ hasText: "E2E Manager" }).first();
  if ((await humano.count()) === 0) throw new Error("[cenário 3] humano não listado no submenu");
  await humano.click();
  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForLoadState("networkidle").catch(() => null);
  const s3a = await ownerState(page, LEAD);
  record(
    3,
    "transferência agente→humano persiste após reload",
    s3a.preenchido && !s3a.vazadoComAnel && !s3a.semResponsavel,
    `preenchido=${s3a.preenchido} vazadoComAnel=${s3a.vazadoComAnel} aria="${s3a.ariaLabel}"`,
  );
  await shotCard(page, LEAD, "wave-1-cenario-3-dono-humano.png");

  await openOwnerMenu(page, LEAD);
  await page.getByRole("menuitem").filter({ hasText: agent.name }).first().click();
  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForLoadState("networkidle").catch(() => null);
  const s3b = await ownerState(page, LEAD);
  record(
    3.1 as unknown as number,
    "transferência humano→agente persiste após reload",
    s3b.vazadoComAnel && !s3b.semResponsavel,
    `vazadoComAnel=${s3b.vazadoComAnel} tooltip="${s3b.tooltip}"`,
  );
  await shotCard(page, LEAD, "wave-1-cenario-3-dono-agente.png");

  // ---- axe-core + foto do board (teste do metro) ---------------------------
  const axe = await new AxeBuilder({ page }).analyze();
  const graves = axe.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  record(
    5 as unknown as number,
    "axe-core sem violação nova",
    graves.length === 0,
    graves.length === 0
      ? `${axe.violations.length} violação(ões) leve(s), 0 grave`
      : graves.map((v) => `${v.impact}:${v.id}(${v.nodes.length})`).join(", "),
  );
  await shotPage(page, "wave-1-board-com-agente.png");

  // ---- Cenário 4: viewer não reatribui -------------------------------------
  const viewerCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const viewerPage = await viewerCtx.newPage();
  await login(viewerPage, "viewer");
  await gotoBoard(viewerPage);
  const { card: viewerCard } = await cardLocator(viewerPage, LEAD);
  await viewerCard.hover();
  const viewerTrigger = viewerCard.getByRole("button", { name: "Ações da oportunidade" });
  let submenuVisivel = false;
  if ((await viewerTrigger.count()) > 0) {
    await viewerTrigger.click();
    submenuVisivel = await viewerPage
      .getByRole("menuitem", { name: "Responsável" })
      .isVisible()
      .catch(() => false);
  }
  record(
    4,
    "viewer NÃO consegue reatribuir",
    !submenuVisivel,
    submenuVisivel
      ? "submenu Responsável VISÍVEL para viewer — RBAC furado"
      : `menu ${(await viewerTrigger.count()) > 0 ? "abre, mas sem submenu Responsável" : "nem existe para viewer"}`,
  );
  await shotPage(viewerPage, "wave-1-cenario-4-viewer.png", false);
  await viewerCtx.close();

  // ---- devolve o fixture ao estado do seed, pela própria UI ----------------
  await openOwnerMenu(page, LEAD);
  await page.getByRole("menuitem", { name: "Sem responsável" }).click();
  await page.waitForTimeout(1500);
  const sFinal = await ownerState(page, LEAD);
  record(
    6 as unknown as number,
    'fixture restaurado para "Sem responsável" pela UI',
    sFinal.semResponsavel,
    `semResponsavel=${sFinal.semResponsavel}`,
  );

  await browser.close();

  const falhas = results.filter((r) => !r.ok);
  console.info(`\n=== WAVE 1: ${results.length - falhas.length}/${results.length} PASS ===`);
  if (falhas.length) {
    for (const f of falhas) console.info(`  FALHA [${f.n}] ${f.nome}: ${f.detalhe}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("❌ Wave 1 falhou:", err);
  process.exit(1);
});
