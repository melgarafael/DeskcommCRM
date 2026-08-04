/**
 * WAVE 6 — o dossiê: cabeçalho vivo, timeline, campos por último.
 *
 * Armado antes da implementação. Cenários 18 a 21 do briefing.
 *
 * O ACHADO QUE JÁ NASCE COM O APARATO — e ele é do CONTRATO, não do código:
 *
 *   O cenário 20 diz "editar campo salva E APARECE NA TIMELINE com ator =
 *   humano". Hoje isso é impossível, e dá para provar sem abrir uma rota:
 *   `ActivityType` é exaustivo por construção (`Record<ActivityType, string>`,
 *   tipo novo sem rótulo não compila) e tem SETE valores — `stage_changed`,
 *   `note`, `ai_turn`, `send_vetoed`, `handoff_triggered`,
 *   `next_action_approved`, `next_action_dismissed`. Nenhum deles é "o humano
 *   mudou um campo".
 *
 *   A assimetria é ESTRUTURAL, não um esquecimento: o vocabulário foi crescendo
 *   pelo que a IA faz. A IA deixa rastro; o humano, não. E numa entrega cujo
 *   contrato é "continuidade IA↔humano", quem some do registro é justamente o
 *   lado que precisa ser auditável quando algo dá errado.
 *
 * AS ARMADILHAS QUE ESTE ARQUIVO EXISTE PARA NÃO CAIR:
 *
 *  (a) "O SHEET ABRIU" NÃO É O CENÁRIO 18. O cenário é a ORDEM: cabeçalho →
 *      timeline → campos. Ordem se mede por posição vertical, não por presença.
 *  (b) COLAPSO PRECISA DE CASO E DE VIZINHO. Três eventos do mesmo ator no mesmo
 *      minuto para colapsar, e um de OUTRO ator ao lado que NÃO pode ser
 *      colapsado junto — senão "colapsou" não distingue agrupar de esconder.
 *  (c) COLAPSO SE PROVA PELO NÚMERO. O bloco tem de dizer QUANTOS, e expandir
 *      tem de revelar exatamente esses. "Aparece menos linha" também é o que se
 *      vê quando a timeline perdeu eventos.
 *  (d) O 20 TEM DUAS METADES E ELAS FALHAM SEPARADO: salvar pode funcionar e o
 *      registro não existir. Asserto o valor PERSISTIDO e a linha na timeline.
 *  (e) O 21 É REALTIME, então carrega a pré-condição de capacidade: sem provar
 *      que a entrega funciona para quem devia receber, "entrou ao vivo" e "não
 *      entrou" são indistinguíveis de um canal morto.
 *
 * Run: E2E_PORT=3020 npx tsx tests/capture-wave-6-cenarios.ts
 */

