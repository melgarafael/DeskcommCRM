/**
 * Roteiro da avaliação LOCAL da parada do laço depois do envio final declarado
 * (knob AGENT_STOP_AFTER_FINAL_SEND). Procedimento, preparo de cada cenário e
 * critérios: docs/runbooks/parada-apos-envio.md.
 *
 *   plano      — imprime as execuções de um lote (sem rede, sem banco)
 *   preparar   — publica o agente da avaliação com o modelo e o preparo de UM
 *                cenário, e deixa o canal pronto (sessão WORKING, sem warm-up,
 *                janela de resposta 24h, sem o veto de cópia repetida)
 *   executar   — roda o lote pelo caminho de produção (webhook → worker), uma
 *                execução por vez, cada uma num contato novo. GASTA TOKENS REAIS.
 *                Com --modelo, roda o `preparar` antes de cada cenário. Depois de
 *                cada execução cancela os retornos que o turno agendou (S2).
 *   relatorio  — lê agent_turn_traces do banco LOCAL e imprime o veredito
 *   custo      — custo por execução (soma de llm_calls.cost_cents do contato)
 *
 * Uso:
 *   pnpm exec tsx --env-file=.env.local scripts/avaliar-parada-apos-envio.ts plano \
 *     --lote 1 --braco observe --k 20 [--cenarios S0,S1-casos-off]
 *   pnpm exec tsx --env-file=.env.local scripts/avaliar-parada-apos-envio.ts preparar \
 *     --modelo openai:gpt-5.6-luna --cenario S1-casos-off [--session <waha_session_name>]
 *   pnpm exec tsx --env-file=.env.local scripts/avaliar-parada-apos-envio.ts executar \
 *     --lote 1 --braco observe --k 20 --cenarios S0 --teto-usd 2 [--modelo provedor:modelo] [--de 1] \
 *     [--session <waha_session_name>] [--app-url <url>]
 *   pnpm exec tsx --env-file=.env.local scripts/avaliar-parada-apos-envio.ts relatorio \
 *     --desde 2026-11-01T00:00:00Z [--lotes 1,2] [--minimo 80] [--tolerancia 0.1]
 *   pnpm exec tsx --env-file=.env.local scripts/avaliar-parada-apos-envio.ts custo \
 *     --desde 2026-11-01T00:00:00Z [--lotes 1,2]
 *
 * `--modelo provedor:modelo` publica no provedor direto (credencial da
 * organização cadastrada na tela); sem `:` é o id da OpenRouter. O `executar`
 * soma `llm_calls.cost_cents` do lote antes de cada execução e para no teto — e
 * para com erro se alguma chamada tem tokens e não tem custo.
 *
 * Só fala com destino LOCAL: o `.env.local` de um checkout de trabalho aponta
 * para produção, e esta avaliação nunca roda lá. O canal é o receptor HTTP local
 * do runbook, nunca um WAHA pareado, e os telefones têm DDD que não existe.
 */
import { spawnSync } from "node:child_process";

import pg from "pg";

import { capacidadesPadraoDoOnboarding } from "@/lib/ai/agents/capacidades-padrao";

import { credenciaisSupabaseDeTeste, destinoEhLocal } from "./lib/env-de-teste";
import {
  agrupar,
  CENARIOS,
  conferirTeto,
  CRITERIOS_PADRAO,
  execucaoDoTelefone,
  modeloDoLote,
  pct,
  telefoneDaExecucao,
  vereditoDoModelo,
  type Braco,
  type Cenario,
  type TurnoMedido,
} from "./lib/avaliacao-parada-apos-envio";
import { cancelarRetornosDoLote, gastoDoLote, NOME_DO_AGENTE } from "./lib/avaliacao-parada-apos-envio-pg";

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function escrever(linha: string): void {
  process.stdout.write(`${linha}\n`);
}

function cenariosPedidos(): Cenario[] {
  const pedidos = arg("cenarios")?.split(",").map((s) => s.trim());
  if (pedidos === undefined) return [...CENARIOS];
  const achados = CENARIOS.filter((c) => pedidos.includes(c.id));
  const faltam = pedidos.filter((p) => !CENARIOS.some((c) => c.id === p));
  if (faltam.length > 0) throw new Error(`cenário desconhecido: ${faltam.join(", ")}`);
  return achados;
}

