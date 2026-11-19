/**
 * Wave 3 — cenários 10, 11 e 12 da §7.
 *
 *  10. Ação do agente → atividade nasce com ator = AGENTE e `reason` VISÍVEL.
 *  11. Uma decisão de NÃO enviar aparece na timeline. Silêncio do agente também é evento.
 *  12. O card PULSA UMA VEZ e para. Falha se ficar animando.
 *
 * Os cenários 10 e 11 dependem de superfície que o @DevVivo ainda está escrevendo
 * (blocos 2.2 a 2.4). Este arquivo FALHA ALTO dizendo exatamente o que falta, em
 * vez de passar por omissão — teste que "passa" porque a tela não existe é o pior
 * tipo de verde.
 *
 * O cenário 12 já é mensurável: com o realtime entregando, dá para amostrar o card
 * e provar que a animação acontece UMA vez e cessa.
 *
 * Run: E2E_PORT=3020 npx tsx tests/capture-wave-3-cenarios.ts
 */

import { chromium, type Page } from "@playwright/test";
import * as fs from "node:fs";

import { createClient } from "@supabase/supabase-js";

import { createHash, randomUUID } from "node:crypto";
import pg from "pg";

import { emitVetoActivity } from "@/lib/leads/veto-activity";

import { BASE, CARD_ATTR, CREDS, EVIDENCE, carimbar, gotoBoard, login, loginAs, shotPage } from "./qa-helpers";
import { carregarEnvLocal } from "../scripts/lib/env-de-teste";

/** Hash dos bytes do recorte do card: prova que a IMAGEM mudou, não que algo rodou. */
const hashDoRecorte = (b: Buffer): string => createHash("sha1").update(b).digest("hex").slice(0, 12);

const envVars = carregarEnvLocal();
const admin = createClient(envVars.NEXT_PUBLIC_SUPABASE_URL!, envVars.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ALVO = "Marina Costa — clareamento";

/**
 * Três estados, não dois. REPROVADO acusa quem construiu; BLOQUEADO acusa quem
 * planejou. Chamar de reprovado um recurso que ninguém escreveu ainda transfere
 * culpa para o lado errado e polui o placar com dívida de plano.
 */
type Estado = "PASS" | "FALHA" | "BLOQUEADO";
const resultados: { n: string; nome: string; estado: Estado; detalhe: string }[] = [];
function record(n: string, nome: string, ok: boolean, detalhe: string, estado?: Estado): void {
  const e: Estado = estado ?? (ok ? "PASS" : "FALHA");
  resultados.push({ n, nome, estado: e, detalhe });
  console.info(`${e.padEnd(9)} [cenário ${n}] ${nome} — ${detalhe}`);
}

/**
 * Avalia uma SUPERFÍCIE de timeline pelos 4 critérios do cenário 10.
 *
 * "Renderizou algum item" passaria numa tela que despeja uuid no rosto do
 * usuário — é o pior tipo de verde. Então a asserção é sobre TEXTO.
 */
async function avaliarSuperficie(
  page: Page,
  seletor: string,
): Promise<{
  texto: string;
  temMotivoHumano: boolean;
  uuidsVisiveis: string[];
  temRotuloCru: boolean;
  /** Blocos colapsados na superfície — ver `escondeConteudo`. */
  blocosColapsados: number;
  atorDistinguivel: boolean;
}> {
  const dados = await page.evaluate((sel: string) => {
    // O painel VISÍVEL, não o primeiro: a página tem dois tabpanels e o primeiro
    // é o oculto. Ler o oculto devolve texto vazio — e aí "não há uuid" e "não há
    // rótulo cru" passariam por AUSÊNCIA, que é o verde vácuo de novo.
    const candidatos = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
    const raiz = candidatos.find((x) => x.offsetParent !== null) ?? candidatos[0] ?? document.body;
    const texto = raiz.innerText ?? "";
    // Ator: o BRIEFING §5 e o OwnerBadge são explícitos — humano é disco
    // PREENCHIDO, agente é círculo VAZADO COM ANEL. A distinção é geométrica.
    const preenchidos = raiz.querySelectorAll("[class*='bg-accent-soft']").length;
    const comAnel = raiz.querySelectorAll("[class*='ring-'][class*='border-accent']").length;
    return { texto, preenchidos, comAnel };
  }, seletor);

  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  return {
    texto: dados.texto.replace(/\s+/g, " "),
    temMotivoHumano: /Movido de .+ para .+/i.test(dados.texto),
    uuidsVisiveis: [...new Set(dados.texto.match(uuid) ?? [])],
    // QUANTO A SUPERFÍCIE ESCONDE. Toda asserção de AUSÊNCIA sobre uma tela que
    // colapsa, trunca ou pagina é inválida por construção: a ausência observada
    // é indistinguível da ocultação. Um uuid dentro de um bloco fechado passaria
    // no "nenhum uuid visível" — e o verde encerraria a pergunta, que é o que
    // torna o falso VERDE pior que o falso vermelho.
    //
    // Hoje esta superfície (a timeline do CONTATO) não agrupa — quem agrupa é a
    // do dossiê. Então a contagem é zero e as asserções valem. No dia em que o
    // agrupamento chegar aqui, ela deixa de ser zero e o critério se recusa a
    // afirmar ausência, em vez de virar verde falso em silêncio.
    blocosColapsados: (dados.texto.match(/·\s*\d+\s+(ações|eventos|atividades)/gi) ?? []).length,
    temRotuloCru: /\b(stage_changed|ai_turn|note|lead_created)\b/.test(dados.texto),
    atorDistinguivel: dados.preenchidos > 0 || dados.comAnel > 0,
  };
}

/**
 * Conta INÍCIOS de animação no card — não presença de classe.
 *
 * A distinção é o coração do 12.d: se a classe fica no elemento, ela está
 * presente nos dois casos (um pulso ou dois), e a asserção passaria igual. O
 * evento `animationstart` só dispara quando a animação REINICIA de verdade,
 * que é exatamente o que "dois pulsos visíveis" quer dizer.
 */
async function armarContadorDePulsos(page: Page, titulo: string): Promise<void> {
  await page.evaluate(
    ({ attr, alvo }: { attr: string; alvo: string }) => {
      (window as unknown as { __pulsos: number }).__pulsos = 0;
      document.addEventListener(
        "animationstart",
        (ev: Event) => {
          const alvoEv = ev.target as Element | null;
          const card = alvoEv?.closest?.(`[${attr}]`);
          if (card && (card.textContent ?? "").includes(alvo)) {
            (window as unknown as { __pulsos: number }).__pulsos++;
            // No INSTANTE zero o estilo computado ainda é o base (sem sombra):
            // o quadro do keyframe ainda não pintou. Espero DOIS quadros de
            // animação — continua sendo de dentro da página, sem corrida com a
            // rede, e já pega o valor interpolado.
            const nomeAnim = (ev as AnimationEvent).animationName;
            const elAnimado = alvoEv as Element;
            const paiCard = card as HTMLElement;
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                const cs = getComputedStyle(elAnimado);
                (window as unknown as { __pulsoInfo: unknown }).__pulsoInfo = {
                  animacao: nomeAnim,
                  sombra: cs.boxShadow,
                  fundo: cs.backgroundColor,
                  paiRecorta: getComputedStyle(paiCard).overflow,
                };
              });
            });
          }
        },
        true,
      );
    },
    { attr: CARD_ATTR, alvo: titulo },
  );
}

