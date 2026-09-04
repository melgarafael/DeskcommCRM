/**
 * A CASCATA DE ANONIMIZAÇÃO — os passos 2 e 3, num lugar só (issue #310).
 *
 * ─── Por que este arquivo existe ────────────────────────────────────────────
 *
 * A rota `POST /api/v1/lgpd/anonymize` sabia retomar uma cascata interrompida,
 * e isso não bastava: no estado exato que a retomada conserta — `is_anonymized`
 * verdadeiro, leads e atividades ainda não redigidas — **a tela não tem botão**.
 * `app/app/contacts/[id]/_client.tsx` troca o botão por um parágrafo quando o
 * contato já está anonimizado, e `setAnonOpen(true)` é o ÚNICO caminho para o
 * diálogo em todo o repositório. A correção existia e era inalcançável.
 *
 * O remédio não pode ser "põe um botão": a LGPD dá PRAZO (redact em D+15), e um
 * direito do titular não deveria depender de alguém lembrar de clicar. Então
 * quem conserta é o cron diário de retenção — `varrerRedacoesIncompletas` — e a
 * tela só relata. O botão continua servindo à PRIMEIRA execução, que é o que
 * ele sempre foi.
 *
 * ─── Por que a regra mora AQUI, e não dentro da rota ────────────────────────
 *
 * Duas bocas escrevem a mesma redação (a rota e o cron). Com a regra duplicada,
 * a próxima correção do corte do título entraria numa e não na outra, e o
 * sintoma seria títulos redigidos de dois jeitos diferentes no mesmo banco —
 * o anti-pattern nº 2 do CLAUDE.md, duplicação sem source of truth declarado.
 *
 * ─── Idempotência não é firula aqui ─────────────────────────────────────────
 *
 * O passo 2 monta o título como `title.slice(0, 20) + " (anonimizado)"`. Rodar
 * de novo sobre um título JÁ redigido produz "Orçamento telhado (an (anonimizado)"
 * e, na rodada seguinte, come o resto — a retomada que existe para CURAR
 * estragaria. Com um cron diário isso deixou de ser hipótese: sem a guarda do
 * sufixo, todo título de contato anonimizado seria comido um pedaço por dia.
 *
 * Pelo mesmo motivo o passo 3 passou a SELECIONAR antes de escrever. Ele
 * reescrevia todas as atividades do contato incondicionalmente — inofensivo
 * numa requisição avulsa, e numa varredura diária seria escrita perpétua sobre
 * dado que já está certo, com a auditoria registrando "efeito" todo santo dia.
 */

/** O sufixo que marca uma lead já redigida. É ele que torna a retomada segura. */
export const SUFIXO_ANONIMIZADO = " (anonimizado)";

/** Quanto do título original sobrevive. O resto é PII em potencial. */
export const TITULO_PRESERVADO = 20;

/** O payload que substitui o conteúdo de uma atividade. */
export const PAYLOAD_REDIGIDO: Record<string, unknown> = { redacted: true };

export function jaRedigida(titulo: string | null): boolean {
  return (titulo ?? "").endsWith(SUFIXO_ANONIMIZADO);
}

export function tituloRedigido(titulo: string | null): string {
  return `${(titulo ?? "").slice(0, TITULO_PRESERVADO)}${SUFIXO_ANONIMIZADO}`;
}

/**
 * A superfície do PostgREST que esta cascata usa — nada além disso.
 *
 * Declarada em vez de importada do client gerado pelo mesmo motivo de `PodaDb`
 * em `app/api/v1/cron/data-retention/route.ts`: o teste injeta uma
 * implementação, e amarrar a assinatura aos genéricos do `SupabaseClient`
 * obrigaria o dublê a reimplementar o construtor de query inteiro para provar
 * três UPDATEs.
 */
export interface Filtravel<T> extends PromiseLike<T> {
  eq(coluna: string, valor: string | boolean): Filtravel<T>;
  in(coluna: string, valores: string[]): Filtravel<T>;
  limit(n: number): Filtravel<T>;
}

export interface ClienteDaCascata {
  from(tabela: string): {
    select(colunas: string): Filtravel<{ data: unknown; error: { message: string } | null }>;
    update(patch: Record<string, unknown>): Filtravel<{ error: { message: string } | null }>;
  };
}

export interface ResultadoDaRedacao {
  /** As leads cujo título foi redigido AGORA (não as que já estavam). */
  leadsRedigidas: string[];
  /** Quantas atividades foram redigidas AGORA. */
  atividadesRedigidas: number;
  /**
   * As tabelas que esta execução REALMENTE tocou.
   *
   * Existe porque a auditoria gravava `["contacts","crm_leads",
   * "crm_lead_activities"]` como literal — e numa retomada `contacts` não é
   * tocada, e os passos 2 e 3 são best-effort. A linha `lgpd.anonymize_catchup`
   * afirmava ter redigido as três mesmo quando não redigiu nenhuma. É a mesma
   * classe — sucesso declarado sobre trabalho não feito — que esta cascata já
   * pagou uma vez, quando deixava o arquivo no bucket e auditava que redigira.
   */
  tabelas: string[];
  /** O que falhou. Best-effort não é motivo para a falha sumir do registro. */
  falhas: string[];
}