function lote(): { lote: number; braco: Braco; k: number; cenarios: Cenario[] } {
  const braco = arg("braco");
  if (braco !== "off" && braco !== "observe") throw new Error("--braco off|observe");
  return { lote: Number(arg("lote") ?? "1"), braco, k: Number(arg("k") ?? "20"), cenarios: cenariosPedidos() };
}

/**
 * `--de N` retoma um lote interrompido na execução N. Sem ele, rodar o mesmo
 * lote de novo volta à execução 1 e manda a 2ª mensagem a um contato que já
 * tem conversa: o turno deixa de ser o de um cliente novo.
 */
function execucoes(): Array<{ cenario: Cenario; telefone: string }> {
  const l = lote();
  const de = Number(arg("de") ?? "1");
  if (!Number.isInteger(de) || de < 1 || de > l.k) throw new Error(`--de fora de 1..${l.k}`);
  return l.cenarios.flatMap((cenario) =>
    Array.from({ length: l.k - de + 1 }, (_, i) => ({
      cenario,
      telefone: telefoneDaExecucao(l.lote, cenario, l.braco, de + i),
    })),
  );
}

/**
 * `comCanal` (o `executar`) confere também o WAHA que o worker usa: a avaliação
 * desliga a proteção anti-banimento do número, e o canal tem de ser o receptor
 * HTTP local do runbook, nunca um WAHA remoto. Local não basta (um WAHA local
 * pode estar pareado): é por isso que os telefones têm DDD que não existe.
 */
function exigirDestinoLocal(comCanal = false): { dbUrl: string; appUrl: string } {
  const c = credenciaisSupabaseDeTeste();
  const appUrl = arg("app-url") ?? c.appUrl;
  const alvos: Array<readonly [string, string]> = [["Supabase", c.url], ["Postgres", c.dbUrl], ["app", appUrl]];
  if (comCanal) alvos.push(["WAHA_API_BASE_URL", process.env.WAHA_API_BASE_URL ?? ""]);
  for (const [nome, alvo] of alvos) {
    if (alvo === "" || !destinoEhLocal(alvo)) {
      throw new Error(`${nome} não é local (${alvo === "" ? "vazio" : "remoto"}) — a avaliação só roda no ambiente fresco local`);
    }
  }
  return { dbUrl: c.dbUrl, appUrl };
}

/**
 * O agente da avaliação: um negócio que tem resposta para os oito cenários
 * (horário, cobrança, retorno, plano anual, orçamento, preço e pagamento) sem
 * nomear ferramenta nenhuma — quem escolhe a ação é o modelo, como em produção.
 */
const PROMPT_DO_AGENTE = `Você é a Bia, atendente da Fluent Hub, escola de inglês online para adultos, no WhatsApp.

Sobre a escola:
- Aulas ao vivo em turmas de até 6 alunos, por videochamada, com professores certificados, e uma plataforma com exercícios e correção de pronúncia.
- Atendimento: segunda a sexta, das 8h às 20h; sábado, das 9h às 13h. Domingos e feriados sem atendimento da equipe.
- Planos: Mensal R$ 390 por mês, sem fidelidade; Semestral R$ 2.040 (6x de R$ 340); Anual R$ 3.720 (12x de R$ 310). Planos para empresas sob consulta.
- Pagamento: cartão de crédito (até 12x sem juros no anual), Pix com 5% de desconto à vista, ou boleto.
- Aula experimental gratuita de 30 minutos.

Como atender:
- Responda em português, com frases curtas, tom cordial e direto.
- Não invente informação que não está aqui.
- Cobrança, estorno, cancelamento e problema de pagamento quem resolve é a equipe financeira: você não resolve sozinha nem promete prazo que não pode cumprir.
- Se o cliente pedir para ser chamado depois, combine o horário.
- Deixe registrado para a equipe comercial o que for importante: orçamento, prazo de decisão, interesse em plano.`;

/**
 * Deixa o número e o agente como o cenário pede, pelo banco LOCAL.
 *
 * O canal sai do caminho da medição, e só dele: sessão WORKING (senão o envio
 * volta `aceita_aguardando_canal` e o job é REAGENDADO, um 2º turno pago), sem
 * teto de warm-up nem diário, janela de resposta 24h (a avaliação roda de
 * madrugada) e o veto de cópia repetida desligado — ele compara as últimas 20
 * saídas do NÚMERO entre contatos, e 20 execuções da mesma pergunta dariam
 * respostas parecidas que nenhum cliente real produz; vetado, o envio volta ao
 * modelo e muda o turno que se quer medir. Os atrasos humanos e o intervalo
 * entre mensagens ficam no padrão.
 */