async function lerPulsos(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __pulsos?: number }).__pulsos ?? 0);
}

/** Duas mudanças remotas seguidas no MESMO lead, com intervalo controlado. */
async function duasMudancasRemotas(leadId: string, estagios: string[], intervaloMs: number): Promise<void> {
  const a1 = await admin.from("crm_leads").update({ stage_id: estagios[0] } as never).eq("id", leadId);
  if (a1.error) throw new Error(`1a mudança: ${a1.error.message}`);
  await new Promise((r) => setTimeout(r, intervaloMs));
  const a2 = await admin.from("crm_leads").update({ stage_id: estagios[1] } as never).eq("id", leadId);
  if (a2.error) throw new Error(`2a mudança: ${a2.error.message}`);
}



/** Fundo é "cobertor" quando é opaco o bastante para esconder o texto do card. */
function ehCobertor(fundo: string): boolean {
  if (!fundo || /transparent/i.test(fundo)) return false;
  const m = fundo.match(/rgba?\(([^)]+)\)/);
  if (!m) return false;
  const partes = m[1]!.split(",").map((x) => parseFloat(x.trim()));
  const alfa = partes.length >= 4 ? partes[3]! : 1;
  return alfa > 0.4;
}

/** Em que coluna (droppable) o card está — usado nas duas abas. */
async function colunaDe(page: Page, titulo: string): Promise<string | null> {
  return page.evaluate(
    ({ attr, alvo }: { attr: string; alvo: string }) => {
      for (const c of Array.from(document.querySelectorAll(`[${attr}]`))) {
        if ((c.textContent ?? "").includes(alvo)) {
          return c.closest("[data-rfd-droppable-id]")?.getAttribute("data-rfd-droppable-id") ?? "?";
        }
      }
      return null;
    },
    { attr: CARD_ATTR, alvo: titulo },
  );
}

/** Move o card pelo teclado — interação real, sem a fragilidade do arrasto de mouse. */
async function moverPorTeclado(page: Page, titulo: string): Promise<boolean> {
  const antes = await colunaDe(page, titulo);
  for (const direcao of ["ArrowRight", "ArrowLeft"]) {
    const card = page.locator(`[${CARD_ATTR}]`).filter({ hasText: titulo }).first();
    await card.scrollIntoViewIfNeeded();
    await card.focus();
    await page.keyboard.press("Space");
    await page.waitForTimeout(400);
    await page.keyboard.press(direcao);
    await page.waitForTimeout(400);
    await page.keyboard.press("Space");
    await page.waitForTimeout(1200);
    if ((await colunaDe(page, titulo)) !== antes) return true;
  }
  // Sem coluna livre em nenhuma direção: a AÇÃO não aconteceu, e quem chamou
  // precisa saber disso para não culpar a entrega por um gatilho que não houve.
  return false;
}

/**
 * Amostra a assinatura visual do card ao longo do tempo.
 *
 * "Pulsa uma vez" é uma afirmação sobre a SÉRIE TEMPORAL, não sobre um instante:
 * uma foto não distingue "está pulsando agora" de "vai pulsar para sempre". Por
 * isso o detector grava a sequência de estados e conta as TRANSIÇÕES.
 */
async function amostrarPulso(
  page: Page,
  titulo: string,
  duracaoMs: number,
): Promise<{
  amostras: string[];
  transicoes: number;
  episodios: number;
  assentou: boolean;
  terminouLimpo: boolean;
}> {
  const amostras: string[] = [];
  const fim = Date.now() + duracaoMs;
  while (Date.now() < fim) {
    const assinatura = await page.evaluate(
      ({ attr, alvo }: { attr: string; alvo: string }) => {
        for (const card of Array.from(document.querySelectorAll(`[${attr}]`))) {
          if (!(card.textContent ?? "").includes(alvo)) continue;
          const cs = getComputedStyle(card);
          // Assinatura = o que o olho veria mudar: anel/sombra, fundo e animação.
          return [
            `anim:${cs.animationName}`,
            `sombra:${cs.boxShadow.slice(0, 60)}`,
            `fundo:${cs.backgroundColor}`,
            `contorno:${cs.outlineWidth}/${cs.outlineColor}`,
            `classe:${card.className.replace(/\s+/g, " ").slice(-70)}`,
          ].join("|");
        }
        return "AUSENTE";
      },
      { attr: CARD_ATTR, alvo: titulo },
    );
    amostras.push(assinatura);
    await page.waitForTimeout(150);
  }
  let transicoes = 0;
  for (let i = 1; i < amostras.length; i++) {
    if (amostras[i] !== amostras[i - 1]) transicoes++;
  }
  // "Pulsa UMA vez" não é "muda uma vez": uma transição suave, amostrada a cada
  // 150ms, produz vários estados intermediários enquanto a cor interpola. Contar
  // transições cruas puniria justamente a animação bem-feita.
  // O que define "uma vez" é o número de EPISÓDIOS — quantas vezes o card SAIU
  // do repouso. Um pulso = uma saída e um retorno, com quantos passos forem.
  const repouso = amostras[0];
  let episodios = 0;
  let dentro = false;
  for (const a of amostras) {
    if (a !== repouso && !dentro) {
      episodios++;
      dentro = true;
    } else if (a === repouso) {
      dentro = false;
    }
  }
  const cauda = amostras.slice(-4);
  const assentou = cauda.every((a) => a === repouso);
  return {
    amostras,
    transicoes,
    episodios,
    assentou,
    terminouLimpo: amostras[amostras.length - 1] === repouso,
  };
}

