/**
 * Helpers de prova visual do CRM Vivo — compartilhados pelos capturadores de wave.
 *
 * REGRA DE EVIDÊNCIA (§7): aqui não existe fallback silencioso. Se o alvo não
 * resolve, o script FALHA ALTO dizendo qual locator quebrou. Um `catch` que
 * degrada para um recorte pior produz artefato que existe e não prova nada.
 */

import type { Locator, Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const PORT = process.env.E2E_PORT ?? "3020";
export const BASE = `http://localhost:${PORT}`;
export const EVIDENCE = path.join(process.cwd(), "evidence");
export const CREDS = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), ".e2e-creds.json"), "utf8"),
);

/**
 * Atributo do container arrastável do card. `@hello-pangea/dnd` usa o prefixo
 * `rfd` (não `rbd`, do `react-beautiful-dnd` original) — confirmado no DOM.
 */
export const CARD_ATTR = process.env.CARD_ATTR ?? "data-rfd-draggable-id";

/** TOTP RFC-6238 — só o admin tem MFA forçado; manager e viewer entram direto. */
function totp(secretBase32: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secretBase32.replace(/=+$/, "").toUpperCase()) {
    const idx = alphabet.indexOf(c);
    if (idx >= 0) bits += idx.toString(2).padStart(5, "0");
  }
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(Date.now() / 1000 / 30), 4);
  const hmac = crypto.createHmac("sha1", bytes).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  return ((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

/** Login pela tela, como um usuário: digita, clica, e resolve MFA quando pedida. */
export async function login(page: Page, role: string): Promise<void> {
  await loginAs(page, {
    email: CREDS.users[role].email,
    password: CREDS.password,
    totpSecret: CREDS.admin_totp?.secret,
    rotulo: role,
  });
}

/**
 * Login com credenciais explícitas — serve qualquer tenant, não só a org de
 * teste. O segredo TOTP é por USUÁRIO: o produto exige 2FA de todo admin, e
 * usar o segredo do admin errado falha de um jeito que parece senha inválida.
 */
export async function loginAs(
  page: Page,
  cred: { email: string; password: string; totpSecret?: string; rotulo?: string },
): Promise<void> {
  await page.goto(`${BASE}/login`);
  await page.locator("#email").fill(cred.email);
  await page.locator("#password").fill(cred.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();

  // Espera por URL, não por visibilidade: correr `waitForURL` contra
  // `isVisible()` avalia o campo de OTP enquanto a página de MFA ainda monta, e
  // o login "passa" sem digitar o código — falha por corrida, não por senha.
  await page.waitForURL(/\/app\/|\/login\/mfa/, { timeout: 30_000 });
  const otp = page.locator('input[inputmode="numeric"], #code, input[name="code"]').first();
  if (/\/login\/mfa/.test(page.url())) {
    if (!cred.totpSecret) {
      throw new Error(`[login] ${cred.email} caiu na tela de MFA e não recebi segredo TOTP`);
    }
    await otp.waitFor({ state: "visible", timeout: 20_000 });
    // Campo de OTP por slots: digitar tecla a tecla; `fill` não dispara os
    // handlers e o botão fica desabilitado. O form auto-submete no 6º dígito.
    await otp.click();
    await page.keyboard.type(totp(cred.totpSecret), { delay: 80 });
    const verify = page.getByRole("button", { name: /verificar|confirmar|entrar/i }).first();
    if (
      (await verify.isVisible().catch(() => false)) &&
      (await verify.isEnabled().catch(() => false))
    ) {
      await verify.click().catch(() => null);
    }
    await page.waitForURL(/\/app\//, { timeout: 20_000 });
  }
  console.info(`[login] entrou como ${cred.email}${cred.rotulo ? ` (${cred.rotulo})` : ""} → ${page.url()}`);
}

/** Navega até o board de demonstração — só por clique, como um usuário. */
export async function gotoBoard(page: Page): Promise<void> {
  // "Kanban" saiu da interface — o item virou "Funis" (a mesma URL).
  await page.getByRole("link", { name: "Funis", exact: true }).click();
  await page.waitForURL(/\/app\/kanban/, { timeout: 20_000 });
  await page.getByText(/CRM Vivo — Clínica/i).first().click();
  await page.waitForURL(/\/app\/pipelines\//, { timeout: 20_000 });
  if (!page.url().includes(CREDS.crm_vivo.pipeline_id)) {
    throw new Error(`clique levou a ${page.url()}, não ao pipeline do seed`);
  }
  await page.waitForLoadState("networkidle").catch(() => null);
  // `networkidle` não basta: o board hidrata e monta os cards depois. Esperar o
  // primeiro card é determinístico — sleep fixo aqui vira teste intermitente.
  await page
    .locator(`[${CARD_ATTR}]`)
    .first()
    .waitFor({ state: "visible", timeout: 20_000 });
  const n = await page.locator(`[${CARD_ATTR}]`).count();
  console.info(`[nav] board por clique → ${page.url()} (${n} cards)`);
}

/**
 * ESCOLHE UM ALVO E SE RECUSA A SORTEAR.
 *
 * O alvo sorteado (`limit(1)` sem `order by`) me mordeu depois de eu apontá-lo
 * em sonda alheia no mesmo dia — porque, no momento do erro, ele não parece a
 * armadilha: parece "pegar um lead qualquer para disparar". Lembrar da regra
 * compete com pressa; o instrumento, não.
 *
 * Então a escolha passa por aqui, e aqui:
 *   - lista vazia FALHA ALTO, em vez de virar `undefined` e um critério pulado
 *     em silêncio — que foi como um elo inteiro da sonda do canal sumiu sem que
 *     o veredito "zero quadros" deixasse de ser impresso;
 *   - a ordenação é EXPLÍCITA e feita aqui, então duas execuções escolhem o
 *     mesmo alvo mesmo que o banco devolva em outra ordem;
 *   - o log diz QUAL foi escolhido e entre QUANTOS, porque reprodução começa
 *     por saber contra o que se mediu.
 */
export function escolherAlvo<T>(
  candidatos: T[],
  chave: (item: T) => string,
  contexto: string,
): T {
  if (candidatos.length === 0) {
    throw new Error(
      `[alvo] nenhum candidato para "${contexto}" — sem alvo não há medição, e um critério ` +
        `pulado em silêncio deixa o veredito de pé sem nada ter sido disparado`,
    );
  }
  const ordenados = [...candidatos].sort((a, b) => chave(a).localeCompare(chave(b)));
  const escolhido = ordenados[0]!;
  console.info(
    `[alvo] "${contexto}": escolhi ${chave(escolhido).slice(0, 8)} entre ${candidatos.length} candidato(s), por ordem determinística`,
  );
  return escolhido;
}

/** O card do board: o container arrastável, ancestral do título. */
export async function cardLocator(
  page: Page,
  title: string | RegExp,
): Promise<{ card: Locator; box: { width: number; height: number } }> {
  // NÃO usar getByRole("heading"): o card é role="button" (drag handle do dnd) e,
  // pela regra ARIA de "children presentational", o <h3> de dentro PERDE o papel
  // de heading assim que o dnd hidrata. O locator passava por corrida de timing —
  // resolvia antes da hidratação e sumia depois. Ancorar no container é estável.
  const card = page.locator(`[${CARD_ATTR}]`).filter({ hasText: title }).first();
  if ((await card.count()) === 0) {
    // A falha se autodiagnostica: lista os cards que existem de fato.
    const presentes = await page.locator(`[${CARD_ATTR}]`).allTextContents();
    throw new Error(
      `[evidencia] nenhum card [${CARD_ATTR}] casa com "${String(title)}".\n` +
        `Cards presentes (${presentes.length}):\n` +
        presentes.map((t) => `  - ${t.replace(/\s+/g, " ").slice(0, 70)}`).join("\n"),
    );
  }
  const box = await card.boundingBox();
  if (!box) throw new Error(`[evidencia] card "${String(title)}" sem boundingBox (invisível?)`);
  if (box.width < 200 || box.height < 80) {
    throw new Error(
      `[evidencia] recorte de ${Math.round(box.width)}x${Math.round(box.height)}px ` +
        `para "${String(title)}" — card não tem esse tamanho; o locator pegou um nó interno`,
    );
  }
  return { card, box };
}

/**
 * EVIDÊNCIA HISTÓRICA — o que NÃO regenera.
 *
 *   REPRODUZÍVEL — basta rodar o script de novo. Sobrescrever é inofensivo.
 *   HISTÓRICA    — não regenera. Sobrescrever DESTRÓI a única cópia, sem rastro
 *                  do que havia ali; tratá-la como saída de script é erro de
 *
 * A lista é curta de propósito, e o critério não é o sufixo
 * "-antes" do nome: `prova-canal-agent-runs-antes.png` e `wave-3-aba-b-antes.png`
 * são o lado "antes" de um gatilho DENTRO da mesma execução — a sonda refaz os
 * dois. O que entra aqui é o estado ANTERIOR A UMA WAVE: o código que o produzia
 * foi substituído, então o arquivo é a única cópia que existirá.
 */
const EVIDENCIA_HISTORICA = new Set([
  "wave-0-board-antes.png",
  "wave-0-board-antes-full.png",
  "wave-0-card-antes.png",
  "wave-0-card-titulo-longo-antes.png",
  "wave-0-navegacao.png",
  "wave-2-antes-depois.png",
  "wave4-13-antes.png",
]);

/**
 * Protege a evidência na medida da IRREVERSIBILIDADE — não na medida do incômodo.
 *
 * A versão anterior recusava TODA evidência versionada, e o preço apareceu na
 * sonda do ambíguo: ela fez a medição, limpou o que tinha criado e morreu antes
 * de imprimir o veredito, porque o PNG dela já estava no git. **Sonda que não
 * consegue reportar é pior que sonda nenhuma** — e o bloco de doc logo acima já
 * dizia o contrário do que o código fazia ("REPRODUZÍVEL — sobrescrever é
 * inofensivo"). Quando o comentário e o código discordam, um dos dois está
 * errado; aqui era o código.
 *
 * A regra, em uma linha: **o que não regenera é intocável; o que regenera é
 * sobrescrevível, mas nunca em silêncio.**
 *
 *   HISTÓRICA (lista explícita) → RECUSA. O código que produziu aquele estado não
 *     existe mais, então o arquivo é a única cópia e sobrescrever é destruir.
 *   VERSIONADA e reproduzível  → escreve, e ANUNCIA com as duas impressões
 *     digitais. O objetivo do guarda sempre foi impedir a troca SILENCIOSA; o git
 *     é quem torna a troca revisável, e o log é quem a torna visível na hora.
 *   NÃO versionada             → livre.
 *
 * O modo de falha de uma lista incompleta deixa de ser destruição calada e passa
 * a ser um aviso impresso mais um arquivo modificado no `git status`.
 */
function guardaEvidencia(file: string): void {
  const alvo = path.join(EVIDENCE, file);

  if (EVIDENCIA_HISTORICA.has(file) && fs.existsSync(alvo)) {
    if (process.env.FORCE === "1") {
      console.info(`[evidencia] FORCE=1 — sobrescrevendo evidência HISTÓRICA ${file}`);
      return;
    }
    throw new Error(
      `[evidencia] RECUSADO sobrescrever "${file}": é evidência HISTÓRICA — o código que ` +
        `produziu aquele estado não existe mais, então este arquivo é a única cópia e não ` +
        `pode ser regenerado.\n` +
        `Se você realmente quer perder o "antes", rode com FORCE=1.`,
    );
  }

  if (!fs.existsSync(alvo)) return;
  const rel = path.posix.join("evidence", file);
  const rastreada =
    execFileSync("git", ["ls-files", rel], { cwd: process.cwd(), encoding: "utf8" }).trim()
      .length > 0;
  if (!rastreada) return;

  // Versionada e reproduzível: passa, mas o log nomeia a troca. Sem isto, a
  // prova que sustenta um documento mudaria sem ninguém ler uma linha a respeito.
  const antes = crypto.createHash("sha1").update(fs.readFileSync(alvo)).digest("hex").slice(0, 12);
  console.info(
    `[evidencia] ⚠ "${file}" está VERSIONADA e vai ser regenerada. sha1 anterior=${antes}. ` +
      `Se a troca não era intencional: git checkout -- ${rel}`,
  );
}

/**
 * DECLARA que as capturas desta execução saem de caso FABRICADO.
 *
 * Observação do regente e ela é do mesmo tipo da âncora inventada: prova de caso
 * construído sem o rótulo "construído" sugere um fluxo que ninguém exercita.
 * Hoje isso só se percebia por acidente — o lead de teste tem prefixo no título,
 * e quem olhasse o print notaria. Acidente não é declaração.
 *
 * O sufixo entra no NOME do arquivo, como o `-ARVORE-SUJA`: a evidência diz o
 * que ela é sem depender de alguém lembrar de ler a narrativa ao lado.
 */
let sufixoCasoConstruido = "";
export function casoConstruido(motivo: string): void {
  sufixoCasoConstruido = "-CASO-CONSTRUIDO";
  console.info(`[evidencia] caso CONSTRUÍDO nesta execução: ${motivo}`);
  console.info("[evidencia] as capturas sairão marcadas com -CASO-CONSTRUIDO");
}

/** Screenshot do card inteiro, com o retângulo validado antes de gravar. */
export async function shotCard(
  page: Page,
  title: string | RegExp,
  arquivo: string,
): Promise<void> {
  const file = arquivo.replace(/\.png$/, `${sufixoCasoConstruido}.png`);
  guardaEvidencia(file);
  const { card, box } = await cardLocator(page, title);
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: path.join(EVIDENCE, file) });
  console.info(
    `[evidencia] evidence/${file} — ${Math.round(box.width)}x${Math.round(box.height)}px (card inteiro)`,
  );
}

export async function shotPage(page: Page, arquivo: string, fullPage = true): Promise<void> {
  const file = arquivo.replace(/\.png$/, `${sufixoCasoConstruido}.png`);
  guardaEvidencia(file);
  await page.screenshot({ path: path.join(EVIDENCE, file), fullPage });
  console.info(`[evidencia] evidence/${file}`);
}

/**
 * PLACAR QUE COBRA A LISTA — o critério que nunca é avaliado deixa de sumir.
 *
 * Hoje eu construí um helper para a LISTA VAZIA não passar em silêncio e caí no
 * vizinho: acrescentei dois critérios e esqueci de incluí-los no caminho de
 * retorno antecipado, então eles simplesmente NÃO APARECERAM — sem vermelho para
 * investigar e com o placar de pé. São duas ausências diferentes: o ALVO que não
 * existe e o CRITÉRIO que não chega a ser avaliado. A primeira virou mecanismo
 * de manhã; esta é a segunda.
 *
 * A lista dos critérios é declarada ANTES de medir. No fim, quem foi declarado e
 * nunca registrado sai como **AUSENTE** — e ausente é falha do INSTRUMENTO, não
 * do produto: ninguém precisa caçar defeito, alguém precisa consertar o teste.
 */
/**
 * Cinco estados, e a separação entre os dois do meio é o que faltava.
 *
 * BLOQUEADO diz "o recurso não existe ainda" — acusa quem PLANEJOU, e não é
 * falha da rodada: ninguém precisa investigar código que não foi escrito.
 *
 * INCONCLUSIVO diz "a medição não pôde decidir" — a pré-condição não valeu, o
 * caso não se montou, o dado não chegou. E ele CONTA COMO FALHA, porque o
 * veredito tem dois desfechos nativos e a realidade tem três: sem o terceiro,
 * "não deu para saber" é sistematicamente absorvido pelo VERDE, por omissão do
 * ferramental e não por decisão de ninguém.
 *
 * A regra: onde não dá para ter o terceiro desfecho, FALHE. Investigar um alarme
 * falso custa menos que arquivar uma pergunta que ninguém mais vai abrir.
 */
export type EstadoCriterio = "PASS" | "FALHA" | "INCONCLUSIVO" | "BLOQUEADO" | "AUSENTE";

export function criarPlacar(nome: string, esperados: string[]) {
  const vistos = new Map<string, EstadoCriterio>();
  const linhas: { n: string; titulo: string; estado: EstadoCriterio; detalhe: string }[] = [];

  // A PROMESSA É IMPRESSA ANTES DE QUALQUER TRABALHO.
  //
  // O fechamento vive no `finally`, e `finally` não roda quando o PROCESSO morre
  // — cano fechado, sinal, máquina desligada. Um guarda que vive no mesmo fluxo
  // que vigia herda as falhas desse fluxo, e o meu herdava duas: o `return` (já
  // resolvido movendo para o `finally`) e a morte do processo, que o `finally`
  // não cobre.
  //
  // Declarar no INÍCIO não impede a morte — mas deixa a lista prometida no log
  // antes de qualquer coisa poder interrompê-la. Quem ler uma saída truncada
  // consegue dizer o que faltou, em vez de só ver onde parou.
  console.info(`[placar ${nome}] ${esperados.length} critérios prometidos: ${esperados.join(", ")}`);

  function record(
    n: string,
    titulo: string,
    ok: boolean,
    detalhe: string,
    estado?: EstadoCriterio,
  ): void {
    const e: EstadoCriterio = estado ?? (ok ? "PASS" : "FALHA");
    if (!esperados.includes(n)) {
      throw new Error(
        `[placar] critério "${n}" foi registrado sem estar na lista declarada. ` +
          `A lista é o contrato do placar: critério fora dela não é cobrado se sumir.`,
      );
    }
    vistos.set(n, e);
    linhas.push({ n, titulo, estado: e, detalhe });
    console.info(`${e.padEnd(9)} [${n}] ${titulo} — ${detalhe}`);
  }

  function fechar(): number {
    for (const n of esperados) {
      if (vistos.has(n)) continue;
      linhas.push({
        n,
        titulo: "(declarado e nunca avaliado)",
        estado: "AUSENTE",
        detalhe:
          "este critério estava na lista e nenhum caminho do aparato chegou a ele — " +
          "falha do INSTRUMENTO, não do produto",
      });
    }
    const conta = (e: EstadoCriterio) => linhas.filter((l) => l.estado === e).length;
    const ausentes = conta("AUSENTE");
    const inconclusivos = conta("INCONCLUSIVO");
    console.info(
      `\n=== ${nome}: ${conta("PASS")} verdes · ${conta("FALHA")} vermelhos · ` +
        `${conta("BLOQUEADO")} bloqueados` +
        `${inconclusivos > 0 ? ` · ${inconclusivos} INCONCLUSIVOS` : ""}` +
        `${ausentes > 0 ? ` · ${ausentes} AUSENTES` : ""} ===`,
    );
    for (const l of linhas.filter((x) => x.estado !== "PASS")) {
      console.info(`  ${l.estado} [${l.n}] ${l.titulo}: ${l.detalhe}`);
    }
    // E SE A ÁRVORE ESTAVA SUJA, ISTO NÃO É VEREDITO — e quem diz isso tem de ser
    // o CÓDIGO DE SAÍDA, não uma linha de aviso. Se a ação necessária depende de
    // alguém ler, o veredito tem de ser vermelho: verde com instrução é
    // instrução perdida.
    // A SEGUNDA LEITURA DO CARIMBO — a lei do dia aplicada ao próprio carimbo.
    //
    // Ele lia `git status` UMA vez, no início. Isso é medição de NASCIMENTO: uma
    // execução de três minutos, numa árvore que duas sessões dividem, pode ter o
    // código trocado NO MEIO — e o veredito sairia limpo sobre um código que não
    // é mais o medido. É o "alvo em movimento" acontecendo dentro da janela em
    // vez de entre janelas, e o estado mais perigoso dos três porque não deixa
    // rastro nenhum: começou limpo e terminou limpo.
    const agora = dependenciasDoCarimbo.length > 0 ? sujidadeAtual(dependenciasDoCarimbo) : "";
    if (agora !== arvoreSuja) {
      console.info(
        `  MUDOU DURANTE A EXECUÇÃO: as dependências declaradas estavam "${arvoreSuja || "limpas"}" ` +
          `no início e "${agora || "limpas"}" no fim. O código medido não é um código só — este ` +
          `resultado não descreve nenhuma versão.`,
      );
    }
    // E A MENSAGEM DE "SUJA NO INÍCIO" SÓ SAI QUANDO É ESSE O CASO. Na primeira
    // versão as duas condições dividiam um texto só, e a mudança-no-meio
    // imprimia "a árvore estava suja (…)" com a lista VAZIA — afirmação falsa
    // gerada pela cerca que eu acabei de escrever para impedir afirmação falsa.
    if (arvoreSuja !== "") {
      console.info(
        `  SEM VEREDITO: a árvore estava suja nas dependências declaradas (${arvoreSuja}). ` +
          `Os estados acima descrevem uma execução, não um veredito — o código medido não é o ` +
          `código do commit, e comparar esta saída com outra rodada compara coisas diferentes.`,
      );
    }
    // INCONCLUSIVO conta como falha: ele está mais perto de vermelho que de
    // verde, e o único jeito de o "não deu para saber" não ser engolido pelo
    // verde é ele custar o mesmo que um vermelho.
    return conta("FALHA") + ausentes + inconclusivos + (arvoreSuja === "" && agora === arvoreSuja ? 0 : 1);
  }

  return { record, fechar };
}

/**
 * CARIMBO DE PROCEDÊNCIA — mecaniza a lei do §7.3/§7.11 em vez de confiar nela.
 *
 * Proposta do `@Arquiteto`, e o argumento dele é o que decide: o regente caiu na
 * própria regra com o time assistindo. Isso não é falta de rigor, é limite de
 * memória sob pressão — e a resposta para limite de memória é **artefato**, não
 * promessa. Custou duas linhas por sonda.
 *
 * Duas coisas acontecem aqui, e a segunda vale mais que a primeira:
 *
 * 1. Imprime o commit e o estado das dependências. Verde contra árvore suja
 *    deixa de ser possível de emitir sem aparecer.
 * 2. **Obriga a declarar de que arquivos a prova depende** — o que força a
 *    escrever a cadeia causal ANTES de medir. Foi exatamente isso que faltou nas
 *    duas vezes em que uma medição desta wave valeu para a versão errada.
 *
 * Devolve o sufixo que deve ir no NOME da evidência: com árvore suja, o print
 * nasce marcado como `-ARVORE-SUJA`. A evidência acusa a si mesma, em vez de
 * depender de alguém lembrar de ler o log.
 */
/**
 * O QUE O CARIMBO VIU, para o placar poder OBEDECER em vez de só avisar.
 *
 * O carimbo imprimia "⚠ ÁRVORE SUJA — este resultado NÃO é veredito" e o placar,
 * logo abaixo, anunciava "13 verdes · 0 vermelhos" e saía com código 0. Veredito
 * e mensagem discordando na mesma saída — e o veredito é o único canal com
 * consequência mecânica: é ele que propaga pela suíte e pelo código de saída. A
 * frase "não é veredito" ficava num papel que ninguém abre, e o verde,
 * especificamente, REMOVE o motivo de ler.
 */
let arvoreSuja = "";
/** As dependências declaradas, guardadas para a RELEITURA no fim da execução. */
let dependenciasDoCarimbo: string[] = [];

/** O conjunto fixo, enumerável à mão enquanto couber numa linha. */
const INFRAESTRUTURA_COMPARTILHADA = ["tests/qa-helpers.ts"];

/** `git status` das dependências, para comparar início e fim. */
function sujidadeAtual(deps: string[]): string {
  try {
    const out = execFileSync("git", ["status", "--porcelain", "--", ...deps], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    return out.join(" · ");
  } catch {
    return "";
  }
}

/**
 * OS ARQUIVOS VARRIDOS — E O SCANNER NÃO SE INCLUI.
 *
 * `qa-helpers.ts` contém, como texto, os próprios padrões que ele procura
 * ("chromium.launch", o regex de insert). Varrendo a si mesmo, ele SEMPRE casa a
 * pré-condição — o que (a) o contava como sonda e (b) impedia o controle
 * positivo de disparar, porque nunca havia zero. Descobri sabotando o padrão de
 * propósito e vendo a cerca NÃO morder: com o padrão quebrado, o único arquivo
 * que ainda casava era o que continha a string quebrada.
 *
 * É a observação sendo instância do que ela mede, dentro do detector escrito
 * para vigiar as outras.
 */
function arquivosVarridos(dir: string): string[] {
  return fs.readdirSync(dir).filter((x) => x.endsWith(".ts") && x !== "qa-helpers.ts");
}

/** Sondas que inserem em `crm_lead_activities` sem passar pelo desfazer. */
function sondasQueSujamORelogio(): string[] {
  const dir = path.join(process.cwd(), "tests");
  const fora: string[] = [];
  let comInsert = 0;
  for (const f of arquivosVarridos(dir)) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    const insere = /from\("crm_lead_activities"\)[\s\S]{0,40}\.insert\(/.test(src);
    if (insere) comInsert++;
    // O CRITÉRIO É "DEVOLVE O RELÓGIO", não "usa o meu helper". A primeira versão
    // acusou o vigia — que restaura à mão, corretamente. Detector que exige a
    // FORMA em vez do EFEITO é o falso vermelho por forma que me pegou sete
    // vezes na wave 6, agora dentro do detector de dívida.
    const devolve = src.includes("atividadeDeTeste") || /last_activity_at[\s\S]{0,200}\.update\(|\.update\([\s\S]{0,200}last_activity_at/.test(src);
    if (insere && !devolve) fora.push(f);
  }
  // Mesmo controle positivo: se NENHUMA sonda insere atividade, o regex quebrou.
  if (comInsert === 0) {
    console.info(
      "[carimbo] ⚠ o detector de dívida de limpeza NÃO ACHOU NENHUMA sonda que insira atividade — " +
        "o padrão está errado, e o resultado dele não significa nada",
    );
  }
  return fora;
}

/** Arquivos de `tests/` importados por 2+ aparatos e ausentes do conjunto. */
function compartilhadosNaoDeclarados(): string[] {
  const dir = path.join(process.cwd(), "tests");
  const usos = new Map<string, number>();
  for (const f of arquivosVarridos(dir)) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of src.matchAll(/from "\.\/([a-z0-9-]+)"/g)) {
      const alvo = `tests/${m[1]}.ts`;
      if (alvo === `tests/${f}`) continue;
      usos.set(alvo, (usos.get(alvo) ?? 0) + 1);
    }
  }
  return [...usos.entries()]
    .filter(([alvo, n]) => n >= 2 && !INFRAESTRUTURA_COMPARTILHADA.includes(alvo))
    .map(([alvo]) => alvo);
}

/**
 * INSERE ATIVIDADE DE TESTE E DEVOLVE COMO DESFAZÊ-LA POR INTEIRO.
 *
 * O tipo `note` — o que quase toda sonda usa — está na LISTA POSITIVA do gatilho
 * de última atividade. Cada inserção move `crm_leads.last_activity_at`, e apagar
 * a atividade depois NÃO devolve o relógio: apagar a causa não apaga o efeito.
 * Num pipeline cuja feature central é decidir quem esfriou, isso contamina
 * exatamente a grandeza sob medição — e foi assim que o meu próprio vigia deixou
 * dois negócios parecendo 49 minutos mais ativos do que estavam.
 *
 * `desfazer()` remove a linha E devolve o relógio. A devolução é por UPDATE
 * direto de propósito: o caminho de produção é o certo para CRIAR estado e o
 * errado para desfazê-lo — os efeitos colaterais dele estão certos indo e
 * errados voltando, e não existe caminho de produto que ande para trás.
 */
export async function atividadeDeTeste(
  admin: SupabaseClient,
  leadId: string,
  campos: Record<string, unknown>,
): Promise<{ desfazer: () => Promise<void> }> {
  const { data: antes } = await admin
    .from("crm_leads")
    .select("last_activity_at")
    .eq("id", leadId)
    .single();
  const relogio = (antes as { last_activity_at: string | null } | null)?.last_activity_at ?? null;
  const { error } = await admin
    .from("crm_lead_activities")
    .insert({ lead_id: leadId, ...campos } as never);
  if (error) throw new Error(`[atividadeDeTeste] ${error.message}`);
  return {
    desfazer: async () => {
      await admin
        .from("crm_lead_activities")
        .delete()
        .match({ lead_id: leadId, reason: String(campos.reason ?? "") });
      await admin.from("crm_leads").update({ last_activity_at: relogio } as never).eq("id", leadId);
    },
  };
}

export function carimbar(dependencias: string[]): string {
  const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();

  // A DEPENDÊNCIA DECLARADA TEM DE EXISTIR — e isto não era conferido.
  //
  // `git status --porcelain -- caminho/que/nao/existe` devolve VAZIO e sai com
  // zero: indistinguível de "limpo". Então um arquivo renomeado sumia da cadeia
  // em silêncio e o carimbo seguia dizendo "todas limpas — o veredito vale para
  // este commit", enquanto a prova declarava depender de algo que não está lá.
  //
  // É o mesmo formato dos defeitos deste dia: ausência com cara de aprovação. E
  // fica no lugar mais caro possível, porque o carimbo é o que dá validade a
  // todo veredito que eu emito.
  const inexistentes = dependencias.filter((d) => !fs.existsSync(path.join(process.cwd(), d)));
  if (inexistentes.length > 0) {
    throw new Error(
      `[carimbo] dependência declarada que NÃO EXISTE: ${inexistentes.join(", ")}.\n` +
        `git status sobre caminho inexistente devolve vazio, então isto passaria por "limpo" — ` +
        `e a prova diria depender de um arquivo que não está mais lá. Atualize a lista.`,
    );
  }
  // `execFileSync` com lista de argumentos, NÃO string de shell: os caminhos
  // vêm de quem chama, e interpolar isso numa linha de comando seria injeção
  // esperando acontecer. Não há entrada hostil aqui hoje — mas helper de teste
  // é justamente o código que alguém copia para outro lugar.
  // A MAQUINARIA COMPARTILHADA ENTRA SEMPRE, sem ninguém precisar lembrar.
  //
  // Hoje o conjunto é ENUMERÁVEL À MÃO — um módulo. A versão completa (ler os
  // imports transitivos de cada aparato e acusar os não declarados) custa uma
  // tarde e não se paga enquanto a lista couber numa linha. O GATILHO PARA
  // TROCAR fica declarado aqui para não virar "depois": quando o conjunto passar
  // de meia dúzia, OU quando a checagem abaixo acusar um módulo novo.
  // Todo aparato depende deste arquivo — placar, carimbo, seleção de alvo,
  // guarda de evidência — e uma mudança aqui muda o que TODOS eles medem. Deixar
  // que cada sonda lembre de declará-lo é regra de autoavaliação: quem esquece é
  // exatamente quem está com pressa. Declarar por construção custa uma linha.
  const todas = [...new Set([...INFRAESTRUTURA_COMPARTILHADA, ...dependencias])];
  // E O CONJUNTO SE VIGIA: se algum arquivo de `tests/` passar a ser importado
  // por dois ou mais aparatos sem estar na lista, ele é infraestrutura
  // compartilhada nova — e ninguém vai reparar, porque "minhas dependências"
  // exclui "as de todo mundo". Aqui o número que não bate denuncia sozinho, do
  // mesmo jeito que o contador da lista de sujos denuncia truncamento.
  // A DÍVIDA DE LIMPEZA, CONTADA EM VEZ DE LEMBRADA. Sonda que insere atividade
  // sem usar `atividadeDeTeste` apaga a linha e deixa o relógio do negócio
  // adiantado — apagar a causa não apaga o efeito. Retrofitar 17 aparatos ao
  // fechar o épico seria churn com risco; deixar a dívida invisível seria pior.
  // Aqui ela sobe quando alguém escreve mais uma, que é o número certo.
  const semDesfazer = sondasQueSujamORelogio();
  if (semDesfazer.length > 0) {
    console.info(
      `[carimbo] DÍVIDA DE LIMPEZA: ${semDesfazer.length} sonda(s) inserem atividade e NÃO ` +
        `devolvem last_activity_at — apagam a linha e deixam o negócio parecendo mais ativo do ` +
        `que está: ${semDesfazer.join(", ")}`,
    );
  }
  for (const novo of compartilhadosNaoDeclarados()) {
    console.info(
      `[carimbo] ⚠ INFRAESTRUTURA COMPARTILHADA NÃO DECLARADA: "${novo}" é importado por 2+ ` +
        `aparatos e não está em INFRAESTRUTURA_COMPARTILHADA. Enquanto não entrar, uma mudança ` +
        `nele muda o que vários aparatos medem sem que o carimbo veja.`,
    );
  }
  const sujos = execFileSync("git", ["status", "--porcelain", "--", ...todas], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);

  console.info(`[carimbo] HEAD=${head}`);
  console.info(`[carimbo] dependências declaradas: ${todas.join(", ")}`);
  arvoreSuja = sujos.length > 0 ? sujos.join(" · ") : "";
  dependenciasDoCarimbo = todas;
  if (sujos.length === 0) {
    console.info("[carimbo] todas limpas — o veredito vale para este commit");
    return "";
  }
  // Grita. Não bloqueia: iterar com a árvore suja é legítimo enquanto se
  // desenvolve; o que não pode é o resultado sair parecendo veredito.
  //
  // ⚠️ ESTA LISTA NUNCA PODE SER TRUNCADA, RESUMIDA OU OMITIDA POR BREVIDADE.
  // Desde que "árvore suja" virou código de saída, toda rodada de
  // desenvolvimento sai vermelha — então o vermelho passou a ter DUAS causas
  // (defeito medido / árvore suja), e a única coisa que as distingue é
  // exatamente esta lista. No dia em que alguém "limpar a saída" cortando-a, o
  // veredito binário fica sem o que o desambigua e as duas causas viram uma só.
  //
  // E a proteção não é este comentário — é o CONTADOR na linha de cima: se a
  // lista for truncada, o número deixa de bater com as linhas impressas, e a
  // omissão se denuncia sozinha. Comentário depende de alguém ler; contagem
  // que não fecha aparece na saída.
  console.info(
    `[carimbo] ⚠ ÁRVORE SUJA em ${sujos.length} arquivo(s) das dependências — ` +
      `este resultado NÃO é veredito (as ${sujos.length} linhas seguintes são a lista COMPLETA):`,
  );
  for (const l of sujos) console.info(`[carimbo]   ${l}`);
  return "-ARVORE-SUJA";
}

/**
 * INSERE UMA MENSAGEM COMO O PRODUTO INSERE — e devolve como apagá-la.
 *
 * ⚠️ EXISTE PORQUE `insert` DIRETO EM `messages` PLANTA ACHADO FALSO. As colunas
 * derivadas da conversa (`last_message_at`, `last_message_preview`,
 * `last_inbound_at`, `unread_count_for_assignee`) não são mantidas pela tabela:
 * quem as escreve são os DOIS caminhos de produção — `lib/waha/ingest.ts` pela
 * RPC `fn_mark_conversation_message`, e a API de mensagens por `update`.
 * Inserindo à mão, a sonda pula o escritor e depois lê uma coluna que ninguém
 * mandou atualizar. A tela mostra "Sem mensagens" numa conversa com mensagens, e
 * o defeito é da sonda.
 *
 * Isso não é hipótese e não aconteceu uma vez: em 25/07 uma rodada assim me fez
 * reportar um defeito de preview que não existia — a ponto de uma migration com
 * trigger ser aprovada para consertar nada — e a mesma linha plantada apareceu
 * na tela do QA como "Sem mensagens". Enquanto a sonda inserir direto, CADA
 * RODADA PLANTA UM ACHADO FALSO DE PRODUTO.
 *
 * A limpeza vem pelo ID devolvido, não por `LIKE` no corpo: um padrão que não
 * casa apaga zero linhas em silêncio, e foi assim que duas mensagens de sonda
 * sobreviveram a uma limpeza que "rodou".
 */
export async function mensagemDeSonda(
  admin: SupabaseClient,
  m: {
    organizationId: string;
    conversationId: string;
    contactId?: string;
    channelSessionId?: string;
    /** `inbound` conta como não-lida na conversa, igual ao produto. */
    direction: "inbound" | "outbound";
    body: string;
    /** Para a marca não ser cortada, ponha-a no COMEÇO do corpo. */
    preview?: string;
  },
): Promise<{ id: string; apaga: () => Promise<void> }> {
  const agora = new Date().toISOString();

  const { data, error } = await admin
    .from("messages")
    .insert({
      organization_id: m.organizationId,
      conversation_id: m.conversationId,
      contact_id: m.contactId ?? null,
      channel_session_id: m.channelSessionId ?? null,
      direction: m.direction,
      type: "text",
      body: m.body,
      status: m.direction === "inbound" ? "delivered" : "sent",
      sent_at: agora,
    })
    .select("id")
    .maybeSingle();
  if (error || !data) throw new Error(`mensagemDeSonda: insert falhou — ${error?.message ?? "sem linha"}`);

  // O MESMO escritor que o ingest usa. Falha aqui ESTOURA: uma sonda que segue
  // com a conversa não-carimbada mede o estado errado e chama isso de produto.
  const { error: erroRpc } = await admin.rpc("fn_mark_conversation_message", {
    p_conv: m.conversationId,
    p_direction: m.direction,
    p_preview: m.preview ?? m.body,
    p_at: agora,
  });
  if (erroRpc) throw new Error(`mensagemDeSonda: fn_mark_conversation_message falhou — ${erroRpc.message}`);

  const id = data.id;
  return {
    id,
    apaga: () => apagaExatamenteUm(admin, "messages", id),
  };
}

/**
 * APAGA UMA LINHA E EXIGE TER APAGADO UMA.
 *
 * Delete que não confere pode não ter casado com nada: some do log como
 * sucesso, e a linha fica no banco envenenando a próxima medição. Foi assim que
 * duas mensagens de sonda sobreviveram a uma limpeza que "rodou" — e uma delas
 * apareceu na tela do QA como defeito de produto.
 */
export async function apagaExatamenteUm(
  admin: SupabaseClient,
  tabela: string,
  id: string,
): Promise<void> {
  const { data, error } = await admin.from(tabela).delete().eq("id", id).select("id");
  if (error) throw new Error(`apagaExatamenteUm(${tabela}, ${id}): ${error.message}`);
  if ((data ?? []).length !== 1)
    throw new Error(`apagaExatamenteUm(${tabela}, ${id}): apagou ${(data ?? []).length} linhas, esperava 1`);
}