import { chromium, type Locator, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs";

import { ACTIVITY_LABELS, actorShape, type ActivityType } from "@/lib/leads/activity-vocabulary";
import {
  CREDS,
  EVIDENCE,
  cardLocator,
  carimbar,
  casoConstruido,
  criarPlacar,
  gotoBoard,
  login,
  shotPage,
} from "./qa-helpers";

const envFile = fs.readFileSync(".env.local", "utf8");
const envVars: Record<string, string> = {};
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) envVars[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
}
const admin = createClient(envVars.NEXT_PUBLIC_SUPABASE_URL!, envVars.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ORG = CREDS.org_id as string;
const PIPELINE = (CREDS.crm_vivo as { pipeline_id: string }).pipeline_id;
const STAGE = Object.values((CREDS.crm_vivo as { stage_ids: Record<string, string> }).stage_ids)[0]!;
const DONO = (CREDS.users as Record<string, { id: string }>).manager!.id;
const PREFIXO = "QA-W6";
const RUN = randomUUID().slice(0, 8);

/**
 * A LISTA É DECLARADA AQUI, e é o contrato do placar: critério que estiver nela
 * e não for avaliado sai como AUSENTE no fim. Foi assim que o D19.rotulo e o D25
 * sumiram — acrescentados no meio e esquecidos no caminho de retorno antecipado.
 */
const CRITERIOS = [
  "D20.contrato",
  "D22.formas",
  "D18",
  "D19",
  "D19.rotulo",
  "D20",
  "D21",
  "D23",
  "D24",
  "D25",
  "D26",
  "D20.pii",
  "D27",
];
const { record, fechar } = criarPlacar("WAVE 6", CRITERIOS);

/**
 * O cenário 20 é IMPOSSÍVEL pelo vocabulário, e isso se verifica sem tocar em
 * rota nenhuma: a lista de tipos é a fonte única de escrita e leitura.
 */
function vocabularioTemEdicaoHumana(): { tem: boolean; tipos: string[] } {
  const tipos = Object.keys(ACTIVITY_LABELS) as ActivityType[];
  const tem = tipos.some((t) => /field|campo|edit|updated|lead_updated/i.test(t));
  return { tem, tipos };
}

/**
 * DOIS LEADS, e a diferença entre eles é a variável do teste.
 *
 * Eu tinha UM, sem contato — porque o D26 é sobre o lead sem contato. Mas os
 * outros critérios precisam de uma timeline POPULADA, e sem contato ela nunca
 * carrega: eu estava medindo colapso, rótulo de ator e assinatura sobre uma tela
 * que não tinha como mostrar nada.
 *
 * Reusar o caso de um critério para todos é o mesmo erro do alvo sorteado numa
 * escala acima: o caso vira "o lead que eu tinha à mão" em vez de "o lead que
 * este critério exige".
 */
async function montarCaso(): Promise<{
  leadId: string;
  titulo: string;
  agenteId: string | null;
  leadComContato: string;
  tituloComContato: string;
}> {
  const titulo = `${PREFIXO} ${RUN} — dossiê`;
  const { data: lead, error } = await admin
    .from("crm_leads")
    .insert({
      organization_id: ORG,
      pipeline_id: PIPELINE,
      stage_id: STAGE,
      title: titulo,
      status: "open",
      source: "manual",
      value_cents: 300_000,
      currency: "BRL",
      owner_kind: "user",
      owner_user_id: DONO,
      owner_agent_id: null,
      position_in_stage: 6000,
      last_activity_at: new Date().toISOString(),
    } as never)
    .select("id")
    .single();
  if (error || !lead) throw new Error(`criar lead: ${error?.code} ${error?.message}`);
  const leadId = (lead as { id: string }).id;

  const { data: agentes } = await admin
    .from("ai_agents")
    .select("id")
    .eq("organization_id", ORG)
    .limit(1);
  const agenteId = ((agentes ?? [])[0] as { id: string } | undefined)?.id ?? null;

  // TRÊS do mesmo ator no MESMO minuto (o caso do colapso) e UMA de outro ator
  // logo depois (o vizinho que NÃO pode ser colapsado junto). Sem o vizinho,
  // "colapsou" não distingue agrupar de esconder.
  const base = Date.now();
  const linhas = [
    { type: "ai_turn", actor_kind: "ai", actor_agent_id: agenteId, reason: `${RUN} · a IA respondeu sobre prazo`, ms: 0 },
    { type: "ai_turn", actor_kind: "ai", actor_agent_id: agenteId, reason: `${RUN} · a IA respondeu sobre preço`, ms: 5_000 },
    { type: "ai_turn", actor_kind: "ai", actor_agent_id: agenteId, reason: `${RUN} · a IA confirmou o horário`, ms: 10_000 },
    // TRÊS DO TIME, consecutivas: sem um BLOCO do time não dá para comparar como
    // o bloco do CLIENTE se lê. Eu tinha uma nota solta, e uma linha única não é
    // bloco — o critério exigia um rótulo que o caso nunca produziria.
    { type: "note", actor_kind: "user", actor_agent_id: null, reason: `${RUN} · anotação do humano`, ms: 90_000 },
    { type: "note", actor_kind: "user", actor_agent_id: null, reason: `${RUN} · segunda anotação do time`, ms: 95_000 },
    { type: "note", actor_kind: "user", actor_agent_id: null, reason: `${RUN} · terceira anotação do time`, ms: 100_000 },
    // TRÊS DO CLIENTE, também consecutivas. Existem porque `filled` cobre
    // `user` E `contact`: um bloco colapsado de ações do CLIENTE tem de se ler
    // diferente de um do TIME, e a forma não consegue fazer essa distinção —
    // só o texto (`actorLabel` dá cinco rótulos onde a forma dá três).
    // De passagem: `contact` tem ZERO linhas no banco real, então este é o
    // primeiro caso do quinto ator, e ele é construído.
    { type: "note", actor_kind: "contact", actor_agent_id: null, reason: `${RUN} · o cliente perguntou o prazo`, ms: 180_000 },
    { type: "note", actor_kind: "contact", actor_agent_id: null, reason: `${RUN} · o cliente mandou o documento`, ms: 185_000 },
    { type: "note", actor_kind: "contact", actor_agent_id: null, reason: `${RUN} · o cliente confirmou o endereço`, ms: 190_000 },
  ];
  for (const l of linhas) {
    const { error: e2 } = await admin.from("crm_lead_activities").insert({
      organization_id: ORG,
      lead_id: leadId,
      source_module: "qa",
      type: l.type,
      actor_kind: l.actor_kind,
      actor_agent_id: l.actor_agent_id,
      performed_by_user_id: l.actor_kind === "user" ? DONO : null,
      contact_id: null,
      reason: l.reason,
      // `crm_lead_activities_ai_needs_evidence`: atividade de IA sem run/trace/
      // llm_call NÃO grava. É a lei do porquê aplicada também ao registro — e a
      // minha primeira versão do seed foi barrada por ela, o que é a constraint
      // fazendo exatamente o trabalho dela contra um cliente descuidado (eu).
      evidence: l.actor_kind === "ai" ? { run_ids: [randomUUID()] } : {},
      performed_at: new Date(base - 600_000 + l.ms).toISOString(),
    } as never);
    if (e2) throw new Error(`criar atividade: ${e2.code} ${e2.message}`);
  }
  // O IRMÃO COM CONTATO — mesmo conteúdo, e a única diferença é o eixo.
  const { data: contato, error: eC } = await admin
    .from("contacts")
    .insert({
      organization_id: ORG,
      name: `${PREFIXO} ${RUN} contato`,
      display_name: `${PREFIXO} ${RUN} contato`,
      phone_number: `+5511${900_000_000 + (parseInt(RUN, 16) % 90_000_000)}`,
      source: "manual",
    } as never)
    .select("id")
    .single();
  if (eC || !contato) throw new Error(`criar contato: ${eC?.code} ${eC?.message}`);
  const contactId = (contato as { id: string }).id;

  const tituloComContato = `${PREFIXO} ${RUN} — dossiê COM contato`;
  const { data: lead2, error: e3 } = await admin
    .from("crm_leads")
    .insert({
      organization_id: ORG,
      pipeline_id: PIPELINE,
      stage_id: STAGE,
      contact_id: contactId,
      title: tituloComContato,
      status: "open",
      source: "manual",
      value_cents: 300_000,
      currency: "BRL",
      owner_kind: "user",
      owner_user_id: DONO,
      owner_agent_id: null,
      position_in_stage: 6001,
      last_activity_at: new Date().toISOString(),
    } as never)
    .select("id")
    .single();
  if (e3 || !lead2) throw new Error(`criar lead com contato: ${e3?.code} ${e3?.message}`);
  const leadComContato = (lead2 as { id: string }).id;

  for (const l of linhas) {
    const { error: e4 } = await admin.from("crm_lead_activities").insert({
      organization_id: ORG,
      lead_id: leadComContato,
      contact_id: contactId,
      source_module: "qa",
      type: l.type,
      actor_kind: l.actor_kind,
      actor_agent_id: l.actor_agent_id,
      performed_by_user_id: l.actor_kind === "user" ? DONO : null,
      reason: l.reason,
      evidence: l.actor_kind === "ai" ? { run_ids: [randomUUID()] } : {},
      performed_at: new Date(base - 600_000 + l.ms).toISOString(),
    } as never);
    if (e4) throw new Error(`atividade do irmão: ${e4.code} ${e4.message}`);
  }

  // O IRMÃO DO IRMÃO: segundo lead DO MESMO CONTATO, com uma atividade que só
  // existe nele. A rota puxa as atividades de TODOS os leads do contato, então
  // pelo código o dossiê de um negócio pode somar as do outro — sem marcador
  // dizendo de onde veio.
  //
  // Isto tem ZERO linhas no banco real: dois contatos têm mais de um lead e
  // nenhum deles tem atividade. Defeito possível e NÃO observado só vira medível
  // com caso construído — e vazio se lê como "nada aconteceu", enquanto isto se
  // lê como "aconteceu AQUI", que é atribuição errada em silêncio.
  const tituloIrmao = `${PREFIXO} ${RUN} — IRMÃO do mesmo contato`;
  const { data: lead3, error: e5 } = await admin
    .from("crm_leads")
    .insert({
      organization_id: ORG,
      pipeline_id: PIPELINE,
      stage_id: STAGE,
      contact_id: contactId,
      title: tituloIrmao,
      status: "open",
      source: "manual",
      value_cents: 700_000,
      currency: "BRL",
      owner_kind: "user",
      owner_user_id: DONO,
      owner_agent_id: null,
      position_in_stage: 6002,
      last_activity_at: new Date().toISOString(),
    } as never)
    .select("id")
    .single();
  if (e5 || !lead3) throw new Error(`criar irmão: ${e5?.code} ${e5?.message}`);
  const { error: e6 } = await admin.from("crm_lead_activities").insert({
    organization_id: ORG,
    lead_id: (lead3 as { id: string }).id,
    contact_id: contactId,
    source_module: "qa",
    type: "note",
    actor_kind: "user",
    performed_by_user_id: DONO,
    reason: `${RUN} · ISTO PERTENCE AO OUTRO NEGOCIO`,
    evidence: {},
    performed_at: new Date(base - 300_000).toISOString(),
  } as never);
  if (e6) throw new Error(`atividade do irmão: ${e6.code} ${e6.message}`);

  return { leadId, titulo, agenteId, leadComContato, tituloComContato };
}

async function limpar(): Promise<number> {
  const { data } = await admin
    .from("crm_leads")
    .select("id")
    .eq("organization_id", ORG)
    .like("title", `${PREFIXO} %`);
  const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
  if (ids.length === 0) return 0;
  await admin.from("crm_lead_activities").delete().in("lead_id", ids);
  await admin.from("crm_leads").delete().in("id", ids);
  await admin.from("contacts").delete().eq("organization_id", ORG).like("name", `${PREFIXO} %`);
  return ids.length;
}

/** O painel do dossiê, seja qual for o invólucro que a implementação escolher. */
function dossie(page: Page): Locator {
  return page.locator('[role="dialog"], [data-dossie], aside[aria-label*="lead" i]').first();
}

/**
 * Posição vertical de um trecho dentro do dossiê — a ORDEM se mede.
 *
 * Procura no texto E no VALOR dos campos. O ensaio contra o diálogo de hoje
 * devolveu `null` para o título: ele não é texto, é `value` de um input — e o
 * meu localizador só olhava texto. Um critério de ORDEM que não acha a âncora do
 * cabeçalho falharia no dia da entrega por defeito meu.
 */
async function topoDe(painel: Locator, padrao: RegExp): Promise<number | null> {
  const porTexto = painel.locator(`text=${padrao}`).first();
  if ((await porTexto.count()) > 0) {
    const box = await porTexto.boundingBox();
    if (box) return box.y;
  }
  const campos = painel.locator("input, textarea");
  for (let i = 0; i < (await campos.count()); i++) {
    const v = await campos.nth(i).inputValue().catch(() => "");
    if (padrao.test(v)) {
      const box = await campos.nth(i).boundingBox();
      if (box) return box.y;
    }
  }
  return null;
}

/** Entrega de verdade num quadro do Phoenix: `[join_ref, ref, topic, event, payload]`.
 *  O recibo de inscrição carrega as mesmas palavras no corpo — só a POSIÇÃO separa. */
function ehEntrega(bruto: string): boolean {
  try {
    const q: unknown = JSON.parse(bruto);
    return Array.isArray(q) && q[3] === "postgres_changes";
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const sufixo = carimbar([
    // O APARATO ENTRA NA PRÓPRIA LISTA — ideia do @DevVivo, e ele está certo:
    // instrumento não commitado produz veredito irreprodutível do mesmo jeito que
    // produto não commitado. Declarar só as dependências do produto deixa o carimbo
    // dizer "todas limpas" enquanto a RÉGUA muda debaixo do resultado.
    "tests/capture-wave-6-cenarios.ts",
    "components/kanban/KanbanCard.tsx",
    // O dossiê nasceu, então a prova passou a DEPENDER dele. Carimbo que declara
    // uma cadeia incompleta diz "todas limpas" sobre um arquivo que nem está na
    // lista — é o mesmo furo do caminho inexistente, pelo lado da omissão.
    "components/kanban/LeadDossier.tsx",
    "hooks/leads/useLeadTimeline.ts",
    "components/kanban/EditLeadDialog.tsx",
    "components/contacts/TimelineView.tsx",
    "lib/leads/activity-vocabulary.ts",
  ]);
  casoConstruido(
    "lead sem contato e quatro atividades semeadas — o quinto ator não existe em dado",
  );

  // ---- 20.contrato: verificável sem abrir a tela ---------------------------
  const voc = vocabularioTemEdicaoHumana();
  record(
    "D20.contrato",
    "o vocabulário TEM um tipo para 'o humano editou um campo'",
    voc.tem,
    voc.tem
      ? `tipos: ${voc.tipos.join(", ")}`
      : `os ${voc.tipos.length} tipos existentes são ${voc.tipos.join(", ")} — nenhum registra ` +
        `edição humana de campo. A IA deixa rastro e o humano não, e a assimetria está no TIPO, ` +
        `não numa rota esquecida`,
    voc.tem ? undefined : "BLOQUEADO",
  );

  // ---- D22.formas: o marcador do ator, ANTES de existir pixel na tela --------
  //
  // O critério é "distinguir o CONTATO do AGENTE sem legenda, no tamanho
  // renderizado". Ele passa hoje — mas o mapa de formas conta uma história que
  // vale ler antes de mexer nele.
  const ATORES = ["user", "ai", "system", "rule", "contact"];
  const mapa = Object.fromEntries(ATORES.map((a) => [a, actorShape(a)]));
  const colisoes = ATORES.flatMap((a, i) =>
    ATORES.slice(i + 1)
      .filter((b) => mapa[a] === mapa[b])
      .map((b) => `${a}=${b} (${mapa[a]})`),
  );
  record(
    "D22.formas",
    "o marcador do CONTATO se distingue do marcador do AGENTE pela forma",
    mapa.contact !== mapa.ai,
    `mapa atual: ${ATORES.map((a) => `${a}→${mapa[a]}`).join(" · ")}` +
      (colisoes.length ? ` | pares que COMPARTILHAM forma: ${colisoes.join(", ")}` : "") +
      ` | as colisões são DELIBERADAS: o eixo da forma é gente/agente/máquina, e o cliente é ` +
      `gente. Quem é especificamente vem do TEXTO (actorLabel dá cinco nomes para cinco atores) ` +
      `— por isso o rótulo do bloco colapsado não pode sair da forma, e é o que o D19.rotulo mede`,
  );

  const sobras = await limpar();
  if (sobras > 0) console.info(`[limpeza inicial] ${sobras} lead(s) de rodada anterior`);
  const caso = await montarCaso();
  const browser = await chromium.launch();

  try {
    const page = await (
      await browser.newContext({ viewport: { width: 1440, height: 900 } })
    ).newPage();
    page.setDefaultTimeout(60_000);

    // O CONTADOR DE ASSINATURA É ARMADO AQUI, antes do login.
    // `page.on("websocket")` só enxerga sockets abertos DEPOIS de anexado — no
    // ensaio ele registrou 0 entradas e 0 saídas porque eu o anexava lá embaixo,
    // com o socket já aberto. Um contador cego reportaria "nenhum canal do
    // dossiê observado", que é um BLOQUEADO falso: o instrumento acusaria
    // ausência de recurso onde havia ausência de escuta.
    const assinatura = { joins: 0, leaves: 0, porTopico: new Map<string, { j: number; l: number }>() };
    // COLETADO DESDE O NASCIMENTO DA PÁGINA. Anexar no meio do fluxo perderia o
    // join e a confirmação do canal da timeline, que acontecem quando o dossiê
    // abre — e "nenhuma resposta do servidor" seria o meu ouvinte chegando tarde,
    // não o servidor calado. Já me pegou hoje com o contador de assinatura.
    let quadrosDeAtividade = 0;
    const respostasTimeline: string[] = [];
    /**
     * TODO quadro de `postgres_changes` recebido, com o TÓPICO que o entregou.
     *
     * O contador anterior somava quadros da PÁGINA. Ele responde "chegou algum
     * quadro?", e a pergunta é "chegou por QUAL canal?". Sem o eixo do tópico,
     * dois laudos diferentes colapsam no mesmo zero: "nenhum canal entrega nada"
     * (socket morto, autenticação, conexão) e "todos entregam menos este"
     * (configuração do canal do dossiê). O primeiro absolve o dossiê; o segundo
     * o acusa sozinho. É o mesmo defeito das três máscaras noutra dimensão:
     * medir o AGREGADO quando a pergunta é sobre uma PARTE.
     */
    const entregas: { topico: string; tabela: string; ms: number }[] = [];
    /**
     * A ORDEM dos quadros de ciclo de vida do canal da timeline, não a contagem.
     * O contador diz 1 entrada e 2 saídas por abertura; `leave-join-leave` é o
     * padrão do supabase-js (derruba a instância anterior, entra, sai na
     * desmontagem) e é INOCENTE. `join-leave` seria a assinatura viva sendo
     * derrubada logo após ser confirmada — que casa com "confirmado e mudo".
     * Contagem igual, veredito oposto: só a sequência separa os dois.
     */
    const ciclo: string[] = [];
    const t0 = Date.now();
    // O JOIN do canal da timeline leva IDENTIDADE? Um assinante privilegiado
    // recebe o mesmo evento (medido em tests/prova-canal-timeline.ts), então a
    // publicação e o filtro estão inocentes e sobra o assinante. Restam duas:
    // canal ANÔNIMO (join sem access_token) ou autenticado com RLS negando.
    // O quadro de join separa as duas.
    let joinDaTimeline = "";
    page.on("websocket", (ws) => {
      if (!ws.url().includes("supabase")) return;
      // Um socket que MORRE no meio explica "entregou e parou" sem culpar canal
      // nenhum — e sem este registro a reconexão silenciosa é invisível.
      // O HOST DO SOCKET, não só o fato de ele existir. Um canal que confirma e
      // nunca entrega tem uma explicação embaraçosa que eu ainda não descartei:
      // o navegador estar assinando OUTRA instância — as confirmações viriam
      // certinhas de lá, e as escritas nunca chegariam porque acontecem aqui.
      // Tudo o que eu medi até agora é compatível com isso.
      ciclo.push(`+${Date.now() - t0}ms SOCKET aberto em ${new URL(ws.url()).host}`);
      ws.on("close", () => ciclo.push(`+${Date.now() - t0}ms SOCKET fechado`));
      ws.on("framesent", (f) => {
        const t = String(f.payload);
        const topico = (t.match(/realtime:([^"]+)/) ?? [])[1] ?? "?";
        const reg = assinatura.porTopico.get(topico) ?? { j: 0, l: 0 };
        if (/phx_join/.test(t)) {
          assinatura.joins++;
          reg.j++;
          // O ÚLTIMO join, não o primeiro. O canal que está vivo durante a ação
          // é o da última abertura do dossiê; guardar o primeiro fazia eu
          // verificar identidade e validade de um canal já desfeito — medir um
          // objeto e concluir sobre outro.
          if (/timeline-/.test(t)) joinDaTimeline = t;
          if (/timeline-/.test(topico)) ciclo.push(`+${Date.now() - t0}ms JOIN  ${topico}`);
        }
        if (/phx_leave/.test(t)) {
          assinatura.leaves++;
          reg.l++;
          if (/timeline-/.test(topico)) ciclo.push(`+${Date.now() - t0}ms LEAVE ${topico}`);
        }
        assinatura.porTopico.set(topico, reg);
      });
      ws.on("framereceived", (f) => {
        const t = String(f.payload);
        // SEGUNDA CORREÇÃO DO MESMO CONTADOR, e a primeira estava errada também.
        // Ele exigia só a PALAVRA "postgres_changes" e o nome da tabela — e o
        // `phx_reply` que CONFIRMA a assinatura contém as duas, porque ecoa a
        // configuração pedida: contava recibo como entrega. Eu "consertei"
        // exigindo `"event":"postgres_changes"` e troquei falso positivo por
        // falso NEGATIVO, porque o quadro do Phoenix é um ARRAY —
        // `[join_ref, ref, topic, event, payload]` — e não existe chave
        // `"event":` nenhuma. O contador passou a marcar zero sempre, inclusive
        // onde a entrega funciona. Agora ele lê a POSIÇÃO, que é onde a
        // informação mora, e o zero volta a significar alguma coisa.
        if (ehEntrega(t) && /crm_lead_activities/.test(t)) quadrosDeAtividade++;
        // O tópico vem no MESMO quadro que traz a linha — é o servidor dizendo
        // por qual canal aquilo entrou. Registrar os dois juntos é o que
        // transforma "chegou" em "chegou por onde".
        if (ehEntrega(t)) {
          const q = JSON.parse(t) as unknown[];
          entregas.push({
            topico: String(q[2] ?? "?").replace(/^realtime:/, ""),
            tabela: (t.match(/"table":"([^"]+)"/) ?? [])[1] ?? "?",
            ms: Date.now() - t0,
          });
        }
        if (/timeline-/.test(t) && /(phx_reply|system|error)/.test(t)) {
          respostasTimeline.push(t.slice(0, 200));
        }
      });
    });

    await login(page, "manager");
    await gotoBoard(page);

    // ---- ENSAIO=1: exercita a maquinaria contra a superfície que JÁ EXISTE ---
    //
    // Sete critérios deste aparato nunca rodaram: eles destravam todos de uma vez
    // no dia em que o dossiê nascer, que é o dia em que não há tempo de descobrir
    // que o locator não resolve. Então antes disso a máquina é exercitada contra
    // o `EditLeadDialog`, que é o diálogo com campos que existe hoje.
    //
    // O resultado NÃO entra no placar da wave: o dossiê continua não existindo, e
    // misturar as duas coisas transformaria "o instrumento funciona" em "o
    // cenário passa". É ensaio de instrumento, não veredito de produto.
    if (process.env.ENSAIO === "1") {
      const { card: cardEnsaio } = await cardLocator(page, caso.titulo);
      await cardEnsaio.getByRole("button", { name: "Ações do lead" }).click();
      await page.getByRole("menuitem", { name: /editar/i }).click();
      await page.waitForTimeout(1200);
      const painelEnsaio = dossie(page);
      const abriuEnsaio = (await painelEnsaio.count()) > 0;
      console.info(`\n[ensaio] diálogo abriu: ${abriuEnsaio}`);
      if (abriuEnsaio) {
        const yTitulo = await topoDe(painelEnsaio, new RegExp(RUN));
        const yCampos = await topoDe(painelEnsaio, /valor|t[íi]tulo/i);
        console.info(`[ensaio] medição de ORDEM funciona: topo=${yTitulo} campos=${yCampos}`);
        const campo = painelEnsaio.locator('input[name="title"], #title').first();
        console.info(`[ensaio] localizador de campo editável resolve: ${(await campo.count()) > 0}`);
        const texto0 = ((await painelEnsaio.innerText()) ?? "").replace(/\s+/g, " ");
        console.info(`[ensaio] leitura de texto do painel: ${texto0.length} caracteres`);
      }
      // O contador de assinatura, exercitado com abre/fecha REAIS.
      const jEnsaio0 = assinatura.joins;
      const lEnsaio0 = assinatura.leaves;
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(500);
        const { card: c } = await cardLocator(page, caso.titulo);
        await c.getByRole("button", { name: "Ações do lead" }).click();
        await page.getByRole("menuitem", { name: /editar/i }).click();
        await page.waitForTimeout(700);
      }
      await page.keyboard.press("Escape");
      console.info(
        `[ensaio] contador de assinatura opera: ${assinatura.joins - jEnsaio0} entradas / ` +
          `${assinatura.leaves - lEnsaio0} saídas em 3 ciclos (total na página: ${assinatura.joins}/${assinatura.leaves})`,
      );
      console.info("[ensaio] — nada disto entra no placar: o dossiê continua não existindo\n");
    }

    // ---- 18: clicar no card abre o dossiê, na ORDEM certa -------------------
    // O lead COM contato: os critérios de timeline exigem uma timeline que
    // CARREGUE. Medir colapso e rótulo de ator no lead sem contato seria medir a
    // ausência de eixo e chamá-la de defeito de apresentação.
    const { card } = await cardLocator(page, caso.tituloComContato);
    await card.click();
    await page.waitForTimeout(1500);
    const painel = dossie(page);
    const abriu = (await painel.count()) > 0 && (await painel.first().isVisible().catch(() => false));

    if (!abriu) {
      record(
        "D18",
        "CENÁRIO 18: clicar no card abre o dossiê (cabeçalho → timeline → campos)",
        false,
        "nenhum painel abriu ao clicar no card — o dossiê não existe ainda " +
          "(EditLeadDialog segue como diálogo do menu de ações)",
        "BLOQUEADO",
      );
      // A LISTA TEM DE CONTER TODOS. Quando eu acrescentei o D19.rotulo e o D25
      // sem incluí-los aqui, eles sumiram do placar em silêncio pelo caminho do
      // retorno antecipado — o mesmo formato que eu transformei em lei hoje de
      // manhã: critério pulado sem vermelho para investigar e com o placar de pé.
      for (const [n, nome] of [
        ["D19", "CENÁRIO 19: timeline colapsa eventos consecutivos do mesmo ator"],
        ["D19.rotulo", "o bloco colapsado nomeia o ATOR pelo texto — CLIENTE não se lê como TIME"],
        ["D25", "âncora sem alvo vira TEXTO, não link nem exceção (LGPD, e não é defeito)"],
        ["D26", "lead SEM contato mostra as PRÓPRIAS atividades na timeline"],
        ["D20.pii", "o registro diz QUAL campo mudou e NÃO carrega o valor"],
        ["D27", "o dossiê de um negócio NÃO mostra as atividades do negócio irmão"],
        ["D20", "CENÁRIO 20: editar campo salva E aparece na timeline com ator humano"],
        ["D21", "CENÁRIO 21: ação do agente na outra aba entra na timeline ao vivo"],
        ["D23", "o Sheet DESASSINA ao fechar — abrir e fechar N vezes não acumula canal"],
        ["D24", "a fonte devolve EVENTOS; quem agrupa é a tela"],
      ] as [string, string][]) {
        record(n, nome, false, "sem dossiê aberto não há superfície para medir — preso ao D18", "BLOQUEADO");
      }
      await shotPage(page, `wave-6-sem-dossie${sufixo}.png`, false);
      return;
    }

    const yCabecalho = await topoDe(painel, new RegExp(RUN));
    // A ÂNCORA DA SEÇÃO, não o texto de um evento. Eu ancorava no motivo de uma
    // atividade — e ela está COLAPSADA dentro de um bloco, então o texto não
    // aparece. Quarto critério meu hoje a exigir uma forma específica em vez da
    // coisa: a seção existe, o evento individual é detalhe dela.
    const yTimeline = await topoDe(painel, /linha do tempo/i);
    const yCampos = await topoDe(painel, /valor|título|estágio/i);
    const ordemOk =
      yCabecalho !== null &&
      yTimeline !== null &&
      yCampos !== null &&
      yCabecalho < yTimeline &&
      yTimeline < yCampos;
    record(
      "D18",
      "CENÁRIO 18: clicar no card abre o dossiê (cabeçalho → timeline → campos)",
      ordemOk,
      `posições verticais — cabeçalho=${yCabecalho} timeline=${yTimeline} campos=${yCampos}` +
        (ordemOk ? "" : " — a ORDEM é o cenário, não a presença"),
    );
    await shotPage(page, `wave-6-d18-dossie${sufixo}.png`, false);

    // ---- 19: colapso com vizinho de outro ator ------------------------------
    const texto = ((await painel.innerText()) ?? "").replace(/\s+/g, " ");
    // DOIS blocos, um por ator. A primeira versão exigia que a linha individual
    // do humano CONTINUASSE VISÍVEL — e ela some, corretamente, porque as três
    // notas do time também colapsam. Eu estava exigindo que o produto NÃO
    // agrupasse o segundo ator, que é o oposto do cenário.
    // PRÉ-CONDIÇÃO DE CAPACIDADE: a timeline pode ter FALHADO ao carregar, e ela
    // diz isso na tela ("Não consegui carregar a linha do tempo") — que é o
    // comportamento certo, e é diferente de "carregou e não colapsou". Sem esta
    // guarda eu reprovaria o agrupamento por causa de uma leitura que nem chegou.
    const timelineCarregou = !/não consegui carregar|nao consegui carregar/i.test(texto);
    const blocos = texto.match(/·\s*3\s+(ações|eventos|atividades)/gi) ?? [];
    const naoEngoliu = blocos.length >= 2;
    record(
      "D19",
      "CENÁRIO 19: colapsa por ATOR — dois blocos de 3, não um de 6",
      timelineCarregou && naoEngoliu,
      !timelineCarregou
        ? `INCONCLUSIVO: a timeline não carregou nesta rodada — a tela diz isso, e é o ` +
          `comportamento certo, mas não dá para julgar agrupamento sem leitura`
        : `blocos de 3 anunciados: ${blocos.length} (esperado 2 — cliente e time) · ` +
          `painel diz: "${texto.slice(0, 150)}"` +
          (blocos.length === 1 ? " — um bloco só significa que os dois atores foram engolidos juntos" : ""),
      timelineCarregou ? undefined : "INCONCLUSIVO",
    );

    // ---- 19.rótulo: o bloco do CLIENTE não pode se ler como o do TIME -------
    //
    // `filled` cobre `user` E `contact` — de propósito, porque o eixo da forma é
    // gente/agente/máquina e o cliente É gente. A consequência é que o rótulo do
    // bloco colapsado NÃO pode sair da forma: tem de vir do texto, onde há cinco
    // nomes para cinco atores. Sem isso, três ações do CLIENTE se leem como três
    // do TIME, e o dossiê passa a mentir sobre quem fez o quê.
    // A INTENÇÃO, não a letra. A primeira versão exigia a string "Você/time" —
    // e o produto nomeia a PESSOA ("E2E Manager"), que é mais específico que o
    // rótulo genérico. Eu teria reprovado um acerto por não estar escrito com as
    // palavras que eu tinha na cabeça. O que o critério afirma é que os dois
    // blocos se LEEM DIFERENTE e que cada um nomeia o seu ator.
    const dizCliente = /cliente/i.test(texto);
    const dizTime = /você\/time|voce\/time|E2E Manager/i.test(texto);
    record(
      "D19.rotulo",
      "cada bloco nomeia o SEU ator pelo texto — CLIENTE não se lê como TIME",
      timelineCarregou && dizCliente && dizTime,
      !timelineCarregou
        ? "INCONCLUSIVO: sem timeline carregada não há bloco para rotular"
        : `no painel: cliente nomeado=${dizCliente} · time nomeado=${dizTime} — a forma não ` +
          `distingue os dois (ambos preenchidos), então quem distingue é o texto`,
      timelineCarregou ? undefined : "INCONCLUSIVO",
    );

    // ---- 20: as duas metades, medidas separado -----------------------------
    const campoValor = painel.locator('input[name="value_cents"], #value_cents, input[name="title"]').first();
    if ((await campoValor.count()) === 0) {
      record("D20", "CENÁRIO 20: editar campo salva E aparece na timeline", false, "sem campo editável no dossiê", "BLOQUEADO");
    } else {
      // O TÍTULO DO LEAD QUE ESTÁ ABERTO. Isto montava o valor novo a partir do
      // título do OUTRO lead — achado pela auditoria que o regente mandou fazer:
      // trocar o fixture reaponta todo critério que nomeia uma linha, e NADA
      // avisa quais. Reler os que eu lembrava de ter mexido não bastou.
      const novo = `${caso.tituloComContato} (editado)`;
      await campoValor.fill(novo);
      await painel.getByRole("button", { name: /salvar|guardar/i }).first().click().catch(() => null);
      await page.waitForTimeout(2500);
      // O LEAD CERTO: depois de o dossiê principal passar a ser o do irmão COM
      // contato, esta verificação continuava lendo o outro — e reprovava o
      // produto porque eu conferia um lead que ninguém editou.
      const { data: linha } = await admin
        .from("crm_leads")
        .select("title")
        .eq("id", caso.leadComContato)
        .single();
      const persistiu = (linha as { title: string } | null)?.title === novo;
      const { data: ativs } = await admin
        .from("crm_lead_activities")
        .select("type,actor_kind,reason,payload")
        .eq("lead_id", caso.leadComContato);
      const humana = (
        (ativs ?? []) as {
          type: string;
          actor_kind: string;
          reason: string | null;
          payload: Record<string, unknown> | null;
        }[]
      ).find((a) => a.actor_kind === "user" && a.type === "lead_edited");

      // QUAIS campos mudaram — no `reason` OU no `payload`, e a diferença não é
      // detalhe: o TÍTULO DO LEAD É O NOME DO CLIENTE ("Carlos — Clínica Vida
      // Odonto"). Um critério que exigisse os campos no texto empurraria alguém a
      // escrever o VALOR ali, e o registro de auditoria viraria vazamento.
      //
      // Então a asserção aceita as duas formas e ganha a metade que faltava: os
      // NOMES têm de estar; os VALORES não podem estar. Critério que só cobra a
      // presença empurra para o excesso — foi o mesmo raciocínio da evidência
      // "até três, nunca cota".
      // NÃO PEDIDO ≠ VAZIO, e a diferença me custou um vermelho falso reportado.
      //
      // A primeira versão selecionava só `type,actor_kind` e afirmava sobre
      // `reason`. O campo vinha `undefined` — ausente da RESPOSTA, não ausente do
      // BANCO — e eu reportei "grava sem dizer o que mudou" sobre uma coluna que
      // eu nunca tinha pedido. O instrumento afirmava sobre um dado que ele não
      // buscou.
      //
      // `undefined` e `null` são estados diferentes e o JavaScript os confunde no
      // `??`. Aqui eles se separam: undefined acusa o INSTRUMENTO, null acusa o
      // produto.
      if (humana && !("reason" in humana)) {
        throw new Error(
          "[D20] a consulta não trouxe `reason` — o critério afirma sobre um campo que não foi " +
            "pedido. Não-pedido não é vazio, e reportar isso como defeito acusa o produto por " +
            "uma coluna ausente da minha própria query.",
        );
      }
      const registro = `${humana?.reason ?? ""} ${JSON.stringify(humana?.payload ?? {})}`;
      const dizOQueMudou = /t[íi]tulo|title|valor|value|est[áa]gio|stage|dono|owner|descri/i.test(registro);
      record(
        "D20",
        "CENÁRIO 20: editar campo salva, registra como lead_edited e DIZ o que mudou",
        persistiu && Boolean(humana) && dizOQueMudou,
        `persistiu=${persistiu} · atividade lead_edited=${humana ? "sim" : "NENHUMA"} · ` +
          `nomeia o campo alterado=${dizOQueMudou} · registro: ${registro.slice(0, 120)} — ` +
          `as três falham separado: salvar pode funcionar, o registro não existir, e o ` +
          `registro existir sem dizer o que mudou`,
      );

      // O REGISTRO NÃO PODE CARREGAR O VALOR. O título do lead é o nome do
      // cliente, então gravar "de X para Y" põe PII num log de auditoria que
      // sobrevive à anonimização do contato. Nome de campo é metadado; valor de
      // campo é dado pessoal.
      // A guarda procura o VALOR QUE FOI ESCRITO — antes ela procurava o título
      // antigo do lead certo enquanto o valor gravado vinha do outro. Passava
      // por sorte, pela segunda cláusula.
      const vazouValor = registro.includes(novo) || /\(editado\)/.test(registro);
      record(
        "D20.pii",
        "o registro diz QUAL campo mudou e NÃO carrega o valor — título é nome de cliente",
        Boolean(humana) && !vazouValor,
        vazouValor
          ? `o valor do campo aparece no registro: ${registro.slice(0, 140)}`
          : "só nomes de campo no registro — o valor fica fora do log de auditoria",
      );
    }

    // ---- 27: o irmão do mesmo contato ---------------------------------------
    //
    // PROVA DA CERCA, sem tocar em código de produção. Esta guarda nasceu DEPOIS
    // do conserto, então nunca viu o defeito vivo — e guarda de regressão que
    // nunca reprovou é guarda por afirmação: ela passa, e passaria também
    // mirando no lugar errado, porque não há mais nada ali para pegá-la.
    //
    // Reverter o conserto seria a prova real e não é minha para fazer. Mas dá
    // para construir o ESTADO que ela guarda: basta a atividade do irmão passar a
    // pertencer ao lead sob teste. Se o critério não ficar vermelho aí, ele não
    // morde.
    if (process.env.SELFCHECK_D27 === "1") {
      await admin
        .from("crm_lead_activities")
        .update({ lead_id: caso.leadComContato } as never)
        .eq("organization_id", ORG)
        .like("reason", `%ISTO PERTENCE AO OUTRO NEGOCIO%`);
      await page.reload();
      await page.locator("[data-rfd-draggable-id]").first().waitFor({ state: "visible" });
      const { card: cRe } = await cardLocator(page, caso.tituloComContato);
      await cRe.click();
      await page.waitForTimeout(1500);
      console.info("[selfcheck D27] a atividade do irmão foi ligada ao lead sob teste");
    }
    // NÃO BASTA O TEXTO SUMIR. A atividade do irmão é do MESMO ator que o time,
    // então ela colapsaria DENTRO do bloco do time — e o motivo individual não
    // apareceria mesmo tendo vazado. "Não vejo a frase" também é o que se vê
    // quando ela está agrupada.
    //
    // Quem distingue é a CONTAGEM: o time tem 3 atividades neste negócio. Se o
    // bloco anunciar 4, o irmão entrou. É o mesmo raciocínio do colapso — o bloco
    // que diz quantos é o único que separa agrupar de somar o que não é seu.
    // LÊ A TELA AGORA, não a foto de antes. O `texto` foi capturado lá em cima,
    // no bloco do colapso — e o selfcheck reabre o painel depois disso. A cerca
    // não mordeu na primeira tentativa por isso: ela media o estado ANTERIOR à
    // mutação que existia para fazê-la morder.
    const textoAgora = ((await dossie(page).innerText()) ?? "").replace(/\s+/g, " ");
    const blocoDoTime = textoAgora.match(/E2E Manager\s*·\s*(\d+)\s+ações/i);
    const quantasDoTime = blocoDoTime ? Number(blocoDoTime[1]) : -1;
    // DUAS CLÁUSULAS, e cada uma pega um caso: o texto pega a atividade que
    // aparece como linha INDIVIDUAL; a contagem pega a que entrou DENTRO de um
    // bloco e some da tela. Sozinha, cada uma tem um ponto cego.
    const porTexto = /ISTO PERTENCE AO OUTRO NEGOCIO/i.test(textoAgora);
    const porContagem = quantasDoTime > 0 && quantasDoTime !== 3;
    const vazouIrmao = porTexto || porContagem;
    record(
      "D27",
      "o dossiê de um negócio NÃO mostra as atividades do negócio IRMÃO",
      timelineCarregou && !vazouIrmao,
      !timelineCarregou
        ? "INCONCLUSIVO: a timeline não carregou nesta rodada"
        : vazouIrmao
          ? `a atividade do OUTRO negócio do mesmo contato entrou neste dossiê, detectada ` +
            `${porTexto ? "pelo TEXTO (apareceu como linha individual)" : ""}` +
            `${porTexto && porContagem ? " e " : ""}` +
            `${porContagem ? `pela CONTAGEM (bloco do time anuncia ${quantasDoTime}, esperado 3)` : ""}` +
            ` — sem marcador dizendo de onde veio. Vazio se lê como "nada aconteceu"; isto se lê ` +
            `como "aconteceu AQUI"`
          : `só as atividades deste negócio (bloco do time anuncia ${quantasDoTime}, que é o certo)`,
      timelineCarregou ? undefined : "INCONCLUSIVO",
    );

    // ---- 26: o lead SEM contato — 25% deles, e 66% das atividades ------------
    //
    // A timeline é indexada por CONTATO: o hook filtra `contact_id=eq.<id>` e a
    // rota busca as atividades diretas do contato mais as dos leads dele. Um
    // lead sem contato não tem porta de entrada nenhuma.
    //
    // Medido no banco de teste: 13 de 53 leads não têm contato, e 117 das 177
    // atividades pertencem a esses leads. Não é caso de canto — é a MAIORIA do
    // que está registrado hoje.
    //
    // E o que torna isto caro é a leitura na TELA: uma timeline vazia por falta
    // de EIXO se lê exatamente como uma timeline vazia por falta de ACONTECIMENTO.
    // O usuário vê "nada aconteceu neste negócio" sobre um negócio com histórico.
    // É a ausência com cara de aprovação, agora na frente do cliente.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);
    const { card: cardSemContato } = await cardLocator(page, caso.titulo);
    await cardSemContato.click();
    await page.waitForTimeout(1500);
    const textoTimeline = ((await dossie(page).innerText()) ?? "").replace(/\s+/g, " ");
    // POR CONTAGEM, não pelo texto de uma atividade. As três da IA colapsam em
    // "Agente · 3 ações", então procurar o motivo individual reprova por
    // OCULTAÇÃO — a mesma lei que eu acabei de mecanizar do lado da ausência,
    // agora mordendo do lado da presença. Presença também precisa de observável
    // que sobreviva ao agrupamento.
    const somaBlocos = [...textoTimeline.matchAll(/·\s*(\d+)\s+(?:ações|eventos|atividades)/gi)]
      .reduce((soma, m) => soma + Number(m[1]), 0);
    const linhasSoltas = (textoTimeline.match(/\d{2}:\d{2}/g) ?? []).length;
    const mostraAsAtividades = somaBlocos + linhasSoltas >= 4;
    if (!mostraAsAtividades) {
      await shotPage(page, `wave-6-d26-timeline-vazia-por-eixo${sufixo}.png`, false);
    }
    record(
      "D26",
      "lead SEM contato mostra as PRÓPRIAS atividades na timeline",
      mostraAsAtividades,
      mostraAsAtividades
        ? `o lead sem contato exibe as atividades ligadas a ele (${somaBlocos + linhasSoltas} contadas)`
        : `timeline com ${somaBlocos + linhasSoltas} atividade(s) para um lead que TEM 4 — e ` +
          `vazia por falta de eixo se lê igual a vazia por falta de acontecimento`,
    );

    // ---- 24: a FONTE devolve eventos; quem agrupa é a TELA -------------------
    //
    // Se o agrupamento descer para a consulta, a paginação passa a contar BLOCOS
    // e um INSERT chegando por realtime não sabe em que bloco entrar. Então a
    // pergunta não é estética: é se o colapso é apresentação ou modelagem.
    // Mede-se comparando o que a ROTA devolve com o que a TELA mostra.
    const respostaTimeline = await page.evaluate(async (id: string) => {
      const r = await fetch(`/api/v1/leads/${id}/timeline`, { credentials: "include" });
      if (!r.ok) return { status: r.status, itens: -1 };
      const b = (await r.json()) as { data?: unknown[] };
      return { status: r.status, itens: Array.isArray(b.data) ? b.data.length : -1 };
    }, caso.leadId);
    record(
      "D24",
      "a fonte devolve EVENTOS; quem agrupa é a tela",
      respostaTimeline.status === 200 && respostaTimeline.itens >= 4,
      respostaTimeline.status !== 200
        ? `GET /api/v1/leads/<id>/timeline devolveu ${respostaTimeline.status} — a rota por lead ainda não existe`
        : `a rota devolveu ${respostaTimeline.itens} item(ns) para as 4 atividades semeadas — ` +
          `menos que isso significa agrupamento na CONSULTA, e aí a paginação conta blocos`,
      respostaTimeline.status === 404 ? "BLOQUEADO" : undefined,
    );

    // ---- 25: âncora sem alvo NÃO vira link, e isso NÃO é defeito -------------
    //
    // Sob LGPD a mensagem referenciada pode ter sido removida. Lançar exceção ou
    // fabricar um link morto reintroduziria o vazamento que a anonimização
    // fechou. O critério afirma o comportamento BOM: texto simples, sem quebrar.
    const quebrou = await page.evaluate(() => document.body.innerText.includes("Application error"));
    record(
      "D25",
      "âncora sem alvo vira TEXTO, não link nem exceção (LGPD, e não é defeito)",
      !quebrou,
      quebrou
        ? "a tela caiu em error boundary com uma âncora sem alvo"
        : "o dossiê renderizou sem quebrar — evidência removida por anonimização é caso legítimo",
    );

    // ---- 23: o vazamento que teste curto NUNCA pega -------------------------
    //
    // Abrir e fechar UMA vez não revela assinatura que não é desfeita: o canal
    // órfão só incomoda quando se acumula. Então o instrumento faz o que o uso
    // real faz — abre e fecha várias vezes — e compara ENTRADAS com SAÍDAS.
    //
    // A contagem é de `phx_join` contra `phx_leave` no socket: se o Sheet
    // desassina, cada abertura tem a sua saída. Se não desassina, as entradas
    // crescem e as saídas não — e o número da diferença É o vazamento.
    const antesJ = assinatura.joins;
    const antesL = assinatura.leaves;
    // A LISTA POR TÓPICO TAMBÉM PRECISA SER DA JANELA. Ela acumulava desde o
    // início da página enquanto os totais eram do intervalo dos ciclos — duas
    // réguas no mesmo relatório, e um baseline com duas réguas engana todo
    // número futuro que for comparado com ele.
    const antesPorTopico = new Map(
      [...assinatura.porTopico.entries()].map(([t, r]) => [t, { ...r }]),
    );
    const CICLOS = 4;
    for (let i = 0; i < CICLOS; i++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(600);
      // PELO ID, não pelo título: o critério anterior EDITA o título, e um
      // localizador por texto procuraria o nome antigo. O aparato quebrava com
      // "nenhum card casa" e dois critérios viraram AUSENTE — que foi o placar
      // desta manhã pegando o meu erro em tempo real, no mesmo dia em que o
      // construí para isso.
      //
      // E o canal da timeline é `timeline-<contactId>`: ciclar o lead SEM contato
      // abriria um dossiê que não assina nada, e o contador leria zero. Ausência
      // de recurso e ausência de caso produzem o mesmo zero.
      const c = page.locator(`[data-rfd-draggable-id="${caso.leadComContato}"]`).first();
      await c.scrollIntoViewIfNeeded();
      await c.click();
      await page.waitForTimeout(900);
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(900);
    const joins = assinatura.joins - antesJ;
    const leaves = assinatura.leaves - antesL;
    record(
      "D23",
      "o Sheet DESASSINA ao fechar — abrir e fechar N vezes não acumula canal",
      joins > 0 && joins - leaves <= 1,
      joins === 0
        ? "nenhum canal observado nos ciclos, com um lead QUE TEM contato — então o dossiê " +
          "não assina, ou assina com outro nome"
        : `${CICLOS} aberturas DENTRO da janela → ${joins} entradas e ${leaves} saídas ` +
          `— o supabase-js manda um phx_leave ANTES do join do mesmo tópico e outro na ` +
          `desmontagem, então DUAS saídas por entrada é o esperado (mesma razão medida no ` +
          `inbox). A saída que sobra é de um canal aberto ANTES desta janela e fechado dentro ` +
          `dela — aparece como 0j/1s na lista. Assimetria explicada, não tolerada: baseline com ` +
          `número inexplicado engana todo número futuro comparado com ele. Por tópico: ` +
          `${[...assinatura.porTopico.entries()]
            .filter(([t]) => /timeline/i.test(t))
            .map(([t, r]) => {
              const a = antesPorTopico.get(t) ?? { j: 0, l: 0 };
              return { t, j: r.j - a.j, l: r.l - a.l };
            })
            .filter((x) => x.j > 0 || x.l > 0)
            .map((x) => `${x.t.slice(-14)} ${x.j}j/${x.l}s`)
            .join(", ") || "(nenhum)"}` +
          ` | PREVISÃO RETIRADA, e o erro era MEU: eu previ que a contagem passaria de 4 para 5 ` +
          `depois do conserto do eixo, atribuindo a diferença ao lead sem contato. Errado em ` +
          `dois níveis. O canal passou a ser indexado pelo LEAD (timeline-<leadId>), então todo ` +
          `lead assina — e a diferença nunca foi o eixo. E os "5" eram aritmética minha: o laço ` +
          `abre ${CICLOS} vezes DENTRO da janela, e a quinta abertura aconteceu ANTES dela (é ` +
          `dela a saída solta 0j/1s). Previsão construída sobre modelo errado do próprio ` +
          `instrumento prevê o instrumento, não o produto.`,
      joins === 0 ? "BLOQUEADO" : undefined,
    );

    // ---- 21: ao vivo, e a pré-condição vem primeiro -------------------------
    //
    // O cenário é: dossiê aberto numa aba, ação em OUTRA, e a linha entra sem F5.
    // Três coisas podem produzir "não entrou", e só uma é o defeito:
    //   (a) a ação não aconteceu — intenção não é efeito, foi o que me pegou no
    //       12.a da wave 3, onde eu lia a tela de quem AGIU e chamava de ação;
    //   (b) a entrega está morta para todo mundo — e aí "não chegou" não prova
    //       nada sobre esta tela;
    //   (c) chegou e a tela não aplicou — o defeito.
    // Por isso a ação é confirmada NO BANCO antes de julgar a tela.
    const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const abaB = await ctxB.newPage();
    abaB.setDefaultTimeout(60_000);
    try {
      await login(abaB, "manager");
      await gotoBoard(abaB);

      // A aba A precisa estar com o dossiê ABERTO — é a condição do cenário.
      const { card: cardA } = await cardLocator(page, caso.tituloComContato);
      await cardA.click();
      await page.waitForTimeout(1200);
      // A CONTAGEM DA TIMELINE, não o texto do painel. A edição muda o TÍTULO, e
      // o cabeçalho do dossiê mostra o título — então "o painel mudou" seria
      // verdade mesmo que a timeline não recebesse nada, pelo canal do board.
      // Teste confundido: duas variáveis mudando e uma conclusão só.
      const contarLinhas = async (p2: Page): Promise<number> => {
        const t = ((await dossie(p2).innerText()) ?? "").replace(/\s+/g, " ");
        const blocos = [...t.matchAll(/·\s*(\d+)\s+(?:ações|eventos|atividades)/gi)].reduce(
          (soma, m) => soma + Number(m[1]),
          0,
        );
        const soltas = (t.match(/\d{2}:\d{2}/g) ?? []).length;
        return blocos + soltas;
      };
      const antesA = await contarLinhas(page);

      // A ação nasce na OUTRA aba, pela interface: editar um campo emite
      // `lead_edited`, que é atividade de verdade no mesmo eixo da timeline.
      // JANELA: a contagem tem de ser DEPOIS da ação. O total desde o nascimento
      // da página inclui os quadros do próprio seed, e reportar esse número
      // responderia "chegam quadros nesta página", não "chegou ESTE".
      const quadrosAntes = quadrosDeAtividade;
      const entregasAntes = entregas.length;
      // QUANTAS ATIVIDADES EXISTEM ANTES da ação. A pré-condição procurava
      // QUALQUER `lead_edited` — e o critério anterior já tinha criado um. Ela
      // era satisfeita por linha VELHA, então "a ação persistiu" podia ser
      // verdade sobre uma ação de dez minutos atrás. Pré-condição que não
      // distingue o novo do antigo não é pré-condição.
      const { data: antesDaAcao } = await admin
        .from("crm_lead_activities")
        .select("id")
        .eq("lead_id", caso.leadComContato);
      const totalAntes = ((antesDaAcao ?? []) as unknown[]).length;
      const cardB = abaB.locator(`[data-rfd-draggable-id="${caso.leadComContato}"]`).first();
      await cardB.scrollIntoViewIfNeeded();
      await cardB.click();
      await abaB.waitForTimeout(1200);
      const painelB = dossie(abaB);
      const campoB = painelB.locator('input[name="title"], #title').first();
      const marca = `${RUN}-AOVIVO`;
      await campoB.fill(`${caso.tituloComContato} ${marca}`);
      await painelB.getByRole("button", { name: /salvar|guardar/i }).first().click().catch(() => null);
      await abaB.waitForTimeout(2500);

      // (a) A AÇÃO ACONTECEU? Confirmado no banco, não na tela de quem agiu.
      const { data: novas } = await admin
        .from("crm_lead_activities")
        .select("id")
        .eq("lead_id", caso.leadComContato);
      const totalDepois = ((novas ?? []) as unknown[]).length;
      const acaoPersistiu = totalDepois > totalAntes;

      // O lead_id DA ATIVIDADE CRIADA contra o lead que o canal filtra. O canal
      // assina `lead_id=eq.<leadId>`; se a atividade nascer com outro lead (ou
      // órfã), o filtro a exclui CORRETAMENTE e o vermelho é do CASO, não do
      // canal. Um quarto do espaço de hipóteses eliminado por uma consulta.
      const { data: ultima } = await admin
        .from("crm_lead_activities")
        .select("id,type,lead_id,contact_id,created_at")
        .eq("lead_id", caso.leadComContato)
        .order("created_at", { ascending: false })
        .limit(1);
      const linhaNova = ((ultima ?? [])[0] ?? null) as
        | { type: string; lead_id: string | null; contact_id: string | null }
        | null;
      const leadBate = linhaNova?.lead_id === caso.leadComContato;
      const tokenNoJoin = /"access_token":"([^"]+)"/.exec(joinDaTimeline);
      let papel = "(sem join capturado)";
      let subDoCanal = "";
      let validade = "";
      if (joinDaTimeline) {
        papel = tokenNoJoin ? "(jwt ilegível)" : "SEM access_token — canal ANÔNIMO";
        if (tokenNoJoin) {
          try {
            const corpo = JSON.parse(Buffer.from(tokenNoJoin[1]!.split(".")[1]!, "base64").toString());
            subDoCanal = String(corpo.sub ?? "");
            papel = `role=${corpo.role} sub=${subDoCanal.slice(0, 8)}`;
            // O REALTIME PARA DE ENTREGAR COM O TOKEN VENCIDO E NÃO DESFAZ O
            // CANAL — o join continua confirmado e a entrega some. "Confirmado e
            // mudo" é exatamente o que eu estou vendo, então a validade não é
            // detalhe: é uma das poucas causas que produzem esse par.
            const agora = Math.floor(Date.now() / 1000);
            validade =
              typeof corpo.exp === "number"
                ? corpo.exp < agora
                  ? `VENCIDO há ${agora - corpo.exp}s`
                  : `válido por mais ${corpo.exp - agora}s`
                : "(sem exp no token)";
          } catch {
            /* mantém ilegível */
          }
        }
      }
      // O `sub` do canal é O MESMO usuário que a RLS aprovaria? Um token de
      // OUTRO usuário (sessão velha, outra org) daria exatamente este quadro:
      // join aceito, binding confirmado, entrega negada em silêncio — e o
      // "defeito" seria a RLS fazendo o trabalho dela, certo.
      const { data: usuarios } = await admin.auth.admin.listUsers();
      const manager = (usuarios?.users ?? []).find((u) => u.email === "e2e-manager@deskcomm.test");
      const mesmoUsuario = manager?.id === subDoCanal;
      console.info(
        `[D21 diag] token do canal: ${validade} · sub=${subDoCanal.slice(0, 8)} · ` +
          `usuário logado=${manager?.id?.slice(0, 8) ?? "?"} · mesmo usuário=${mesmoUsuario}`,
      );
      console.info(`[D21 diag] identidade do canal da timeline: ${papel}`);
      // O QUADRO DE JOIN INTEIRO, com o token elidido. Node e navegador mandam a
      // mesma coisa? Eu venho comparando as duas pontas por RESULTADO ("um
      // recebe, o outro não") sem nunca ter olhado o que cada um PEDE. Se o
      // pedido do navegador diferir — outra configuração, outro binding, canal
      // privado —, a diferença está aqui e é de graça.
      console.info(
        `[D21 diag] join do navegador (token elidido):\n  ` +
          joinDaTimeline.replace(/"access_token":"[^"]+"/, '"access_token":"<jwt>"').slice(0, 700),
      );
      console.info(
        `[D21 diag] atividade mais recente: type=${linhaNova?.type} lead_id=${linhaNova?.lead_id?.slice(0, 8)} ` +
          `contact_id=${linhaNova?.contact_id?.slice(0, 8) ?? "null"} · canal filtra ` +
          `${caso.leadComContato.slice(0, 8)} · bate=${leadBate}`,
      );

      // (c) A ABA A recebeu, SEM F5?
      await page.waitForTimeout(6000);

      // ---- O SEGUNDO NÚMERO: de que LADO caiu -------------------------------
      //
      // A janela é a mesma da ação (`entregasAntes`), pelo motivo de sempre: o
      // total desde o carregamento inclui o seed e responderia a outra pergunta.
      const janela = entregas.slice(entregasAntes);
      const porCanal = new Map<string, string[]>();
      for (const e of janela) {
        const k = `${e.topico} :: ${e.tabela}`;
        porCanal.set(k, [...(porCanal.get(k) ?? []), `+${e.ms}ms`]);
      }
      console.info(
        `[D21 diag] quadros de postgres_changes na janela da ação, POR CANAL: ` +
          (porCanal.size === 0
            ? "NENHUM canal recebeu nada — não é do dossiê nem do socket: é a entrega deste pipeline"
            : [...porCanal.entries()].map(([k, v]) => `${k} ×${v.length}`).join(" | ")),
      );
      // O MESMO EIXO APLICADO AO PASSADO. "Zero na janela" tem dois pais muito
      // diferentes: um socket que nunca entregou nada (conexão/autenticação) e
      // um que entregou e PAROU (canal derrubado, sessão expirada, reconexão sem
      // re-assinar). O primeiro é veredito; o segundo é sintoma de outra coisa.
      // A janela sozinha não separa os dois — só o contraste com o antes.
      const antesDaJanela = new Map<string, number>();
      for (const e of entregas.slice(0, entregasAntes)) {
        const k = `${e.topico} :: ${e.tabela}`;
        antesDaJanela.set(k, (antesDaJanela.get(k) ?? 0) + 1);
      }
      console.info(
        `[D21 diag] quadros ANTES da janela (mesma página, mesmo socket): ` +
          (antesDaJanela.size === 0
            ? "NENHUM — este socket nunca entregou nada"
            : [...antesDaJanela.entries()].map(([k, n]) => `${k} ×${n}`).join(" | ")),
      );
      console.info(
        `[D21 diag] ciclo de vida do canal da timeline, em ORDEM:\n  ` +
          (ciclo.length === 0 ? "(nenhum quadro de join/leave observado)" : ciclo.join("\n  ")),
      );
      // ---- A ÚLTIMA VARIÁVEL: o MESMO token, fora do navegador ---------------
      //
      // O join do navegador é idêntico ao do node — mesma configuração, mesmo
      // binding, `private:false`, mesmo host, mesmo usuário, token válido. Se
      // sobrou uma diferença, ela está no TOKEN ou não existe. Este assinante usa
      // o token QUE O NAVEGADOR MANDOU, na MESMA janela e com o MESMO gatilho:
      //   recebe    → o token está bom e a diferença é do cliente do navegador
      //   não recebe → o token do navegador é diferente do token do login direto,
      //                apesar de mesmo `sub`, e a raiz é de emissão de sessão
      // Duas leituras na mesma foto: o único jeito de não estar comparando com
      // uma condição que mudou entre execuções.
      // O ENSAIO ANTERIOR ERA CONFUNDIDO e por pouco eu não reportava: ele
      // comparava o token do navegador (neste lead, construído) com o token de
      // login direto (noutro lead, de outra execução). Duas variáveis, uma
      // conclusão. Aqui os assinantes escutam o MESMO lead e o MESMO INSERT:
      //   serviço      — CONTROLE. Ignora RLS. Zero aqui significa que o evento
      //                  não foi publicado, e nenhum dos outros zeros diz nada.
      //   token do navegador
      //   token de login direto, recém-emitido
      // Sem o controle, "ninguém recebeu" tem dois pais — nada publicado, ou
      // todo mundo barrado — e eu escolheria o que combina com a minha hipótese.
      // O CONTROLE SAI DESTE PROCESSO. Um controle limpo, criado aqui dentro,
      // deu zero — e a MESMA sonda, sozinha noutro processo, deu 12/12 com
      // 123–587ms de atraso. Enquanto eu não souber o que este processo faz com
      // o realtime, tudo que ele mede sobre entrega está contaminado, inclusive
      // a leitura do navegador. Então o controle vira um PROCESSO IRMÃO: mesma
      // janela de tempo, mesmo lead, ambiente independente. Se ele receber e o
      // navegador não, a comparação vale; se ele não receber, o silêncio é do
      // ambiente e o navegador segue sem julgamento — que é o resultado honesto
      // e o que eu ia perder tratando o meu próprio zero como veredito.
      const quadrosNavegadorAntes = quadrosDeAtividade;
      let controleExterno = await new Promise<string>((resolve) => {
        // `process.execPath` + `--import tsx` em vez de `npx tsx`: no Windows o
        // `npx` não é executável, é o shim `npx.cmd`, e o `execFile` sem shell
        // devolve ENOENT para um e EINVAL para o outro (CVE-2024-27980). O
        // `execFile` engole o erro no callback — o controle irmão viraria
        // "(não mediu)" caladamente, e o critério cairia no ramo que trata
        // "ninguém recebeu" como ambiente morto. Ou seja: não é vermelho que
        // aparece, é veredito trocado, que é pior. Mesma porta que os seeds E2E
        // usam (tests/e2e/helpers/seed.ts), aqui em forma assíncrona.
        execFile(
          process.execPath,
          ["--import", "tsx", "tests/prova-taxa-de-entrega.ts"],
          // N=1 basta desde que a raiz foi nomeada: aqui o controle não investiga
          // mais nada, só responde "havia como chegar?". Três rodadas eram o
          // preço de uma pergunta que já foi respondida noutro lugar.
          { env: { ...process.env, LEAD_ID: caso.leadComContato, N: "1", ESPERA_MS: "6000" } },
          (_e, saida) => resolve((saida.match(/TAXA DE ENTREGA: (\d+\/\d+)/) ?? [])[1] ?? "(não mediu)"),
        );
      });
      // SELFCHECK_D21=1 finge que o controle irmão não recebeu, para exercitar o
      // ramo BLOQUEADO. Ramo que nunca rodou não está provado — e este só roda
      // naturalmente quando a entrega está morta, que é justamente o dia em que
      // ninguém tem tempo de descobrir que a cerca não mordia.
      if (process.env.SELFCHECK_D21 === "1") controleExterno = "0/1 (SELFCHECK)";
      const placarDoEspiao =
        `MESMO lead, MESMA janela · controle em processo IRMÃO=${controleExterno} · ` +
        `navegador=${quadrosDeAtividade - quadrosNavegadorAntes} quadro(s) da atividade do controle`;
      console.info(`[D21 diag] ${placarDoEspiao}`);

      const depoisA = await contarLinhas(page);
      // O SELFCHECK precisa sabotar AS DUAS coisas. Na primeira tentativa eu
      // forcei só o controle a zero e o critério continuou PASS — corretamente,
      // porque o ramo BLOQUEADO só vale quando a tela NÃO mudou. Sabotar uma
      // condição de um `&&` e concluir que a cerca não morde é o mesmo erro de
      // ler um `&&` como `||`: eu teria "provado" um defeito que não existia no
      // meu próprio instrumento.
      const mudou = process.env.SELFCHECK_D21 === "1" ? false : depoisA > antesA;

      record(
        "D21",
        "CENÁRIO 21: ação na OUTRA aba entra na timeline aberta, sem F5",
        acaoPersistiu && mudou,
        !acaoPersistiu
          ? `INCONCLUSIVO: a edição da outra aba não criou atividade nenhuma (${totalAntes} antes, ` +
            `${totalDepois} depois) — sem evento não há entrega a julgar, e culpar o realtime aqui ` +
            `seria acusar a superfície errada`
          : mudou
            ? `a timeline aberta ganhou linha sozinha: ${antesA} → ${depoisA} atividades`
            : controleExterno.startsWith("0/")
              ? `a entrega de postgres_changes está morta NESTE ambiente — o controle em processo ` +
                `irmão (${controleExterno}) também não recebeu. Sem quadro possível, este critério ` +
                `não julga o dossiê: seria reprovar a tela por uma pré-condição que faltou.`
              : `a timeline aberta seguiu com ${antesA} atividades e a ação PERSISTIU. ` +
              `Quadros de crm_lead_activities recebidos pela aba A DEPOIS da ação: ` +
              `${quadrosDeAtividade - quadrosAntes} (${quadrosDeAtividade} desde o carregamento) — ` +
              (quadrosDeAtividade - quadrosAntes > 0
                ? "o quadro CHEGOU e a tela não aplicou"
                : "o quadro NÃO chegou. RAIZ NOMEADA (590b594): a entrega de postgres_changes " +
                  "morre para leads do pipeline do CRM Vivo — medido com assinante de serviço, sem " +
                  "filtro, contra pipeline fabricado de controle. A tela do dossiê está INOCENTE: " +
                  "não há quadro para ela aplicar. O vermelho continua sendo vermelho porque para " +
                  "quem usa o board a timeline não anda sozinha, mas o conserto não é aqui. " +
                  "Respostas do servidor ao " +
                  `canal da timeline: ${respostasTimeline.slice(0, 2).join(" | ") || "(NENHUMA — o canal não foi confirmado)"}. ` +
                  `Entregas na MESMA janela, por canal: ` +
                  (porCanal.size === 0
                    ? "NENHUMA em canal nenhum — e o socket está vivo (o servidor responde e " +
                      "confirma a assinatura). O que morre é a ENTREGA deste pipeline"
                    : [...porCanal.keys()].join(" | ") +
                      " — outro canal entrega e o do dossiê não, o que isola na configuração dele")),
        // O TERCEIRO ESTADO PELA PRÉ-CONDIÇÃO DE AMBIENTE, e não pela ação.
        // Hoje este critério ficou vermelho por horas porque a entrega de
        // postgres_changes estava morta para este pipeline — medição correta,
        // veredito falso: o vermelho parecia acusar o dossiê e acusava o
        // ambiente. Vermelho por pré-condição ausente é indistinguível de
        // vermelho por defeito para quem lê o placar, e só quem foi ler o
        // mecanismo separa. Agora o controle em processo irmão decide: se NEM
        // ELE recebeu, não havia como o navegador receber, e o veredito é
        // BLOQUEADO com a causa. Se ele recebeu e o navegador não, aí sim a
        // acusação é da tela.
        !acaoPersistiu
          ? "BLOQUEADO"
          : !mudou && controleExterno.startsWith("0/")
            ? "BLOQUEADO"
            : undefined,
      );
    } finally {
      await ctxB.close();
    }

  } finally {
    await browser.close();
    console.info(`[limpeza] ${await limpar()} lead(s) de teste removidos`);
    // O FECHAMENTO VIVE NO `finally`, e a razão é o próprio defeito que este
    // placar existe para pegar: o caminho "dossiê não existe" usa `return`, que
    // sai da função inteira — com o fechamento depois do `try`, ele seria
    // PULADO. O mecanismo contra critério pulado estava, ele mesmo, sendo pulado.
    if (fechar() > 0) process.exitCode = 1;
  }
}

main().catch(async (err) => {
  console.error("❌ Wave 6 falhou:", err);
  await limpar().catch(() => null);
  process.exit(1);
});