async function main(): Promise<void> {
  fs.mkdirSync(EVIDENCE, { recursive: true });

  // Declara de QUE arquivos esta prova depende. Obriga a escrever a cadeia
  // causal antes de medir — e, com a árvore suja, o resultado nasce marcado
  // como não-veredito em vez de parecer um.
  // O sufixo era CALCULADO E DESCARTADO: a evidência desta wave nunca nasceu
  // marcada quando a árvore estava suja, que é exatamente o que o carimbo existe
  // para fazer. Com a árvore limpa o nome não muda — o custo é zero e a proteção
  // volta a existir.
  const sufixoCarimbo = carimbar([
    // O APARATO ENTRA NA PRÓPRIA LISTA — ideia do @DevVivo, e ele está certo:
    // instrumento não commitado produz veredito irreprodutível do mesmo jeito que
    // produto não commitado. Declarar só as dependências do produto deixa o carimbo
    // dizer "todas limpas" enquanto a RÉGUA muda debaixo do resultado.
    "tests/capture-wave-3-cenarios.ts",
    "app/globals.css",
    "components/kanban/KanbanCard.tsx",
    "components/kanban/KanbanBoard.tsx",
    "components/contacts/TimelineView.tsx",
    "components/inbox/CRMSidePanel.tsx",
    "hooks/kanban/useBoard.ts",
    "lib/leads/activity-vocabulary.ts",
  ]);

  const browser = await chromium.launch();

  // Contextos independentes: a aba B tem de receber do SERVIDOR, não compartilhar
  // estado de cliente com a aba A.
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const abaA = await ctxA.newPage();
  const abaB = await ctxB.newPage();

  /**
   * DIAGNÓSTICO QUE NASCE JUNTO COM A FALHA.
   *
   * A entrega falhou duas vezes de forma determinística e depois voltou sozinha,
   * sem causa. Uma falha transitória que só deixa "o evento não chegou" obriga a
   * próxima pessoa a reabrir a caça inteira — e o estado que explicaria já não
   * existe mais quando ela chega.
   *
   * Então o estado do canal da aba B é coletado SEMPRE (custa dois listeners) e
   * impresso SÓ quando a entrega falha. É a diferença entre um registro que diz
   * "não chegou" e um que diz QUAL ELO caiu.
   */
  const canalB = { joins: 0, comToken: 0, papel: "(nenhum join)", quadros: 0, replies: 0 };

  /**
   * ERRO DO CLIENTE, coletado AQUI e não delegado à telemetria.
   *
   * O túnel do Sentry está devolvendo 429 por volume — então "não apareceu nada
   * no Sentry" deixou de ser argumento: ausência de sinal por canal entupido tem
   * a mesma cara de ausência de problema, e a telemetria é justamente a camada
   * que existe para separar os dois estados.
   *
   * O sintoma que eu investiguei tinha a assinatura de erro silencioso no
   * cliente — `CHANNEL_ERROR` capturado, ou exceção morrendo dentro do handler.
   * Um coletor local não substitui a telemetria, mas garante que a evidência
   * exista NO MOMENTO da falha, que é quando ela existe.
   */
  const errosDoCliente: string[] = [];
  abaB.on("console", (m) => {
    if (m.type() === "error") errosDoCliente.push(`console: ${m.text().slice(0, 120)}`);
  });
  abaB.on("pageerror", (e) => errosDoCliente.push(`exceção: ${String(e.message).slice(0, 120)}`));
  abaB.on("requestfailed", (r) =>
    errosDoCliente.push(`requisição falhou: ${r.url().slice(0, 90)} (${r.failure()?.errorText ?? "?"})`),
  );
  abaB.on("websocket", (ws) => {
    if (!ws.url().includes("supabase")) return;
    ws.on("framesent", (f) => {
      const t = String(f.payload);
      if (!/phx_join/.test(t) || !/kanban/i.test(t)) return;
      canalB.joins++;
      const tok = (t.match(/"access_token":"([^"]+)"/) ?? [])[1];
      if (tok) {
        canalB.comToken++;
        try {
          const corpo = JSON.parse(Buffer.from(tok.split(".")[1]!, "base64").toString());
          canalB.papel = `role=${corpo.role} sub=${String(corpo.sub ?? "-").slice(0, 8)}`;
        } catch {
          canalB.papel = "(jwt ilegível)";
        }
      } else {
        canalB.papel = "SEM access_token — canal anônimo";
      }
    });
    ws.on("framereceived", (f) => {
      const t = String(f.payload);
      if (/"postgres_changes"/.test(t) && /"type"\s*:\s*"(INSERT|UPDATE|DELETE)"/.test(t)) canalB.quadros++;
      if (/phx_reply/.test(t) && /kanban/i.test(t)) canalB.replies++;
    });
  });
  const diagnosticoDoCanal = async (): Promise<string> => {
    const status = await abaB
      .locator("[data-realtime-status]")
      .first()
      .getAttribute("data-realtime-status")
      .catch(() => null);
    return (
      `[diagnóstico da aba B] status=${status ?? "(ausente)"} · joins=${canalB.joins} ` +
      `(com token: ${canalB.comToken}, ${canalB.papel}) · respostas=${canalB.replies} · ` +
      `quadros de mudança recebidos=${canalB.quadros} · erros do cliente: ` +
      (errosDoCliente.length === 0
        ? "nenhum"
        : `${errosDoCliente.length} → ${errosDoCliente.slice(0, 3).join(" | ")}`)
    );
  };

  /**
   * O token do canal não pode ser cacheável: um proxy que guardasse a resposta
   * serviria o token de um usuário para outro. Isso NÃO é provável por fora —
   * sem sessão o middleware devolve o 401 dele, e todo teste externo mede o
   * middleware, nunca o handler. Com sessão real, dá para ler o header que
   * chegou na conexão — a diferença entre "está escrito no código" e "chega".
   */
  const respostasToken: { status: number; cacheControl: string | null }[] = [];
  for (const pg of [abaA, abaB]) {
    pg.on("response", (r) => {
      if (r.url().includes("/api/v1/auth/realtime-token")) {
        respostasToken.push({
          status: r.status(),
          cacheControl: r.headers()["cache-control"] ?? null,
        });
      }
    });
  }

  await login(abaA, "manager");
  await gotoBoard(abaA);
  await login(abaB, "manager");
  await gotoBoard(abaB);

  // ABA C — outro tenant. Sem ela o teste prova entrega e NÃO prova isolamento,
  // e realtime que atravessa tenant é vazamento de dado de cliente, não bug de UX.
  const B_TENANT = CREDS.tenant_b as {
    email: string;
    password: string;
    totp: { secret: string };
    pipeline_id: string;
  };
  const ctxC = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const abaC = await ctxC.newPage();
  await loginAs(abaC, {
    email: B_TENANT.email,
    password: B_TENANT.password,
    totpSecret: B_TENANT.totp.secret,
    rotulo: "outro tenant",
  });
  await abaC.goto(`${BASE}/app/pipelines/${B_TENANT.pipeline_id}`);
  await abaC
    .locator(`[${CARD_ATTR}]`)
    .first()
    .waitFor({ state: "visible", timeout: 60_000 });
  console.info(`[aba C] board do outro tenant carregado (${await abaC.locator(`[${CARD_ATTR}]`).count()} card)`);

  // ---- cenário 12: pulsa UMA vez ------------------------------------------
  const linhaBase = await amostrarPulso(abaB, ALVO, 1500);
  console.info(`[base] estado de repouso: "${linhaBase.amostras[0]}" (${linhaBase.transicoes} transições em repouso)`);

  // Onde o card está, na aba B, ANTES de mexer — para separar "o pulso não existe"
  // de "o evento nem chegou". São diagnósticos diferentes e mandam o dev a lugares
  // diferentes; um teste que junta os dois é pior que nenhum teste.
  const colunaAntesB = await abaB.evaluate(
    ({ attr, alvo }: { attr: string; alvo: string }) => {
      for (const c of Array.from(document.querySelectorAll(`[${attr}]`))) {
        if ((c.textContent ?? "").includes(alvo)) {
          return c.closest("[data-rfd-droppable-id]")?.getAttribute("data-rfd-droppable-id") ?? "?";
        }
      }
      return null;
    },
    { attr: CARD_ATTR, alvo: ALVO },
  );

  // Onde o card está na aba A antes da ação — sem isto, um arrasto que não
  // engatou seria reportado como "o evento não chegou", mandando o dev caçar
  // realtime quando o problema foi a AÇÃO não ter acontecido.
  const colunaAntesA = await colunaDe(abaA, ALVO);
  // Arma o contador ANTES da ação: pulso que acontece antes de eu observar é
  // pulso perdido, e eu concluiria "não pulsou".
  await armarContadorDePulsos(abaB, ALVO);
  const acaoAconteceu = await moverPorTeclado(abaA, ALVO);
  const colunaDepoisA = await colunaDe(abaA, ALVO);
  // A TELA DA ABA QUE AGIU É O PRÓPRIO OTIMISMO. O card se move por atualização
  // otimista ANTES de qualquer resposta; se a mutação falhar, a aba que agiu
  // pode continuar mostrando o card no lugar novo. Ler só ela e chamar de "a
  // ação aconteceu" é confundir intenção com efeito — e isso derrubaria toda a
  // cadeia seguinte no lugar errado, mandando alguém caçar realtime quando a
  // escrita nunca aconteceu.
  const { data: linhaAlvo } = await admin
    .from("crm_leads")
    .select("stage_id")
    .eq("organization_id", CREDS.org_id)
    .ilike("title", `%${ALVO}%`)
    .maybeSingle();
  const estagioNoBanco = (linhaAlvo as { stage_id: string } | null)?.stage_id ?? null;
  const persistiu = estagioNoBanco !== null && estagioNoBanco !== colunaAntesA;
  record(
    "12.a",
    "a AÇÃO aconteceu — e PERSISTIU (a tela da aba que agiu é o próprio otimismo)",
    acaoAconteceu && persistiu,
    !acaoAconteceu
      ? `o card NÃO saiu do lugar na aba A (segue em "${colunaAntesA}") — o arrasto não ` +
        `engatou; nada do que vem depois é conclusivo`
      : persistiu
        ? `tela "${colunaAntesA}" → "${colunaDepoisA}" e o BANCO confirma "${estagioNoBanco}"`
        : `a tela da aba A mostra "${colunaDepoisA}", mas o BANCO segue em "${estagioNoBanco}" — ` +
          `a mutação não persistiu, então não há evento para entregar e nada depois disto ` +
          `acusa o realtime`,
  );

  // A amostragem é o instrumento SUPERADO (ela lia a cada 150ms e não enxergava
  // uma animação de 320ms — produziu dois vermelhos falsos). O que sobrou dela é
  // a JANELA DE ESPERA, que é load-bearing: sem ela eu leria o contador antes do
  // evento chegar. Mantenho a chamada pelo tempo que ela consome e uso o número
  // só como informativo, para não fingir que uma medição descartada decide algo.
  const amostragemInformativa = await amostrarPulso(abaB, ALVO, 6000);
  const pulsosAposEvento = await lerPulsos(abaB);
  // Janela EXTRA: se novas animações começarem depois que tudo deveria ter
  // cessado, é loop. Zerar o contador e olhar de novo separa "pulsou" de "não para".
  await abaB.evaluate(() => {
    (window as unknown as { __pulsos: number }).__pulsos = 0;
  });
  await abaB.waitForTimeout(4000);
  const pulsosTardios = await lerPulsos(abaB);

  const colunaDepoisB = await abaB.evaluate(
    ({ attr, alvo }: { attr: string; alvo: string }) => {
      for (const c of Array.from(document.querySelectorAll(`[${attr}]`))) {
        if ((c.textContent ?? "").includes(alvo)) {
          return c.closest("[data-rfd-droppable-id]")?.getAttribute("data-rfd-droppable-id") ?? "?";
        }
      }
      return null;
    },
    { attr: CARD_ATTR, alvo: ALVO },
  );
  const eventoChegou = !!colunaDepoisB && colunaDepoisB !== colunaAntesB;
  // `DIAG=1` imprime o diagnóstico mesmo no caminho feliz. Diagnóstico que nunca
  // rodou é diagnóstico não testado: no dia em que a falha voltar, descobrir que
  // o coletor estava quebrado custaria a única janela em que o estado existia.
  const diag =
    eventoChegou && process.env.DIAG !== "1" ? "" : ` | ${await diagnosticoDoCanal()}`;
  record(
    "12.0",
    "pré-condição: o evento CHEGOU na aba B sem reload",
    eventoChegou,
    (eventoChegou
      ? `card mudou de coluna na aba B (${colunaAntesB?.slice(0, 8)} → ${colunaDepoisB?.slice(0, 8)})`
      : `o card NÃO mudou de coluna na aba B — sem gatilho, o cenário 12 é INCONCLUSIVO, ` +
        `não reprovado.`) + diag,
  );

  // INSTRUMENTO TROCADO: amostrar a cada 150ms NÃO enxerga uma animação de 320ms
  // — cada leitura custa uma ida e volta ao navegador, então o intervalo efetivo
  // supera a própria animação. Medir assim produzia vermelho que era defeito do
  // MEU instrumento, não do produto (o 12.d, que já contava inícios, mostrava o
  // pulso funcionando na mesma rodada). `animationstart` conta exatamente o que
  // importa: quantas vezes a animação COMEÇOU.
  const pulsou = pulsosAposEvento >= 1;
  record(
    "12",
    "o card pulsa quando a mudança vem de FORA",
    eventoChegou && pulsou,
    eventoChegou
      ? `${pulsosAposEvento} início(s) de animação após a chegada remota ` +
        `(amostragem, instrumento superado, viu ${amostragemInformativa.transicoes} — informativo)`
      : "gatilho não chegou nesta rodada — inconclusivo",
  );
  record(
    "12.1",
    "pulsa e CESSA (não fica reanimando sozinho)",
    pulsou && pulsosTardios === 0,
    `${pulsosAposEvento} início(s) na chegada · ${pulsosTardios} novo(s) início(s) na janela seguinte` +
      (pulsosTardios > 0 ? " — está reanimando sozinho" : " — cessou"),
  );
  await shotPage(abaB, `wave-3-c12-apos-pulso${sufixoCarimbo}.png`, false);

  // ---- 12.c: ação LOCAL não pulsa ------------------------------------------
  // O card se move sob o cursor e já tem retorno próprio; pulsar aí é ruído com
  // cara de novidade. Ajo e meço na MESMA aba.
  await armarContadorDePulsos(abaA, ALVO);
  await moverPorTeclado(abaA, ALVO);
  await abaA.waitForTimeout(3000);
  const pulsosLocais = await lerPulsos(abaA);
  // PRÉ-CONDIÇÃO DE CAPACIDADE: "não pulsa" só significa alguma coisa se o
  // produto SABE pulsar. Com o mecanismo morto, zero pulsos na aba local seria
  // verdade por ausência — e no dia em que o pulso nascesse, este critério
  // pararia de proteger justamente por já vir verde. O 12 acima é a prova de que
  // a capacidade existe.
  record(
    "12.c",
    "ação LOCAL não pulsa (o pulso anuncia o que vem de FORA)",
    pulsou && pulsosLocais === 0,
    !pulsou
      ? "inconclusivo: nada pulsou nesta rodada nem por evento remoto — silêncio local não prova nada"
      : pulsosLocais === 0
        ? "nenhum início de animação na aba que agiu"
        : `${pulsosLocais} pulso(s) na própria aba — ruído com cara de novidade`,
  );

  // ---- 12.d: duas mudanças remotas = DOIS pulsos ---------------------------
  // Conta INÍCIOS de animação: presença de classe passaria nos dois casos.
  const leadAlvo = await admin
    .from("crm_leads")
    .select("id,stage_id")
    .eq("pipeline_id", CREDS.crm_vivo.pipeline_id)
    .ilike("title", `${ALVO.slice(0, 18)}%`)
    .maybeSingle();
  if (leadAlvo.error || !leadAlvo.data) {
    record("12.d", "duas mudanças remotas produzem dois pulsos", false, "lead alvo não encontrado para o gatilho duplo");
  } else {
    const estagiosRes = await admin
      .from("crm_stages")
      .select("id")
      .eq("pipeline_id", CREDS.crm_vivo.pipeline_id)
      .eq("is_archived", false)
      .order("position")
      .limit(3);
    const ids = ((estagiosRes.data ?? []) as { id: string }[]).map((x) => x.id);
    const atual = (leadAlvo.data as { id: string; stage_id: string }).stage_id;
    const destinos = ids.filter((x) => x !== atual).slice(0, 2);

    await armarContadorDePulsos(abaB, ALVO);
    // Dispara a 1a mudança e JÁ sai perseguindo o overlay, antes que ele suma.
    const cardB = abaB.locator(`[${CARD_ATTR}]`).filter({ hasText: ALVO }).first();
    // ARMA a espera ANTES do gatilho. Esperar depois é chegar atrasado por
    // construção: o disparo já consumiu a janela em que o overlay existe.
    const overlayNasceu = cardB
      .locator("[data-pulse]")
      .first()
      .waitFor({ state: "attached", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    await duasMudancasRemotas((leadAlvo.data as { id: string }).id, destinos, 500);
    // PERNA DE PIXEL: o evento nativo prova que ALGO rodou; só o pixel prova que
    // alguém VERIA. E o A/B é DURANTE × DEPOIS, nunca durante × antes: o gatilho
    // também muda o dado do card (coluna, ordem), então comparar com o repouso
    // anterior teria duas variáveis e não isolaria o aviso.
    let durantePix = "";
    let depoisPix = "";
    try {
      // Espera o overlay NASCER antes de fotografar. Disparar e fotografar em
      // seguida perde a janela: a animação dura 320ms e o próprio screenshot
      // consome parte disso — foi assim que eu produzi um vermelho que era do
      // meu relógio, não do produto.
      const nasceu = await overlayNasceu;
      if (!nasceu) throw new Error("overlay não nasceu");
      durantePix = hashDoRecorte(await cardB.screenshot());
    } catch {
      durantePix = "(overlay não nasceu na janela)";
    }
    await abaB.waitForTimeout(5000);
    try {
      depoisPix = hashDoRecorte(await cardB.screenshot());
    } catch {
      depoisPix = "(não capturado)";
    }
    const ovDurante = (await abaB.evaluate(
      () =>
        (window as unknown as {
          __pulsoInfo?: { animacao: string; sombra: string; fundo: string; paiRecorta: string };
        }).__pulsoInfo ?? null,
    )) as { animacao: string; sombra: string; fundo: string; paiRecorta: string } | null;
    const pulsosRemotos = await lerPulsos(abaB);
    record(
      "12.d",
      "DUAS mudanças remotas seguidas produzem DOIS pulsos",
      pulsosRemotos >= 2,
      pulsosRemotos >= 2
        ? `${pulsosRemotos} inícios de animação — a segunda chegada foi anunciada`
        : `${pulsosRemotos} início(s) de animação para 2 mudanças — a segunda foi ENGOLIDA: chegou coisa de fora e a tela não disse nada`,
    );

    // SEGUNDA PERNA do 12.d: o contador prova que o overlay REMONTOU, não que o
    // usuário VIU. Com a sombra recortada pelo pai, o número sobe e a tela fica
    // igual. Então: o aviso precisa ser desenhado PARA DENTRO (inset) e não pode
    // ser um cobertor opaco por cima do card.
    // O NOME da animação NÃO distingue as hipóteses: seria idêntico numa versão
    // que não desenha nada (foi o que aconteceu com a versão de sombra inset,
    // medida como invisível pelo próprio autor). Sinal adjacente não é prova —
    // minha própria lei. Quem decide aqui é o pixel.
    const pixelMudou =
      durantePix !== depoisPix &&
      !durantePix.startsWith("(") &&
      !depoisPix.startsWith("(");
    const cobertor = ehCobertor(ovDurante?.fundo ?? "");
    record(
      "12.d.visivel",
      "o aviso é VISTO (o pixel do card muda durante o pulso) e não é cobertor",
      pixelMudou && !cobertor,
      `pixel durante=${durantePix} · depois=${depoisPix} · mudou=${pixelMudou}` +
        ` · animação="${ovDurante?.animacao ?? "-"}" (informativo, não decide)` +
        ` · fundo="${ovDurante?.fundo ?? "-"}" (cobertor=${cobertor})`,
    );
    await shotPage(abaB, `wave-3-c12d-duas-chegadas${sufixoCarimbo}.png`, false);
  }

  // ---- 12.rm: MOVIMENTO REDUZIDO -------------------------------------------
  // A §5 é explícita: com prefers-reduced-motion o pulso vira mudança ESTÁTICA
  // de fundo — "não é opcional". Duas exigências, e a segunda é a que quase todo
  // mundo esquece: sem animação E o estado continua legível por outro meio.
  //
  // TRAVA CONTRA VERDE VAZIO: enquanto não existir pulso, "não animou" é
  // trivialmente verdadeiro. Então este critério só CONTA quando o pulso existir;
  // até lá sai como BLOQUEADO, igual ao 12.
  const ctxRM = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  const abaRM = await ctxRM.newPage();
  await login(abaRM, "manager");
  await gotoBoard(abaRM);
  const repousoRM = await amostrarPulso(abaRM, ALVO, 1200);
  const colunaRMAntes = await colunaDe(abaRM, ALVO);
  // Gatilho PRÓPRIO: depender do movimento feito noutra aba tornava este
  // critério refém do timing alheio — falhava por causa do gatilho, não do
  // comportamento sob teste. Cada critério dispara o que precisa medir.
  await armarContadorDePulsos(abaRM, ALVO);
  const alvoRM = await admin
    .from("crm_leads")
    .select("id,stage_id")
    .eq("pipeline_id", CREDS.crm_vivo.pipeline_id)
    .ilike("title", `${ALVO.slice(0, 18)}%`)
    .maybeSingle();
  const estagiosRM = await admin
    .from("crm_stages")
    .select("id")
    .eq("pipeline_id", CREDS.crm_vivo.pipeline_id)
    .eq("is_archived", false)
    .order("position")
    .limit(3);
  const destinoRM = ((estagiosRM.data ?? []) as { id: string }[])
    .map((x) => x.id)
    .find((x) => x !== (alvoRM.data as { stage_id: string } | null)?.stage_id);
  if (alvoRM.data && destinoRM) {
    const mv = await admin
      .from("crm_leads")
      .update({ stage_id: destinoRM } as never)
      .eq("id", (alvoRM.data as { id: string }).id);
    if (mv.error) throw new Error(`gatilho rm: ${mv.error.message}`);
  }
  const duranteRM = await amostrarPulso(abaRM, ALVO, 6000);
  const colunaRMDepois = await colunaDe(abaRM, ALVO);
  const pulsosRM = await lerPulsos(abaRM);

  // Com movimento reduzido: NENHUMA animação deve iniciar (contador nativo, não
  // amostragem) — e a chegada precisa continuar perceptível por outro meio.
  const animouComRM = pulsosRM > 0;
  const estadoLegivel = !!colunaRMDepois && colunaRMDepois !== colunaRMAntes;
  record(
    "12.rm",
    "com movimento reduzido: sem animação E o estado continua legível",
    !animouComRM && estadoLegivel,
    pulsou
      ? `animou=${animouComRM} · mudança perceptível sem animação=${estadoLegivel}`
      : "sem pulso implementado, este critério ainda não distingue nada",
    pulsou ? undefined : "BLOQUEADO",
  );
  console.info(`  [rm] repouso="${repousoRM.amostras[0]?.slice(0, 28)}" transições=${duranteRM.transicoes}`);
  await shotPage(abaRM, `wave-3-c12rm-movimento-reduzido${sufixoCarimbo}.png`, false);
  await ctxRM.close();

  // ---- NEGATIVO obrigatório: o outro tenant não recebe nada ----------------
  const vazouCard = (await abaC.locator(`[${CARD_ATTR}]`).allTextContents()).some((t) =>
    t.includes(ALVO),
  );
  record(
    "9-neg",
    "outro tenant NÃO enxerga o lead da org A",
    !vazouCard,
    vazouCard ? "VAZOU — lead de outra org no board do tenant B" : "board do outro tenant só com dados dele",
  );

  // E também não pode PULSAR por evento alheio: um card que reage a evento de
  // outro tenant denuncia assinatura mal filtrada mesmo sem mostrar o dado.
  const cardC = ((await abaC.locator(`[${CARD_ATTR}]`).first().textContent()) ?? "").slice(0, 40);
  const pulsoC = await amostrarPulso(abaC, cardC.trim().slice(0, 20), 3000);
  // Mesma pré-condição do 12.c, e aqui o risco é maior: houve um dia nesta
  // entrega em que o canal do board estava morto para TODO MUNDO. Naquele dia,
  // "o outro tenant não pulsa" teria passado — provando isolamento a partir de
  // um produto que não entregava nada a ninguém.
  record(
    "12-neg",
    "card do outro tenant NÃO pulsa por evento alheio",
    pulsou && pulsoC.transicoes === 0,
    !pulsou
      ? "inconclusivo: o pulso não funcionou nem no tenant certo — silêncio alheio não prova filtro"
      : `${pulsoC.transicoes} transição(ões) no board do outro tenant`,
  );
  await shotPage(abaC, `wave-3-c12-outro-tenant${sufixoCarimbo}.png`, false);

  // ---- token do canal: chegou com no-store? --------------------------------
  const ok200 = respostasToken.filter((r) => r.status === 200);
  const semNoStore = ok200.filter((r) => !/no-store/i.test(r.cacheControl ?? ""));
  record(
    "token",
    "resposta do token do canal chega com cache-control: no-store",
    ok200.length > 0 && semNoStore.length === 0,
    ok200.length === 0
      ? `nenhuma resposta 200 de /auth/realtime-token observada (${respostasToken.length} resposta(s) no total: ${respostasToken.map((r) => r.status).join(", ") || "nenhuma"})`
      : semNoStore.length === 0
        ? `${ok200.length} resposta(s) 200, todas com "${ok200[0]!.cacheControl}"`
        : `${semNoStore.length} de ${ok200.length} resposta(s) 200 SEM no-store — cache-control recebido: "${semNoStore[0]!.cacheControl}"`,
  );

  // ---- cenário 10: atividade com ator agente e reason visível ---------------
  // A superfície é a timeline do contato. Enquanto o bloco 2.2 não entrega o
  // ator/reason na tela, isto FALHA e diz o que falta.
  // A timeline é do CONTATO, então o cenário 10 precisa de um lead que tenha um.
  // Movo o card desse lead e verifico se a atividade nasce com ator e motivo.
  const alvo10 = await (async () => {
    const r = await admin
      .from("crm_leads")
      .select("id,title,contact_id")
      .eq("pipeline_id", CREDS.crm_vivo.pipeline_id)
      .not("contact_id", "is", null)
      .limit(5);
    if (r.error) throw new Error(`leads com contato: ${r.error.message}`);
    return ((r.data ?? []) as { title: string; contact_id: string }[])[0] ?? null;
  })();

  if (!alvo10) {
    record("10", "atividade de mudança de estágio na timeline", false, "nenhum lead do board tem contato — a timeline do contato não teria como mostrar");
  } else {
    const tituloCurto = alvo10.title.slice(0, 28);
    const moveu = await moverPorTeclado(abaA, tituloCurto);
    record(
      "10.a",
      "a AÇÃO aconteceu (card com contato mudou de estágio)",
      moveu,
      moveu ? `"${tituloCurto}" mudou de coluna` : `"${tituloCurto}" não saiu do lugar em nenhuma direção`,
    );

    await abaA.goto(`${BASE}/app/contacts/${alvo10.contact_id}`);
    await abaA.waitForLoadState("networkidle").catch(() => null);
    // A página do contato abre em "Visão geral": a timeline é OUTRA aba. Ler sem
    // clicar mede a tela errada — e eu ia acusar o emissor por isso.
    const abaTimeline = abaA.getByRole("tab", { name: /linha do tempo|timeline/i }).or(
      abaA.getByRole("button", { name: /^(Linha do tempo|Timeline)$/i }),
    ).first();
    if ((await abaTimeline.count()) > 0) {
      await abaTimeline.click();
    }
    // Esperar o PAINEL ter conteúdo, não um tempo fixo. A timeline busca depois
    // do clique; ler cedo devolve painel vazio e eu acusaria a tela de não
    // renderizar o que ela só ainda não tinha buscado.
    await abaA
      .locator('[role="tabpanel"]:visible')
      .filter({ hasText: /./ })
      .first()
      .waitFor({ state: "visible", timeout: 30_000 })
      .catch(() => null);
    await abaA.waitForFunction(
      () => {
        const p = Array.from(document.querySelectorAll('[role="tabpanel"]')).find(
          (x) => (x as HTMLElement).offsetParent !== null,
        );
        return !!p && (p.textContent ?? "").trim().length > 0;
      },
      undefined,
      { timeout: 30_000 },
    ).catch(() => null);
    const sup = await avaliarSuperficie(abaA, '[role="tabpanel"]');

    // PRÉ-CONDIÇÃO da superfície: sem conteúdo, os quatro critérios abaixo são
    // INCONCLUSIVOS — "não tem uuid" e "não tem rótulo cru" seriam verdes por
    // ausência, não por comportamento.
    const superficieTemConteudo = sup.texto.trim().length > 0;
    record(
      "10.pre",
      "a superfície da timeline tem conteúdo para avaliar",
      superficieTemConteudo,
      superficieTemConteudo
        ? `${sup.texto.length} caracteres no painel visível`
        : "painel vazio — os critérios seguintes seriam verdes por ausência, não por acerto",
    );
    record(
      "10.a-texto",
      "TimelineView: o motivo humano aparece literalmente",
      sup.temMotivoHumano,
      sup.temMotivoHumano
        ? "texto 'Movido de X para Y' presente na linha"
        : `motivo humano AUSENTE — a tela mostra: "${sup.texto.slice(0, 110)}"`,
    );
    record(
      "10.b-uuid",
      "TimelineView: NENHUM uuid visível para o usuário",
      superficieTemConteudo && sup.blocosColapsados === 0 && sup.uuidsVisiveis.length === 0,
      sup.blocosColapsados > 0
        ? `INVÁLIDO: a superfície tem ${sup.blocosColapsados} bloco(s) colapsado(s) — ausência ` +
          `observada é indistinguível de ocultação. Expanda antes de afirmar que não há uuid.`
        : sup.uuidsVisiveis.length === 0
        ? "nenhum identificador cru na tela"
        : `${sup.uuidsVisiveis.length} uuid(s) no rosto do usuário, ex.: ${sup.uuidsVisiveis[0]}`,
    );
    record(
      "10.c-ator",
      "TimelineView: o ator é distinguível (disco preenchido = humano, anel = agente)",
      sup.atorDistinguivel,
      sup.atorDistinguivel ? "marca de ator presente" : "nenhuma marca geométrica de ator na timeline",
    );
    record(
      "10.d-rotulo",
      "TimelineView: rótulo em pt-BR, não o identificador cru",
      superficieTemConteudo && sup.blocosColapsados === 0 && !sup.temRotuloCru,
      sup.blocosColapsados > 0
        ? `INVÁLIDO: ${sup.blocosColapsados} bloco(s) colapsado(s) — um rótulo cru dentro de um ` +
          `bloco fechado passaria nesta asserção`
        : sup.temRotuloCru
          ? "tipo cru visível (ex.: stage_changed) em vez de rótulo humano"
          : "rótulos humanos",
    );
    await shotPage(abaA, `wave-3-c10-timeline-contato${sufixoCarimbo}.png`, false);
  }

  // ---- SEGUNDA SUPERFÍCIE: o painel lateral do inbox ------------------------
  // A mesma tabela é lida por duas telas. Provar numa só deixaria a outra livre
  // para divergir — e foi exatamente assim que o vocabulário divergiu antes.
  const conversaId = (CREDS.lgpd as { conversation_id?: string } | undefined)?.conversation_id;
  if (!conversaId) {
    record("10-inbox", "painel do inbox: superfície avaliada", false, "sem conversa de referência no .e2e-creds.json");
  } else {
    await abaA.goto(`${BASE}/app/inbox`);
    await abaA.waitForLoadState("networkidle").catch(() => null);

    // CLICAR na conversa, como o usuário. Passar o id na URL não seleciona nada:
    // o painel fica no texto de convite e eu mediria a tela de espera.
    const itemConversa = abaA
      .getByRole("button", { name: /Ana Souza/i })
      .or(abaA.getByText(/Ana Souza LGPD E2E/i))
      .first();
    if ((await itemConversa.count()) > 0) {
      await itemConversa.click().catch(() => null);
      await abaA.waitForTimeout(2500);
    }

    const painel = await avaliarSuperficie(abaA, "aside");
    // "Tem conteúdo" NÃO basta: o texto de convite ("Selecione uma conversa…")
    // é conteúdo e faria os critérios negativos passarem por ausência de dados.
    // A pré-condição exige a superfície REAL, não a tela de espera.
    const ehPlaceholder = /Selecione uma conversa/i.test(painel.texto);
    const temConteudo = painel.texto.trim().length > 0 && !ehPlaceholder;
    record(
      "10-inbox.pre",
      "painel do inbox mostra a superfície real (não o texto de convite)",
      temConteudo,
      ehPlaceholder
        ? 'painel exibe "Selecione uma conversa…" — a conversa não foi selecionada; os critérios abaixo seriam verdes por ausência'
        : `${painel.texto.length} caracteres de conteúdo real`,
    );
    record(
      "10-inbox.texto",
      "painel do inbox: motivo humano literal",
      temConteudo && painel.temMotivoHumano,
      painel.temMotivoHumano
        ? "texto 'Movido de X para Y' presente"
        : `motivo humano ausente — painel diz: "${painel.texto.slice(0, 110)}"`,
    );
    record(
      "10-inbox.uuid",
      "painel do inbox: nenhum uuid visível",
      temConteudo && painel.uuidsVisiveis.length === 0,
      painel.uuidsVisiveis.length === 0 ? "sem identificador cru" : `uuid na tela: ${painel.uuidsVisiveis[0]}`,
    );
    record(
      "10-inbox.rotulo",
      "painel do inbox: rótulo em pt-BR",
      temConteudo && painel.blocosColapsados === 0 && !painel.temRotuloCru,
      painel.temRotuloCru ? "tipo cru visível" : "rótulos humanos",
    );
    await shotPage(abaA, `wave-3-c10-painel-inbox${sufixoCarimbo}.png`, false);

    // LADO B do painel: quando a LEITURA FALHA, a tela tem de dizer que falhou —
    // nunca "Sem leads". Erro convertido em lista vazia transforma falha técnica
    // em afirmação sobre o negócio, e o usuário acredita.
    // Intercepto os dois caminhos possíveis: consulta direta ao banco (hoje) e
    // rota de servidor (depois da migração), para o gate sobreviver à mudança.
    await abaA.route(/\/rest\/v1\/crm_leads|\/api\/v1\/.*(leads|crm)/, (rota) =>
      rota.fulfill({ status: 500, contentType: "application/json", body: '{"message":"falha simulada"}' }),
    );
    await abaA.reload();
    await abaA.waitForLoadState("networkidle").catch(() => null);
    const itemDeNovo = abaA.getByText(/Ana Souza LGPD E2E/i).first();
    if ((await itemDeNovo.count()) > 0) {
      await itemDeNovo.click().catch(() => null);
      await abaA.waitForTimeout(3000);
    }
    const comFalha = ((await abaA.locator("aside").last().innerText()) ?? "").replace(/\s+/g, " ");
    const mentiu = /Sem leads|Sem atividade/i.test(comFalha);
    const avisou = /falha|erro|não foi possível|nao foi possivel|tentar de novo/i.test(comFalha);
    record(
      "10-inbox.falha",
      "leitura que FALHA aparece como falha, não como 'Sem leads'",
      avisou && !mentiu,
      mentiu
        ? 'com a leitura falhando, o painel afirma "Sem leads/Sem atividade" — erro disfarçado de fato sobre o negócio'
        : avisou
          ? "painel sinaliza falha de leitura"
          : `painel não diz nada: "${comFalha.slice(0, 100)}"`,
    );
    await shotPage(abaA, `wave-3-c10-painel-falha-de-leitura${sufixoCarimbo}.png`, false);
    await abaA.unroute(/\/rest\/v1\/crm_leads|\/api\/v1\/.*(leads|crm)/).catch(() => null);
  }

  // ---- cenário 11: a decisão de NÃO enviar aparece --------------------------
  // Ancorado num VETO REAL já registrado na org, não num caso sintético: hoje há
  // 21 decisões de não-enviar em `before_send_traces` (16 por promessa semântica,
  // 3 por limite de aquecimento, 1 por contato bloqueado, 1 fora da janela) — e
  // NENHUMA delas é visível para um humano. É o cenário 11 em números.
  // DECISÃO DO REGENTE (opção a): o critério passa a exigir que um veto NOVO
  // apareça — a ponte funcionando. Os 21 vetos históricos de `before_send_traces`
  // NÃO são reescritos como atividade: publicar histórico retroativo numa trilha
  // append-only e auditada é decisão de produto, não conveniência de fechamento
  // de onda. Ficam como dívida NOMEADA no handoff, com query e viabilidade.
  //
  // O veto é criado pelo EMISSOR DE PRODUÇÃO (mesmo código de um veto real), e
  // removido ao fim: prova não pode deixar resíduo num lead que outras sessões usam.
  const pool = new pg.Pool({ connectionString: envVars.SUPABASE_DB_URL });
  const traceId = randomUUID();
  try {
    const alvo = await pool.query(
      `select l.organization_id, l.contact_id
         from crm_leads l
        where l.contact_id is not null and l.status = 'open'
          and l.organization_id = $1
        limit 1`,
      [CREDS.org_id],
    );
    const linha = alvo.rows[0] as { organization_id: string; contact_id: string } | undefined;
    if (!linha) {
      record("11", "veto NOVO aparece na timeline", false, "sem lead aberto com contato para emitir o veto");
    } else {
      const r = await emitVetoActivity({
        pool,
        organizationId: linha.organization_id,
        contactId: linha.contact_id,
        traceId,
        gate: "pacing",
        code: "warmup_cap",
      });

      await abaA.goto(`${BASE}/app/contacts/${linha.contact_id}`);
      await abaA.waitForLoadState("networkidle").catch(() => null);
      const abaTl = abaA.getByRole("tab", { name: /linha do tempo|timeline/i }).first();
      if ((await abaTl.count()) > 0) await abaTl.click();
      await abaA
        .waitForFunction(
          () => {
            const p = Array.from(document.querySelectorAll('[role="tabpanel"]')).find(
              (x) => (x as HTMLElement).offsetParent !== null,
            );
            return !!p && (p.textContent ?? "").trim().length > 0;
          },
          undefined,
          { timeout: 30_000 },
        )
        .catch(() => null);

      const sup = await avaliarSuperficie(abaA, '[role="tabpanel"]');
      const anunciaVeto = /bloquead|não envi|nao envi/i.test(sup.texto);
      const temMotivo = /ritmo|limite|aquecimento|warmup/i.test(sup.texto);
      record(
        "11",
        "a decisão de NÃO enviar aparece na timeline, com motivo legível",
        (r.routed as boolean) && anunciaVeto && temMotivo && sup.uuidsVisiveis.length === 0,
        `roteado=${r.routed} · anuncia o bloqueio=${anunciaVeto} · motivo legível=${temMotivo} · uuid visível=${sup.uuidsVisiveis.length}` +
          (anunciaVeto ? "" : ` · tela: "${sup.texto.slice(0, 110)}"`),
      );
      await shotPage(abaA, `wave-3-c11-timeline-veto${sufixoCarimbo}.png`, false);
    }
  } finally {
    // Limpa o que escreveu — a mesma disciplina da sonda do regente.
    await pool
      .query(`delete from crm_lead_activities where type = 'send_vetoed' and source_id = $1`, [traceId])
      .catch(() => null);
    await pool.end().catch(() => null);
  }

  await browser.close();

  const verdes = resultados.filter((x) => x.estado === "PASS");
  const falhas = resultados.filter((x) => x.estado === "FALHA");
  const bloqueados = resultados.filter((x) => x.estado === "BLOQUEADO");
  console.info(
    `\n=== WAVE 3: ${verdes.length} verdes · ${falhas.length} vermelhos · ${bloqueados.length} bloqueado(s) ===`,
  );
  for (const f of falhas) console.info(`  FALHA     [${f.n}] ${f.nome}: ${f.detalhe}`);
  for (const b of bloqueados) console.info(`  BLOQUEADO [${b.n}] ${b.nome}: ${b.detalhe}`);
  if (falhas.length) process.exit(1);
}

main().catch((err) => {
  console.error("❌ Cenários 10-12 falharam:", err);
  process.exit(1);
});
