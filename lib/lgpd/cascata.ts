/**
 * A CASCATA DE ANONIMIZAÇÃO — os passos 2 a 4, num lugar só (issues #310 e #701).
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

/**
 * Os status em que a régua de recuperação ainda CORRE — e portanto ainda pode
 * mandar mensagem ou abrir aviso.
 *
 * São os mesmos que o cancelamento por compromisso desfeito usa em SQL
 * (`fn_appointment_change`) e que o índice de claim filtra. Divergir daqui é
 * deixar régua viva para trás: `completed`, `cancelled` e `dead` são terminais,
 * e é a ausência deles nesta lista que torna o passo idempotente.
 */
export const STATUS_DA_REGUA_VIVA = [
  "active",
  "waiting_reply",
  // Dorme, mas corre: tem hora marcada para voltar a falar. Deixá-lo de fora
  // faria o expurgo passar ao largo de uma régua que acorda meses depois.
  "dormente",
  "paused_handoff",
  "paused_manual",
] as const;

/**
 * O motivo gravado em `cancel_reason` — curto, sem PII, e greppável na
 * auditoria, no mesmo vocabulário de `nono_digito_merge`.
 */
export const MOTIVO_CANCELAMENTO_POR_LGPD = "Contato anonimizado (LGPD)";

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
  not(coluna: string, operador: "is", valor: null): Filtravel<T>;
  limit(n: number): Filtravel<T>;
}

export interface ClienteDaCascata {
  from(tabela: string): {
    select(colunas: string): Filtravel<{ data: unknown; error: { message: string } | null }>;
    update(patch: Record<string, unknown>): Filtravel<{ error: { message: string } | null }>;
  };
}

/** O texto-sentinela que marca uma nota de memória do agente JÁ redigida. */
export const NOTA_REDIGIDA = "(anonimizado)";

/**
 * O body que a anonimização do BANCO grava em toda mensagem redigida
 * (`fn_redigir_conversas_ao_anonimizar` e `fn_lgpd_cascade_redact_contact`).
 * Só ela o escreve — por isso ele é o marcador de "esta mensagem já passou pela
 * anonimização", e poupa quem voltou a escrever depois (mensagem nova tem body
 * de verdade).
 */
export const MENSAGEM_REDIGIDA = "[mensagem anonimizada]";

/**
 * Redação do `tool_calls` de uma run (issue #1957). Cada passo vira
 * `{ step?, tool_name?, redacted: true, tool_calls: [{ tool_name }] }`: fica
 * QUAIS ferramentas rodaram e em que passo — a trilha do que o agente fez —, e
 * sai o texto do modelo, os argumentos e os resultados, que é onde mora o nome
 * e o que a pessoa escreveu (forma em `lib/ai/runtime/serialize.ts`).
 *
 * Idempotência: o marcador de "já redigida" é `redacted: true` em TODO passo.
 * Não dá para usar o vácuo: o `tool_calls` de uma run que nunca chamou
 * ferramenta é `[]` de nascença (`not null default '[]'`), e reescrevê-lo seria
 * perpétuo e vazio — `[]` não tem passo pendente e nunca é tocado.
 */
export function redigirToolCalls(toolCalls: unknown): unknown[] {
  const passos = Array.isArray(toolCalls) ? (toolCalls as unknown[]) : [];
  return passos.map((p) => {
    const passo = (p ?? {}) as { step?: unknown; tool_name?: unknown; tool_calls?: unknown };
    const chamadas = Array.isArray(passo.tool_calls) ? (passo.tool_calls as unknown[]) : [];
    return {
      ...(typeof passo.step === "number" ? { step: passo.step } : {}),
      ...(typeof passo.tool_name === "string" ? { tool_name: passo.tool_name } : {}),
      redacted: true,
      tool_calls: chamadas.map((c) => {
        const nome = (c as { tool_name?: unknown } | null)?.tool_name;
        return { tool_name: typeof nome === "string" ? nome : "unknown" };
      }),
    };
  });
}

/** A run ainda tem passo não redigido? `[]` de nascença não tem. */
export function toolCallsPendentes(toolCalls: unknown): boolean {
  return (
    Array.isArray(toolCalls) &&
    toolCalls.some((p) => (p as { redacted?: unknown } | null)?.redacted !== true)
  );
}