/** Houve trabalho? É o que separa uma retomada de um "não faltava nada". */
export function houveRedacao(r: ResultadoDaRedacao): boolean {
  return r.leadsRedigidas.length > 0 || r.atividadesRedigidas > 0;
}

/**
 * Passos 2 e 3 da cascata, idempotentes, para UM contato já anonimizado (ou
 * sendo anonimizado agora).
 *
 * Best-effort de propósito, e a direção foi escolhida: derrubar a requisição
 * porque uma lead resistiu deixaria o CONTATO não anonimizado — o oposto do
 * defeito, e pior, porque `contacts` é onde mora o PII forte (nome, e-mail,
 * telefone, CPF). O que mudou é que agora existe retomada: o best-effort deixou
 * de ser "uma chance só".
 *
 * `organizationId` é filtrado À MÃO em toda query. Não é redundância com a RLS:
 * o cron chama isto com o client de service role, que a bypassa.
 */
export async function completarRedacaoDoContato(
  db: ClienteDaCascata,
  contato: { id: string; organizationId: string },
): Promise<ResultadoDaRedacao> {
  const leadsRedigidas: string[] = [];
  const falhas: string[] = [];
  const tabelas: string[] = [];

  // ── Passo 2 — leads do contato ──
  const { data: leadData, error: leadSelErr } = await db
    .from("crm_leads")
    .select("id, title")
    .eq("organization_id", contato.organizationId)
    .eq("contact_id", contato.id);
  if (leadSelErr) falhas.push(`crm_leads select: ${leadSelErr.message}`);

  const leads = (leadData ?? []) as { id: string; title: string | null }[];
  for (const row of leads) {
    if (jaRedigida(row.title)) continue;
    const { error } = await db
      .from("crm_leads")
      .update({ title: tituloRedigido(row.title) })
      .eq("organization_id", contato.organizationId)
      .eq("id", row.id);
    if (error) falhas.push(`crm_leads ${row.id}: ${error.message}`);
    else leadsRedigidas.push(row.id);
  }
  if (leadsRedigidas.length > 0) tabelas.push("crm_leads");

  // ── Passo 3 — atividades do contato ──
  //
  // Seleciona ANTES de escrever: ver o cabeçalho. Sem isto a varredura diária
  // reescreveria para sempre o que já está redigido, e a auditoria registraria
  // "efeito" em toda rodada — trocando o defeito por ruído perpétuo.
  const { data: atvData, error: atvSelErr } = await db
    .from("crm_lead_activities")
    .select("id, payload")
    .eq("organization_id", contato.organizationId)
    .eq("contact_id", contato.id);
  if (atvSelErr) falhas.push(`crm_lead_activities select: ${atvSelErr.message}`);

  const pendentes = ((atvData ?? []) as { id: string; payload: unknown }[])
    .filter((a) => (a.payload as { redacted?: unknown } | null)?.redacted !== true)
    .map((a) => a.id);

  let atividadesRedigidas = 0;
  if (pendentes.length > 0) {
    const { error } = await db
      .from("crm_lead_activities")
      .update({ payload: PAYLOAD_REDIGIDO })
      .eq("organization_id", contato.organizationId)
      .in("id", pendentes);
    if (error) falhas.push(`crm_lead_activities: ${error.message}`);
    else {
      atividadesRedigidas = pendentes.length;
      tabelas.push("crm_lead_activities");
    }
  }

  return { leadsRedigidas, atividadesRedigidas, tabelas, falhas };
}

/**
 * Quantos contatos anonimizados a rodada CHEGA A OLHAR. Alto de propósito: ele
 * limita a leitura, não o trabalho.
 *
 * ⚠ O teto do trabalho e o teto da leitura precisam ser NÚMEROS DIFERENTES, e a
 * primeira versão disto usava um só — o que produzia STARVATION silenciosa. Com
 * `limit(200)` e sem ordenação, toda rodada examina os MESMOS 200 primeiros
 * contatos: uma vez limpos, o cron roda para sempre sem nunca alcançar o
 * contato 201. Um resíduo fora dessa janela ficaria pendente indefinidamente —
 * num prazo legal, e com a trilha dizendo que a varredura correu bem todo dia.
 * É a mesma classe que este PR inteiro combate: sucesso declarado sobre
 * trabalho não feito.
 */
export const MAX_CONTATOS_EXAMINADOS = 5000;

/**
 * Quantos contatos a rodada CONSERTA. Este é o teto que protege o relógio do
 * cron, no espírito do `MAX_LOTES` da poda — e ele não causa starvation porque
 * contato consertado para de ter resíduo: a rodada seguinte alcança os próximos.
 */
export const MAX_CONTATOS_POR_VARREDURA = 200;

/**
 * Contatos por ida ao banco na DETECÇÃO. `.in()` vira lista na query string, e
 * 100 UUIDs já dão ~3,7 KB de URL — perto do que proxies costumam recusar.
 */