async function preparar(pool: pg.Pool, modeloDoArg: string, cenario: Cenario, sessao: string): Promise<void> {
  const { provedor, modelo } = modeloDoLote(modeloDoArg);
  const { rows: achada } = await pool.query<{ id: string; organization_id: string }>(
    `select id, organization_id from channel_sessions where waha_session_name = $1`,
    [sessao],
  );
  let org: string;
  let sessaoId: string;
  if (achada[0] !== undefined) {
    org = achada[0].organization_id;
    sessaoId = achada[0].id;
  } else {
    const { rows: orgs } = await pool.query<{ id: string }>(`select id from organizations`);
    if (orgs.length !== 1) {
      throw new Error(`${orgs.length} organizações e nenhuma sessão '${sessao}': crie a sessão na organização certa antes`);
    }
    org = orgs[0]!.id;
    const { rows } = await pool.query<{ id: string }>(
      `insert into channel_sessions (organization_id, waha_session_name, display_name, status, webhook_secret_encrypted)
       values ($1, $2, 'Avaliação da parada', 'WORKING', '\\x00') returning id`,
      [org, sessao],
    );
    sessaoId = rows[0]!.id;
  }
  await pool.query(`update channel_sessions set status = 'WORKING', daily_message_limit = 100000 where id = $1`, [sessaoId]);
  await pool.query(
    `insert into channel_knobs (organization_id, channel_session_id, resposta_start_hour, resposta_end_hour,
                                warmup_daily_caps, spinning_knobs, number_activated_at)
     values ($1, $2, 0, 24, '[{"minAgeDays":0,"cap":null}]', '{"repetitionThreshold":1000000}', now() - interval '60 days')
     on conflict (organization_id, channel_session_id) do update
       set resposta_start_hour = 0, resposta_end_hour = 24, warmup_daily_caps = excluded.warmup_daily_caps,
           spinning_knobs = excluded.spinning_knobs, number_activated_at = excluded.number_activated_at, updated_at = now()`,
    [org, sessaoId],
  );
  // Os pontos auxiliares do turno (checkpoint, classificadores) seguem o provedor da org.
  await pool.query(
    `update organizations
        set settings = jsonb_set(coalesce(settings, '{}'), '{llm}',
              coalesce(settings->'llm', '{}') || jsonb_build_object('provider', $3::text, 'default_model', $2::text))
      where id = $1`,
    [org, modelo, provedor],
  );
  const { rows: agentes } = await pool.query<{ id: string }>(
    `select id from ai_agents where organization_id = $1 and name = $2 and archived_at is null`,
    [org, NOME_DO_AGENTE],
  );
  const agenteId =
    agentes[0]?.id ??
    (
      await pool.query<{ id: string }>(
        `insert into ai_agents (organization_id, name, system_prompt, kind, model) values ($1, $2, $3, 'mcp_agent', $4) returning id`,
        [org, NOME_DO_AGENTE, PROMPT_DO_AGENTE, modelo],
      )
    ).rows[0]!.id;
  await pool.query(
    `update ai_agent_versions set status = 'superseded', superseded_at = now() where agent_id = $1 and status = 'published'`,
    [agenteId],
  );
  // As ferramentas são as que o onboarding liga no primeiro agente (o pacote
  // `vender`, `first-publication.ts`), mais as do cenário. As demais chaves vêm do
  // `versao` tipado de CENARIOS, nunca de entrada externa; o que o cenário não
  // ajusta fica no default da coluna, que é o da tela.
  const { tool_ids: extras = [], ...colunas } = cenario.versao;
  const ferramentas = [...new Set([...capacidadesPadraoDoOnboarding(), ...extras])];
  const ajuste = Object.entries(colunas);
  const { rows: versao } = await pool.query<{ id: string }>(
    `insert into ai_agent_versions (organization_id, agent_id, version_number, system_prompt, provider, model,
                                    channel_session_id, status, published_at, tool_ids${ajuste.map(([k]) => `, ${k}`).join("")})
     select $1, $2, coalesce(max(version_number), 0) + 1, $3, $7, $4, $5, 'published', now(), $6${ajuste
       .map((_, i) => `, $${i + 8}`)
       .join("")}
       from ai_agent_versions where agent_id = $2
     returning id`,
    [org, agenteId, PROMPT_DO_AGENTE, modelo, sessaoId, ferramentas, provedor, ...ajuste.map(([, v]) => v)],
  );
  await pool.query(
    `update ai_agents set published_version_id = $2, model = $3, system_prompt = $4, paused_at = null where id = $1`,
    [agenteId, versao[0]!.id, modelo, PROMPT_DO_AGENTE],
  );
  escrever(`# preparado: ${cenario.id} com ${provedor}/${modelo} (versão ${versao[0]!.id}, ${ferramentas.length} ferramentas, sessão ${sessao})`);
}