export interface ResultadoDaRedacao {
  /** As leads cujo título foi redigido AGORA (não as que já estavam). */
  leadsRedigidas: string[];
  /** Quantas atividades foram redigidas AGORA. */
  atividadesRedigidas: number;
  /** Quantas notas de memória (lead_notes) foram redigidas AGORA (#1957). */
  memoriasRedigidas: number;
  /** Quantas runs de IA tiveram os argumentos de ferramentas redigidos AGORA (#1957). */
  runsRedigidas: number;
  /** Quantas linhas de lead_state tiveram next_action/qualification redigidas AGORA (#1957). */
  estadosRedigidos: number;
  /** Se o social_identity do contato foi removido AGORA (#1957). */
  socialIdentidadeRedigida: boolean;
  /** Quantas mensagens já anonimizadas tiveram a transcrição da mídia apagada AGORA (0497). */
  transcricoesRedigidas: number;
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
  return (
    r.leadsRedigidas.length > 0 ||
    r.atividadesRedigidas > 0 ||
    r.memoriasRedigidas > 0 ||
    r.runsRedigidas > 0 ||
    r.estadosRedigidos > 0 ||
    r.socialIdentidadeRedigida ||
    r.transcricoesRedigidas > 0
  );
}

/**
 * Passos 2 a 4 da cascata, idempotentes, para UM contato já anonimizado (ou
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

  // ── Passo 4 — a RÉGUA DE RECUPERAÇÃO do contato (issue #701) ──
  //
  // A cascata redigia contatos, leads e atividades — e deixava a régua de
  // recuperação CORRENDO. Medido na issue, com controle positivo:
  // `git grep -l "followup" lib/lgpd/` voltava vazio.
  //
  // A consequência não é cosmética: a régua esgota DEPOIS da redação e o
  // adaptador de `abrirAvisoRecuperacaoEsgotada` abre um aviso novo apontando
  // para o compromisso que a anonimização tinha desligado. O aviso ressuscita o
  // vínculo que a LGPD mandou cortar — e, antes dele, as mensagens da própria
  // régua chegam a quem pediu para ser esquecido.
  //
  // Mora AQUI, e não na RPC `fn_lgpd_cascade_redact_contact`, porque este
  // arquivo é a unidade que as DUAS bocas compartilham (a rota e o cron) — ver o
  // cabeçalho. Cancelar só na RPC deixaria a RETOMADA (`lgpd.anonymize_catchup`,
  // que não passa pela RPC de cascata) sem cancelamento, e é justamente por ela
  // que o contato anonimizado antes desta issue é alcançado.
  //
  // SELECT antes do UPDATE, como no passo anterior e pelo mesmo motivo: em
  // regime a régua já está cancelada, e escrever de novo seria gravar sobre dado
  // certo em toda rodada diária, com a auditoria registrando efeito que não
  // houve. É a mesma cadeia que torna o passo idempotente — `cancelled` não está
  // em `STATUS_DA_REGUA_VIVA`, então a segunda passada não encontra linha.
  const { data: reguaData, error: reguaSelErr } = await db
    .from("followup_enrollments")
    .select("id")
    .eq("organization_id", contato.organizationId)
    .eq("contact_id", contato.id)
    .in("status", [...STATUS_DA_REGUA_VIVA]);
  if (reguaSelErr) falhas.push(`followup_enrollments select: ${reguaSelErr.message}`);

  const reguasVivas = ((reguaData ?? []) as { id: string }[]).map((r) => r.id);
  if (reguasVivas.length > 0) {
    const { error } = await db
      .from("followup_enrollments")
      .update({
        status: "cancelled",
        cancel_reason: MOTIVO_CANCELAMENTO_POR_LGPD,
        completed_at: new Date().toISOString(),
        // Soltar o relógio e o lease é parte do cancelamento: sem isto a linha
        // cancelada continua com cara de reivindicável para o claim do worker.
        next_eval_at: null,
        claimed_until: null,
      })
      .eq("organization_id", contato.organizationId)
      .in("id", reguasVivas);
    if (error) falhas.push(`followup_enrollments: ${error.message}`);
    // `tabelas` é o que a auditoria grava como tocado de verdade: numa retomada,
    // esta linha é a diferença entre "não faltava nada" e "a régua foi cortada".
    else tabelas.push("followup_enrollments");
  }

  // ── Passo 5 — MEMÓRIA DO AGENTE (`lead_notes`) — issue #1957 ──
  //
  // A cascata redigia o que o humano vê (conversas, leads, atividades) e a
  // régua — mas NÃO a memória que a IA grava sobre o contato. Medido na issue:
  // `lead_notes` guarda `headline` + `body` com nome e trechos do que a pessoa
  // escreveu, e `completarRedacaoDoContato` não passava por ele. Quem pediu
  // anonimização pela LGPD espera que o dado saia de todo lugar onde o sistema
  // o guardou — a memória da IA guarda dado pessoal, então é parte do expurgo.
  //
  // SELECT antes do UPDATE, como no passo 3 e pelo mesmo motivo: em regime as
  // notas já estão redigidas, e reescrever seria gravar sobre dado certo em
  // O marcador de "já redigida" é o próprio `NOTA_REDIGIDA`
  // — a segunda passada não encontra linha com headline/body original.
  let memoriasRedigidas = 0;
  const { data: notaData, error: notaSelErr } = await db
    .from("lead_notes")
    .select("id, headline, body")
    .eq("organization_id", contato.organizationId)
    .eq("contact_id", contato.id);
  if (notaSelErr) falhas.push(`lead_notes select: ${notaSelErr.message}`);

  const notasPendentes = ((notaData ?? []) as { id: string; headline: string; body: string }[]).filter(
    (n) => n.headline !== NOTA_REDIGIDA || n.body !== NOTA_REDIGIDA,
  );
  for (const nota of notasPendentes) {
    const { error } = await db
      .from("lead_notes")
      .update({ headline: NOTA_REDIGIDA, body: NOTA_REDIGIDA, embedding: null })
      .eq("organization_id", contato.organizationId)
      .eq("id", nota.id);
    if (error) falhas.push(`lead_notes ${nota.id}: ${error.message}`);
    else memoriasRedigidas += 1;
  }
  if (memoriasRedigidas > 0) tabelas.push("lead_notes");

  // ── Passo 6 — REGISTRO DE EXECUÇÃO DA IA (`ai_agent_runs.tool_calls`) ──
  //
  // Issue #1957. `tool_calls` (jsonb) guarda os argumentos passados às
  // ferramentas — nome do contato e trechos do que a pessoa escreveu — e
  // nenhuma etapa da cascata passava por ele. Cada run do contato é redigida
  // por `redigirToolCalls`, que guarda o nome das ferramentas e apaga o resto.
  //
  // Idempotência: ver o cabeçalho de `redigirToolCalls`. O `[]` de nascença e a
  // run já redigida não são tocados. Um UPDATE por run, porque o conteúdo
  // redigido é por run (os nomes das ferramentas diferem).
  let runsRedigidas = 0;
  const { data: runData, error: runSelErr } = await db
    .from("ai_agent_runs")
    .select("id, tool_calls")
    .eq("organization_id", contato.organizationId)
    .eq("contact_id", contato.id);
  if (runSelErr) falhas.push(`ai_agent_runs select: ${runSelErr.message}`);

  const runs = ((runData ?? []) as { id: string; tool_calls: unknown }[]).filter((run) =>
    toolCallsPendentes(run.tool_calls),
  );
  for (const run of runs) {
    const { error } = await db
      .from("ai_agent_runs")
      .update({ tool_calls: redigirToolCalls(run.tool_calls) })
      .eq("organization_id", contato.organizationId)
      .eq("id", run.id);
    if (error) falhas.push(`ai_agent_runs ${run.id}: ${error.message}`);
    else runsRedigidas += 1;
  }
  if (runsRedigidas > 0) tabelas.push("ai_agent_runs");

  // ── Passo 7 — ESTADO DA LEAD (`lead_state.next_action` / `qualification`) ──
  //
  // Issue #1957. `next_action` (texto) e `qualification` (jsonb) são texto
  // livre que pode citar o contato. Vão para a cascata com marcador vazio:
  // `next_action = null` e `qualification = '{}'`.
  //
  // SELECT antes do UPDATE: em regime o estado já está vazio, e escrever de
  // novo seria gravar sobre dado certo em toda rodada — o mesmo padrão dos
  // passos 3, 4 e 5.
  let estadosRedigidos = 0;
  const { data: estadoData, error: estadoSelErr } = await db
    .from("lead_state")
    .select("id, next_action, qualification")
    .eq("organization_id", contato.organizationId)
    .eq("contact_id", contato.id);
  if (estadoSelErr) falhas.push(`lead_state select: ${estadoSelErr.message}`);

  const estados = ((estadoData ?? []) as { id: string; next_action: string | null; qualification: unknown }[]).filter(
    (e) => e.next_action !== null || JSON.stringify(e.qualification) !== "{}",
  );
  if (estados.length > 0) {
    const { error } = await db
      .from("lead_state")
      .update({ next_action: null, qualification: {} })
      .eq("organization_id", contato.organizationId)
      .in("id", estados.map((e) => e.id));
    if (error) falhas.push(`lead_state: ${error.message}`);
    else {
      estadosRedigidos = estados.length;
      tabelas.push("lead_state");
    }
  }

  // ── Passo 8 — IDENTIDADE SOCIAL (`contacts.social_identity`) — issue #1957 ──
  //
  // A RPC `fn_lgpd_cascade_redact_contact` zera o PII forte do contato (nome,
  // e-mail, telefone, CPF) mas NÃO toca `social_identity` (jsonb com o perfil
  // social). Quem pediu anonimização não quer a identidade social sobrando.
  // Mora aqui, e não na RPC, pelo mesmo motivo da régua (passo 4): este arquivo
  // é a unidade que as duas bocas (rota e cron) compartilham e a retomada não
  // passa pela RPC de cascata.
  let socialIdentidadeRedigida = false;
  const { data: contatoRow, error: socialSelErr } = await db
    .from("contacts")
    .select("id, social_identity")
    .eq("organization_id", contato.organizationId)
    .eq("id", contato.id);
  if (socialSelErr) falhas.push(`contacts social_identity select: ${socialSelErr.message}`);

  const comSocial = ((contatoRow ?? []) as { id: string; social_identity: unknown }[]).find(
    (c) => c.social_identity !== null && c.social_identity !== undefined,
  );
  if (comSocial) {
    const { error } = await db
      .from("contacts")
      .update({ social_identity: null })
      .eq("organization_id", contato.organizationId)
      .eq("id", comSocial.id);
    if (error) falhas.push(`contacts social_identity: ${error.message}`);
    else {
      socialIdentidadeRedigida = true;
      tabelas.push("contacts:social_identity");
    }
  }

  // ── Passo 9 — TRANSCRIÇÃO DA MÍDIA (`messages.media_derived_text`) — 0497 ──
  //
  // Achado na triagem do #1988. O banco redige o body da mensagem na virada de
  // is_anonymized, e até a 0497 deixava a transcrição do áudio (e o OCR da
  // imagem) legível. A migration fecha o gatilho e cura o passado; este passo
  // fecha a janela que nenhum gatilho alcança: o `media-derive-worker` que leu
  // a mídia ANTES da anonimização e grava o texto DEPOIS dela.
  //
  // Só mensagem com body `MENSAGEM_REDIGIDA`: é a que o banco já anonimizou.
  // Mensagem com body de verdade é de quem voltou a escrever, e fica. O UPDATE
  // repete o predicado em vez de uma lista de ids — um contato pode ter
  // centenas de áudios, e `.in()` vira URL (ver `CONTATOS_POR_BLOCO`).
  let transcricoesRedigidas = 0;
  const { data: transcData, error: transcSelErr } = await db
    .from("messages")
    .select("id")
    .eq("organization_id", contato.organizationId)
    .eq("contact_id", contato.id)
    .eq("body", MENSAGEM_REDIGIDA)
    .not("media_derived_text", "is", null);
  if (transcSelErr) falhas.push(`messages media_derived_text select: ${transcSelErr.message}`);

  const comTranscricao = ((transcData ?? []) as { id: string }[]).length;
  if (comTranscricao > 0) {
    const { error } = await db
      .from("messages")
      .update({ media_derived_text: null })
      .eq("organization_id", contato.organizationId)
      .eq("contact_id", contato.id)
      .eq("body", MENSAGEM_REDIGIDA)
      .not("media_derived_text", "is", null);
    if (error) falhas.push(`messages media_derived_text: ${error.message}`);
    else {
      transcricoesRedigidas = comTranscricao;
      tabelas.push("messages:media_derived_text");
    }
  }

  return {
    leadsRedigidas,
    atividadesRedigidas,
    memoriasRedigidas,
    runsRedigidas,
    estadosRedigidos,
    socialIdentidadeRedigida,
    transcricoesRedigidas,
    tabelas,
    falhas,
  };
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

/** Um contato tem resíduo se alguma lead, atividade, memória, run, estado, identidade social ou transcrição dele ainda não foi redigida. */
function idsComResiduo(argumentos: {
  leads: { contact_id: string | null; title: string | null }[];
  atividades: { contact_id: string | null; payload: unknown }[];
  notas: { contact_id: string | null; headline: string; body: string }[];
  runs: { contact_id: string | null; tool_calls: unknown }[];
  estados: { contact_id: string | null; next_action: string | null; qualification: unknown }[];
  sociais: { id: string; social_identity: unknown }[];
  /** Já filtradas no banco: mensagem anonimizada que ainda guarda transcrição. */
  transcricoes: { contact_id: string | null }[];
}): Set<string> {
  const { leads, atividades, notas, runs, estados, sociais, transcricoes } = argumentos;
  const comResiduo = new Set<string>();
  for (const l of leads) {
    if (l.contact_id && !jaRedigida(l.title)) comResiduo.add(l.contact_id);
  }
  for (const a of atividades) {
    if (a.contact_id && (a.payload as { redacted?: unknown } | null)?.redacted !== true) {
      comResiduo.add(a.contact_id);
    }
  }
  for (const n of notas) {
    if (n.contact_id && (n.headline !== NOTA_REDIGIDA || n.body !== NOTA_REDIGIDA)) {
      comResiduo.add(n.contact_id);
    }
  }
  for (const r of runs) {
    if (r.contact_id && toolCallsPendentes(r.tool_calls)) comResiduo.add(r.contact_id);
  }
  for (const e of estados) {
    if (e.contact_id && (e.next_action !== null || JSON.stringify(e.qualification) !== "{}")) {
      comResiduo.add(e.contact_id);
    }
  }
  for (const s of sociais) {
    if (s.social_identity !== null && s.social_identity !== undefined) comResiduo.add(s.id);
  }
  for (const m of transcricoes) {
    if (m.contact_id) comResiduo.add(m.contact_id);
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

    const { data: notas, error: notaErr } = await db
      .from("lead_notes")
      .select("contact_id, headline, body")
      .in("contact_id", bloco);
    if (notaErr) falhas.push(`lead_notes varredura: ${notaErr.message}`);

    const { data: runs, error: runErr } = await db
      .from("ai_agent_runs")
      .select("contact_id, tool_calls")
      .in("contact_id", bloco);
    if (runErr) falhas.push(`ai_agent_runs varredura: ${runErr.message}`);

    const { data: estados, error: estadoErr } = await db
      .from("lead_state")
      .select("contact_id, next_action, qualification")
      .in("contact_id", bloco);
    if (estadoErr) falhas.push(`lead_state varredura: ${estadoErr.message}`);

    // A identidade social vive NO contato (não numa tabela vizinha), então entra
    // no bloco como um IN sobre os ids já examinados. A detecção em bloco não
    // filtra org de propósito (ver o cabeçalho de `varrerRedacoesIncompletas`);
    // quem decide org é a escrita, filtrando pela linha de `contacts`.
    const { data: sociais, error: socialErr } = await db
      .from("contacts")
      .select("id, social_identity")
      .in("id", bloco);
    if (socialErr) falhas.push(`contacts social_identity varredura: ${socialErr.message}`);

    // Filtrado no BANCO, ao contrário das consultas acima: um contato tem
    // milhares de mensagens, e trazer todas para decidir em memória custaria a
    // rodada saudável inteira. Em regime a resposta é vazia.
    const { data: transcricoes, error: transcErr } = await db
      .from("messages")
      .select("contact_id")
      .in("contact_id", bloco)
      .eq("body", MENSAGEM_REDIGIDA)
      .not("media_derived_text", "is", null);
    if (transcErr) falhas.push(`messages media_derived_text varredura: ${transcErr.message}`);

    const achados = idsComResiduo({
      leads: (leads ?? []) as { contact_id: string | null; title: string | null }[],
      atividades: (atvs ?? []) as { contact_id: string | null; payload: unknown }[],
      notas: (notas ?? []) as { contact_id: string | null; headline: string; body: string }[],
      runs: (runs ?? []) as { contact_id: string | null; tool_calls: unknown }[],
      estados: (estados ?? []) as {
        contact_id: string | null;
        next_action: string | null;
        qualification: unknown;
      }[],
      sociais: (sociais ?? []) as { id: string; social_identity: unknown }[],
      transcricoes: (transcricoes ?? []) as { contact_id: string | null }[],
    });
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