export const CONTATOS_POR_BLOCO = 100;

export interface ContatoCompletado {
  contactId: string;
  organizationId: string;
  resultado: ResultadoDaRedacao;
}

export interface ResultadoDaVarredura {
  /** Quantos contatos anonimizados foram EXAMINADOS. */
  examinados: number;
  /** Quantos deles tinham resíduo. */
  comResiduo: number;
  /** Só os que foram completados agora. */
  completados: ContatoCompletado[];
  /** Sobrou trabalho para a rodada seguinte (por teto de conserto ou de leitura). */
  temResto: boolean;
  falhas: string[];
}

/** Um contato tem resíduo se alguma lead ou atividade dele ainda não foi redigida. */
function idsComResiduo(
  leads: { contact_id: string | null; title: string | null }[],
  atividades: { contact_id: string | null; payload: unknown }[],
): Set<string> {
  const comResiduo = new Set<string>();
  for (const l of leads) {
    if (l.contact_id && !jaRedigida(l.title)) comResiduo.add(l.contact_id);
  }
  for (const a of atividades) {
    if (a.contact_id && (a.payload as { redacted?: unknown } | null)?.redacted !== true) {
      comResiduo.add(a.contact_id);
    }
  }
  return comResiduo;
}

/**
 * Varre contatos já anonimizados e completa a cascata de quem ficou pela
 * metade. É este o laço que torna a correção alcançável sem clique.
 *
 * Parte de `contacts.is_anonymized = true` — e não de "leads com resíduo" —
 * porque só o contato diz quem exerceu o direito. Buscar o resíduo direto
 * exigiria um join embutido do PostgREST que nenhum teste local exercita.
 *
 * A DETECÇÃO é em bloco (duas consultas por `CONTATOS_POR_BLOCO` contatos), e
 * não uma por contato: no estado normal — nada a consertar, que é o de toda
 * instalação saudável — a rodada inteira custa dezenas de consultas em vez de
 * duas por contato anonimizado, todo dia, para sempre.
 *
 * A detecção NÃO filtra organização, e a escrita filtra. É deliberado: aqui ela
 * só decide QUAIS contatos visitar, e uma linha de outra org com o mesmo
 * `contact_id` (que só existe se algo já vazou) causaria no máximo uma visita
 * inútil. Quem escreve é `completarRedacaoDoContato`, que filtra a org da linha
 * de `contacts` — a fonte confiável.
 */
export async function varrerRedacoesIncompletas(
  db: ClienteDaCascata,
  teto: number = MAX_CONTATOS_POR_VARREDURA,
): Promise<ResultadoDaVarredura> {
  const vazio = (falhas: string[]): ResultadoDaVarredura => ({
    examinados: 0,
    comResiduo: 0,
    completados: [],
    temResto: false,
    falhas,
  });

  const { data, error } = await db
    .from("contacts")
    .select("id, organization_id")
    .eq("is_anonymized", true)
    .limit(MAX_CONTATOS_EXAMINADOS);
  if (error) return vazio([`contacts: ${error.message}`]);

  const contatos = (data ?? []) as { id: string; organization_id: string }[];
  const orgDe = new Map(contatos.map((c) => [c.id, c.organization_id]));
  const falhas: string[] = [];
  const pendentes: string[] = [];

  for (let i = 0; i < contatos.length; i += CONTATOS_POR_BLOCO) {
    const bloco = contatos.slice(i, i + CONTATOS_POR_BLOCO).map((c) => c.id);

    const { data: leads, error: leadErr } = await db
      .from("crm_leads")
      .select("contact_id, title")
      .in("contact_id", bloco);
    if (leadErr) falhas.push(`crm_leads varredura: ${leadErr.message}`);

    const { data: atvs, error: atvErr } = await db
      .from("crm_lead_activities")
      .select("contact_id, payload")
      .in("contact_id", bloco);
    if (atvErr) falhas.push(`crm_lead_activities varredura: ${atvErr.message}`);

    const achados = idsComResiduo(
      (leads ?? []) as { contact_id: string | null; title: string | null }[],
      (atvs ?? []) as { contact_id: string | null; payload: unknown }[],
    );
    // A detecção não filtra org (ver o cabeçalho): um `contact_id` que não
    // saiu da lista de contatos anonimizados não vira visita.
    for (const id of achados) if (orgDe.has(id)) pendentes.push(id);
  }

  const completados: ContatoCompletado[] = [];
  for (const id of pendentes.slice(0, teto)) {
    const resultado = await completarRedacaoDoContato(db, {
      id,
      organizationId: orgDe.get(id) as string,
    });
    falhas.push(...resultado.falhas);
    if (houveRedacao(resultado)) {
      completados.push({ contactId: id, organizationId: orgDe.get(id) as string, resultado });
    }
  }

  return {
    examinados: contatos.length,
    comResiduo: pendentes.length,
    completados,
    temResto: pendentes.length > teto || contatos.length >= MAX_CONTATOS_EXAMINADOS,
    falhas,
  };
}