/**
 * Espera o JOB terminar, não só o traço aparecer: a tentativa que falha (429,
 * 402, queda do provedor) já grava o traço como `failed` e o job volta à fila.
 * Seguir para a próxima execução ali deixa a re-tentativa rodar depois, com a
 * versão que estiver publicada — a do cenário ou do modelo SEGUINTE.
 */
async function esperarTraco(
  pool: pg.Pool,
  telefone: string,
  desde: Date,
  tetoMs: number,
): Promise<{ jobId: string; status: string } | null> {
  const fim = Date.now() + tetoMs;
  while (Date.now() < fim) {
    const { rows } = await pool.query<{ job_id: string; status: string }>(
      `select t.job_id, t.status from agent_turn_traces t
         join contacts c on c.id = t.contact_id
         join job_queue j on j.id = t.job_id and j.status in ('done', 'failed', 'dead')
        where regexp_replace(c.phone_number, '\\D', '', 'g') = $1 and t.created_at >= $2
        order by t.created_at desc limit 1`,
      [telefone, desde],
    );
    if (rows[0] !== undefined) return { jobId: rows[0].job_id, status: rows[0].status };
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return null;
}

async function executar(): Promise<void> {
  const { dbUrl, appUrl } = exigirDestinoLocal(true);
  const teto = Number(arg("teto-usd"));
  if (!(teto > 0)) throw new Error("--teto-usd <US$> é obrigatório e positivo: o executar gasta tokens reais");
  const numeroDoLote = lote().lote;
  const pool = new pg.Pool({ connectionString: dbUrl, max: 1 });
  const sessao = arg("session") ?? "e2e-radar-session";
  const modelo = arg("modelo");
  const inicioDoExecutar = new Date();
  let preparado: string | null = null;
  let retornosCancelados = 0;
  // Depois de cada execução: o S2 ("me chama amanhã às 10h") agenda retorno de verdade.
  const cancelarRetornos = async (): Promise<void> => {
    const n = await cancelarRetornosDoLote(pool, numeroDoLote, new Date());
    retornosCancelados += n;
    if (n > 0) escrever(`# ${n} retorno(s) agendado(s) pelo lote ${numeroDoLote} cancelado(s)`);
  };
  // Antes de cada execução e depois da última: o teto vale também para o lote retomado com --de.
  const parouNoTeto = async (): Promise<boolean> => {
    const g = await gastoDoLote(pool, numeroDoLote, inicioDoExecutar, sessao);
    escrever(`# gasto do lote ${numeroDoLote} em llm_calls: US$ ${(g.centavos / 100).toFixed(4)} (teto US$ ${teto})`);
    if (conferirTeto(g, teto) === "segue") return false;
    escrever(`# teto de US$ ${teto} atingido: o lote para aqui`);
    process.exitCode = 3;
    return true;
  };
  try {
    for (const { cenario, telefone } of execucoes()) {
      if (await parouNoTeto()) return;
      if (modelo !== undefined && preparado !== cenario.id) {
        await preparar(pool, modelo, cenario, sessao);
        preparado = cenario.id;
      }
      const inicio = new Date();
      const r = spawnSync(
        "pnpm",
        [
          "exec", "tsx", "--env-file=.env.local", "scripts/provoke-agent-turn.ts",
          "--text", cenario.texto, "--from", telefone, "--app-url", appUrl,
          "--session", sessao,
        ],
        { stdio: "inherit" },
      );
      if (r.status !== 0) throw new Error(`provoke-agent-turn falhou em ${cenario.id} (${telefone})`);
      const job = await esperarTraco(pool, telefone, inicio, Number(arg("teto-ms") ?? "240000"));
      escrever(`${cenario.id}\t${telefone}\t${job === null ? "SEM TRAÇO no teto — confira o worker" : `${job.jobId}\t${job.status}`}`);
      await cancelarRetornos();
    }
    await parouNoTeto();
  } finally {
    // Também quando o lote para no meio (teto, erro): retorno que ficasse agendado
    // viraria turno pago amanhã, fora de qualquer teto.
    try {
      await cancelarRetornos();
      escrever(`# retornos cancelados neste executar: ${retornosCancelados}`);
    } finally {
      await pool.end();
    }
  }
}

async function relatorio(): Promise<void> {
  const desde = arg("desde");
  if (desde === undefined) throw new Error("--desde <ISO> é obrigatório");
  const { dbUrl } = exigirDestinoLocal();
  const pool = new pg.Pool({ connectionString: dbUrl, max: 1 });
  let turnos: TurnoMedido[];
  try {
    const { rows } = await pool.query<{
      job_id: string;
      model: string | null;
      messages_sent: number;
      ferramentas: TurnoMedido["ferramentas"];
      phone_number: string | null;
      handoff_keywords: string[] | null;
      corpos: string[] | null;
      caso_automatico: boolean;
    }>(
      // Cada execução é um contato novo: caso da conversa aberto depois que o job
      // nasceu é desta execução.
      `select t.job_id, t.model, t.messages_sent, t.ferramentas, c.phone_number, v.handoff_keywords,
              (select array_agg(m.body order by l.seq)
                 from send_ledger l join messages m on m.id = l.crm_message_id
                where l.job_id = t.job_id and l.status in ('accepted', 'queued')) as corpos,
              exists (select 1 from agent_cases ac
                       where ac.organization_id = t.organization_id and ac.conversation_id = t.conversation_id
                         and ac.source = 'guardrail_autofallback' and ac.opened_at >= j.created_at) as caso_automatico
         from agent_turn_traces t
         join job_queue j on j.id = t.job_id and j.kind = 'inbound_turn'
         join contacts c on c.id = t.contact_id
         left join ai_agent_versions v on v.id = t.agent_version_id
        where not t.is_dry_run and t.created_at >= $1`,
      [desde],
    );
    turnos = rows.map((r) => ({
      jobId: r.job_id,
      telefone: r.phone_number ?? "",
      modelo: r.model,
      mensagensEnviadas: r.messages_sent,
      ferramentas: r.ferramentas,
      corpos: r.corpos ?? [],
      casoAutomatico: r.caso_automatico,
      handoffKeywords: r.handoff_keywords ?? [],
    }));
  } finally {
    await pool.end();
  }
  const lotes = arg("lotes")?.split(",").map(Number);
  const grupos = agrupar(turnos, lotes === undefined ? undefined : new Set(lotes));
  escrever(["modelo", "cenário", "braço", "n", "adoção", "em risco", "marcou+agiu", "segurado", "perda", "revisar", "ação esperada", "msgs/turno"].join("\t"));
  for (const g of grupos.sort((a, b) => `${a.modelo}${a.cenario.codigo}${a.braco}`.localeCompare(`${b.modelo}${b.cenario.codigo}${b.braco}`))) {
    const n = g.turnos.length;
    const conta = (p: (t: (typeof g.turnos)[number]) => boolean) => g.turnos.filter(p).length;
    const esperada = g.cenario.acaoEsperada === null ? "—" : pct(conta((t) => t.acaoEsperadaCumprida === true) / n);
    escrever(
      [
        g.modelo, g.cenario.id, g.braco, n,
        pct(conta((t) => t.adotou) / n), conta((t) => t.emRisco), conta((t) => t.marcouEAgiu),
        conta((t) => t.desfecho === "segurado"), conta((t) => t.desfecho === "perda"), conta((t) => t.desfecho === "revisar"),
        esperada, (g.turnos.reduce((a, t) => a + t.mensagensEnviadas, 0) / n).toFixed(2),
      ].join("\t"),
    );
  }
  const criterios = {
    minimoEmRisco: Number(arg("minimo") ?? CRITERIOS_PADRAO.minimoEmRisco),
    tolerancia: Number(arg("tolerancia") ?? CRITERIOS_PADRAO.tolerancia),
  };
  escrever("");
  for (const modelo of [...new Set(grupos.map((g) => g.modelo))]) {
    const v = vereditoDoModelo(modelo, grupos, criterios);
    escrever(
      `${v.modelo}: ${v.resultado.toUpperCase()} — em risco ${v.emRisco}, perdas ${v.perdas}, ` +
        `limite superior 95% ${pct(v.limiteSuperior)}, adoção ${pct(v.adocao)}` +
        (v.motivos.length > 0 ? `\n  ${v.motivos.join("\n  ")}` : "") +
        (v.revisar.length > 0 ? `\n  revisar à mão (jobs): ${v.revisar.join(", ")}` : ""),
    );
  }
}

async function custo(): Promise<void> {
  const desde = arg("desde");
  if (desde === undefined) throw new Error("--desde <ISO> é obrigatório");
  const { dbUrl } = exigirDestinoLocal();
  const pool = new pg.Pool({ connectionString: dbUrl, max: 1 });
  try {
    const { rows } = await pool.query<{ phone_number: string; modelo: string | null; centavos: string; sem_preco: string }>(
      `select c.phone_number,
              (select t.model from agent_turn_traces t where t.contact_id = c.id and not t.is_dry_run
                order by t.created_at desc limit 1) as modelo,
              coalesce(sum(lc.cost_cents), 0)::text as centavos,
              count(lc.id) filter (where lc.cost_cents is null)::text as sem_preco
         from contacts c
         left join llm_calls lc on lc.organization_id = c.organization_id and lc.contact_id = c.id and lc.created_at >= $1
        where c.created_at >= $1
        group by c.id`,
      [desde],
    );
    const lotes = arg("lotes")?.split(",").map(Number);
    const grupos = new Map<string, { n: number; centavos: number[]; semPreco: number }>();
    for (const r of rows) {
      const e = execucaoDoTelefone(r.phone_number);
      if (e === null || (lotes !== undefined && !lotes.includes(e.lote))) continue;
      const chave = `${r.modelo ?? "(sem traço)"}\t${e.cenario.id}\t${e.braco}`;
      const g = grupos.get(chave) ?? { n: 0, centavos: [], semPreco: 0 };
      g.n += 1;
      g.centavos.push(Number(r.centavos));
      g.semPreco += Number(r.sem_preco);
      grupos.set(chave, g);
    }
    escrever(["modelo", "cenário", "braço", "execuções", "US$ total", "US$ por execução", "US$ máx", "chamadas sem preço"].join("\t"));
    for (const [chave, g] of [...grupos].sort(([a], [b]) => a.localeCompare(b))) {
      const total = g.centavos.reduce((a, b) => a + b, 0) / 100;
      escrever([chave, g.n, total.toFixed(4), (total / g.n).toFixed(4), (Math.max(...g.centavos) / 100).toFixed(4), g.semPreco].join("\t"));
    }
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const comando = process.argv[2];
  if (comando === "plano") {
    const l = lote();
    escrever(`# lote ${l.lote}, braço ${l.braco} — o worker precisa estar com AGENT_STOP_AFTER_FINAL_SEND=${l.braco}`);
    for (const c of l.cenarios) escrever(`# ${c.id}: preparo do agente — ${c.preparo}`);
    for (const { cenario, telefone } of execucoes()) escrever(`${cenario.id}\t${telefone}\t${cenario.texto}`);
    return;
  }
  if (comando === "preparar") {
    const modelo = arg("modelo");
    const id = arg("cenario");
    const cenario = CENARIOS.find((c) => c.id === id);
    if (modelo === undefined || cenario === undefined) throw new Error("--modelo <id da OpenRouter> --cenario <id> são obrigatórios");
    const { dbUrl } = exigirDestinoLocal();
    const pool = new pg.Pool({ connectionString: dbUrl, max: 1 });
    try {
      return await preparar(pool, modelo, cenario, arg("session") ?? "e2e-radar-session");
    } finally {
      await pool.end();
    }
  }
  if (comando === "executar") return executar();
  if (comando === "relatorio") return relatorio();
  if (comando === "custo") return custo();
  throw new Error("comando: plano | preparar | executar | relatorio | custo");
}

main().catch((err: unknown) => {
  process.stderr.write(`[avaliar-parada] falhou: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
