/** Estados fictícios das histórias; nunca chama IA, WAHA ou serviço externo.
 * Requer a base do curso já preparada e workers parados. Só altera IDs próprios.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { exigirHttpLocal } from "./seguranca";
import { exigir, semErro, type Contexto } from "./semear-demonstracao";
import {
  idDaHistoria,
  lerHistorias,
  receitas,
  evolucaoDoCaso,
  type Historia,
  type Receita,
} from "./receitas-jornadas";
import { textoDaDemonstracao, traducaoDaDemonstracao } from "./espanhol-demonstracao";
import { idiomaDaCaptura } from "./configuracao";

export async function contextoDaBancada(): Promise<Contexto> {
  const url = exigirHttpLocal(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!chave) throw new Error("defina SUPABASE_SERVICE_ROLE_KEY");
  const db = createClient(url, chave, { auth: { autoRefreshToken: false, persistSession: false } });
  const contas = JSON.parse(
    readFileSync(new URL("./saida/contas.json", import.meta.url), "utf8"),
  ) as Record<string, { email: string }>;
  const usuarios = await db.auth.admin.listUsers({ perPage: 1000 });
  semErro(usuarios, "contas da bancada");
  const usuario = (papel: string) => {
    const id = usuarios.data.users.find((u) => u.email === contas[papel]?.email)?.id;
    if (!id) throw new Error(`semeie a base primeiro: conta ${papel} ausente`);
    return id;
  };
  const pessoa = { helena: usuario("admin"), ana: usuario("agent"), carlos: usuario("manager") };
  const { organization_id: org } = exigir(
    await db
      .from("user_organizations")
      .select("organization_id")
      .eq("user_id", pessoa.helena)
      .eq("role", "admin")
      .single(),
    "organização da bancada",
  ) as { organization_id: string };
  const { id: sessao } = exigir(
    await db
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", org)
      .is("archived_at", null)
      .order("created_at")
      .limit(1)
      .single(),
    "canal da bancada",
  ) as { id: string };
  const { id: agenteId } = exigir(
    await db
      .from("ai_agents")
      .select("id")
      .eq("organization_id", org)
      .order("created_at")
      .limit(1)
      .single(),
    "agente da bancada",
  ) as { id: string };
  const { id: funilId } = exigir(
    await db
      .from("crm_pipelines")
      .select("id")
      .eq("organization_id", org)
      .eq("is_default", true)
      .single(),
    "funil da bancada",
  ) as { id: string };
  const etapas = exigir(
    await db
      .from("crm_stages")
      .select("id")
      .eq("pipeline_id", funilId)
      .eq("organization_id", org)
      .order("position"),
    "etapas",
  ) as Array<{ id: string }>;
  return {
    db,
    org,
    pessoa,
    sessao,
    agenteId,
    funil: { id: funilId, etapas: etapas.map((e) => e.id) },
  };
}

/** Dia seguinte relativo à captura, às 17h de São Paulo; não é uma promessa do produto. */
export function horarioDaHistoria(remarcado = false) {
  const sp = new Date(Date.now() - 3 * 3_600_000);
  return new Date(
    Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), sp.getUTCDate() + (remarcado ? 2 : 1), 20),
  ).toISOString();
}

type IntervaloDaBancada = { starts_at: string; ends_at: string };

/** Só organiza compromissos fictícios da bancada, sem alterar a agenda alheia.
 * Conserva o dia escolhido pelo roteiro; lotação desse dia pede revisão da
 * bancada, em vez de mudar silenciosamente a data da história.
 */
export function horarioLivreDaBancada(
  preferido: string,
  ocupados: IntervaloDaBancada[],
  proprio?: IntervaloDaBancada,
): string {
  const meiaHora = 30 * 60_000;
  const dia = (instante: number) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(instante));
  const pedido = Date.parse(preferido);
  const intervalos = ocupados.map((i) => ({
    inicio: Date.parse(i.starts_at),
    fim: Date.parse(i.ends_at),
  }));
  if (
    !Number.isFinite(pedido) ||
    intervalos.some(
      (i) => !Number.isFinite(i.inicio) || !Number.isFinite(i.fim) || i.fim <= i.inicio,
    )
  ) {
    throw new Error("intervalo inválido na agenda fictícia da bancada");
  }
  const colide = (inicio: number, fim: number) =>
    intervalos.some((i) => i.inicio < fim && i.fim > inicio);
  if (proprio && dia(Date.parse(proprio.starts_at)) === dia(pedido)) {
    const inicio = Date.parse(proprio.starts_at),
      fim = Date.parse(proprio.ends_at);
    if (!Number.isFinite(inicio) || !Number.isFinite(fim) || fim <= inicio || colide(inicio, fim)) {
      throw new Error("o horário próprio da história deixou de estar livre na bancada");
    }
    return proprio.starts_at;
  }
  let inicio = pedido;
  for (const intervalo of intervalos.sort((a, b) => a.inicio - b.inicio)) {
    if (inicio + meiaHora <= intervalo.inicio) break;
    if (intervalo.inicio < inicio + meiaHora && intervalo.fim > inicio) {
      inicio = Math.ceil(intervalo.fim / meiaHora) * meiaHora;
    }
  }
  if (dia(inicio) !== dia(pedido) || dia(inicio + meiaHora - 1) !== dia(pedido)) {
    throw new Error("o dia escolhido pela história está ocupado; revise a bancada");
  }
  return new Date(inicio).toISOString();
}

export async function semearCena(
  ctx: Contexto,
  historia: Historia,
  receita: Receita,
  indice: number,
) {
  const { db, org, pessoa, sessao, agenteId, funil } = ctx;
  // Remove só histórias anteriores do curso, preservando pilotos, base e volumes.
  if (indice === 0) {
    for (const [tabela, entidade] of [
      ["calendar_appointments", 3],
      ["crm_tasks", 4],
      ["crm_leads", 5],
      ["agent_cases", 6],
      ["conversations", 2],
      ["contacts", 1],
      ["channel_sessions", 9],
    ] as const) {
      semErro(
        await db
          .from(tabela)
          .delete()
          .eq("organization_id", org)
          .in(
            "id",
            receitas.map((r) => idDaHistoria(r.jornada, entidade)),
          ),
        `limpar histórias anteriores em ${tabela}`,
      );
    }
  }
  const cena = historia.cenas[indice]!;
  const id = (entidade: number) => idDaHistoria(historia.id, entidade);
  const conversa = id(2),
    tarefa = id(4),
    negocio = id(5),
    caso = id(6);
  let contato = id(1),
    sessaoDaHistoria = sessao;
  let contatoExistente = false;
  let compromisso = id(3);
  let inicioCompromisso: string | null = null;
  let fusoCompromisso = "America/Sao_Paulo",
    statusCompromisso = "confirmed";
  let responsavelAgenda = historia.id === "clinicas-remarcar-sessao" ? pessoa.ana : pessoa.helena;
  const titulo =
    historia.id === "clinicas-primeira-consulta"
      ? textoDaDemonstracao("Avaliação Postural — Marina Exemplo")
      : historia.id === "clinicas-remarcar-sessao"
        ? textoDaDemonstracao("Sessão de fisioterapia — Rui")
        : historia.id === "infoprodutos-acesso"
          ? textoDaDemonstracao("Erro 403 na aula 3 — Fotografia na Prática")
          : `${textoDaDemonstracao(historia.titulo)} — ${receita.pessoa}`;
  const casoTitulo = `${titulo} · ${textoDaDemonstracao("demonstração")}`;
  const agora = Date.now();
  const em = (i: number) => new Date(agora - (10 - i) * 60_000).toISOString();
  const automatico =
    historia.id === "e-commerce-consultar-pedido" ||
    historia.id === "infoprodutos-acesso" ||
    (historia.id === "clinicas-primeira-consulta" && indice < 3);
  const empresa = historia.empresa.replace(/ \(fictícia\)$/, "");
  if (historia.id === "e-commerce-consultar-pedido") {
    // Mesmo identificador que a fonte espera; não reescreve o cadastro da prova nativa.
    const original = await db
      .from("contacts")
      .select("id")
      .eq("organization_id", org)
      .eq("phone_number", "+5511000000997")
      .is("is_merged_into", null)
      .maybeSingle();
    semErro(original, "contato da fonte fictícia");
    if (original.data) {
      contato = original.data.id;
      contatoExistente = true;
    }
    // Uma conversa por contato+canal: a reconstituição usa canal próprio parado,
    // sem alterar a conversa/canal originais e sem publicar outro agente.
    sessaoDaHistoria = id(9);
    semErro(
      await db.from("channel_sessions").upsert({
        id: sessaoDaHistoria,
        organization_id: org,
        provider: "waha",
        waha_session_name: "curso-loja-reconstituicao",
        webhook_secret_encrypted: "\\x00",
        status: "STOPPED",
        display_name: textoDaDemonstracao("Casa das Trilhas · demonstração sem envio"),
        phone_number: null,
      }),
      "canal exclusivo da reconstituição",
    );
  }
  // Só modelos conhecidos da base: o seed antigo os repõe ao voltar às lições da clínica.
  semErro(
    await db
      .from("message_templates")
      .delete()
      .eq("organization_id", org)
      .in(
        "title",
        [
          "Horários da nutricionista",
          "Endereço da clínica",
          "Preparo para exame de sangue",
        ].flatMap((titulo) => [titulo, traducaoDaDemonstracao(titulo) ?? titulo]),
      ),
    "retirar respostas rápidas clínicas",
  );
  semErro(
    await db
      .from("organizations")
      .update({ display_name: empresa, legal_name: empresa })
      .eq("id", org),
    "nome fictício da história",
  );
  if (sessaoDaHistoria === sessao)
    semErro(
      await db
        .from("channel_sessions")
        .update({ display_name: `${empresa} · ${textoDaDemonstracao("demonstração")}` })
        .eq("id", sessao)
        .eq("organization_id", org),
      "nome do canal",
    );
  semErro(
    await db
      .from("ai_agents")
      .update({ name: `${textoDaDemonstracao("Assistente")} · ${empresa}` })
      .eq("id", agenteId)
      .eq("organization_id", org),
    "nome do agente",
  );
  if (!contatoExistente)
    semErro(
      await db.from("contacts").upsert({
        id: contato,
        organization_id: org,
        name: receita.pessoa,
        phone_number:
          historia.id === "e-commerce-consultar-pedido"
            ? "+5511000000997"
            : `+551199900${String(receitas.indexOf(receita) + 1).padStart(4, "0")}`,
        tags: ["exemplo-ficticio"],
      }),
      "contato fictício",
    );
  semErro(
    await db.from("conversations").upsert({
      id: conversa,
      organization_id: org,
      contact_id: contato,
      channel_session_id: sessaoDaHistoria,
      status: "claimed",
      bot_silenced_until: "infinity",
    }),
    "conversa fictícia",
  );
  semErro(
    await db.from("messages").delete().eq("organization_id", org).eq("conversation_id", conversa),
    "limpar mensagens da história",
  );
  semErro(
    await db
      .from("conversation_notes")
      .delete()
      .eq("organization_id", org)
      .eq("conversation_id", conversa),
    "limpar notas da história",
  );
  // Mensagens encenadas versionadas, coerentes com os personagens; nunca atribuídas ao motor.
  for (const [i] of historia.cenas.slice(0, indice + 1).entries()) {
    semErro(
      await db.from("messages").insert({
        organization_id: org,
        conversation_id: conversa,
        contact_id: contato,
        channel_session_id: sessaoDaHistoria,
        type: "text",
        body: textoDaDemonstracao(receita.cenas[i]!.mensagem),
        direction: "inbound",
        status: "received",
        sent_via: "external_device",
        sent_at: em(i),
        created_at: em(i),
        metadata: { curso_roteiro: true },
      }),
      "mensagem fictícia",
    );
    if (receita.cenas[i]!.resposta)
      semErro(
        await db.from("messages").insert({
          organization_id: org,
          conversation_id: conversa,
          contact_id: contato,
          channel_session_id: sessaoDaHistoria,
          type: "text",
          body: textoDaDemonstracao(receita.cenas[i]!.resposta),
          direction: "outbound",
          status: "read",
          sent_via: receita.cenas[i]!.resposta_observada ? "ai" : "user",
          sent_by_user_id: receita.cenas[i]!.resposta_observada ? null : pessoa.helena,
          sent_at: new Date(Date.parse(em(i)) + 10_000).toISOString(),
          created_at: new Date(Date.parse(em(i)) + 10_000).toISOString(),
          metadata: { curso_roteiro: true },
        }),
        "resposta humana encenada",
      );
  }
  semErro(
    await db.rpc("fn_mark_conversation_message", {
      p_conv: conversa,
      p_direction: receita.cenas[indice]!.resposta ? "outbound" : "inbound",
      p_preview: textoDaDemonstracao(
        receita.cenas[indice]!.resposta || receita.cenas[indice]!.mensagem,
      ),
      p_at: receita.cenas[indice]!.resposta
        ? new Date(Date.parse(em(indice)) + 10_000).toISOString()
        : em(indice),
    }),
    "resumo da conversa",
  );
  if (!automatico)
    semErro(
      await db.rpc("fn_conversation_assign", {
        p_organization_id: org,
        p_conversation_id: conversa,
        p_to_user_id: pessoa.helena,
        p_reason: "claim",
      }),
      "responsável da história",
    );
  semErro(
    await db
      .from("conversations")
      .update({
        ...(automatico
          ? {
              status: "ai_handling",
              assignee_kind: "ai",
              assigned_to_user_id: null,
              bot_silenced_until: null,
            }
          : { bot_silenced_until: "infinity" }),
        unread_count_for_assignee: 0,
      })
      .eq("id", conversa)
      .eq("organization_id", org),
    "pausa da demonstração",
  );
  if (indice > 0)
    semErro(
      await db.from("conversation_notes").insert({
        organization_id: org,
        conversation_id: conversa,
        created_by_user_id: pessoa.helena,
        created_by_name: "Helena Prado",
        body: `${receita.pessoa} · ${textoDaDemonstracao(cena.titulo)}\n${textoDaDemonstracao(historia.contexto)} ${textoDaDemonstracao("Próximo passo")}: ${textoDaDemonstracao(cena.valor)}`,
        created_at: em(indice + 1),
      }),
      "nota da etapa",
    );

  const superficies = receita.cenas.slice(0, indice + 1).map((c) => c.superficie);
  // Limpa só artefatos próprios desta história; evita o estado final da última rodada vazar na chegada.
  for (const [tabela, entidade] of [
    ["crm_tasks", tarefa],
    ["crm_leads", negocio],
    ["agent_cases", caso],
  ] as const) {
    semErro(
      await db.from(tabela).delete().eq("organization_id", org).eq("id", entidade),
      `repor ${tabela}`,
    );
  }
  if (!superficies.includes("agenda"))
    semErro(
      await db
        .from("calendar_appointments")
        .delete()
        .eq("organization_id", org)
        .eq("id", compromisso),
      "limpar compromisso próprio",
    );
  if (superficies.includes("agenda")) {
    const preferido =
      historia.id === "clinicas-primeira-consulta"
        ? "2026-10-27T12:30:00.000Z"
        : horarioDaHistoria(historia.id === "clinicas-remarcar-sessao" && indice >= 2);
    const existentes = exigir(
      await db
        .from("calendar_appointments")
        .select("id, starts_at, ends_at")
        .eq("organization_id", org)
        .eq("id", compromisso),
      "compromisso próprio",
    ) as Array<IntervaloDaBancada & { id: string }>;
    let comeca = preferido;
    if (historia.id !== "clinicas-primeira-consulta") {
      const ocupados = exigir(
        await db
          .from("calendar_appointments")
          .select("starts_at, ends_at")
          .eq("organization_id", org)
          .eq("owner_user_id", responsavelAgenda)
          .in("status", ["pending", "confirmed"])
          .neq("id", compromisso),
        "intervalos ocupados da bancada",
      ) as IntervaloDaBancada[];
      comeca = horarioLivreDaBancada(preferido, ocupados, existentes[0]);
    }
    inicioCompromisso = comeca;
    // O piloto real permanece intacto. Quando presente, a foto lê seu compromisso original.
    // A reconstituição ES usa o ID próprio: não traduz nem altera o registro
    // observado do piloto PT, que continua sendo a evidência original.
    const piloto =
      historia.id === "clinicas-primeira-consulta" && idiomaDaCaptura() === "pt-BR"
        ? (exigir(
            await db
              .from("calendar_appointments")
              .select("id, owner_user_id, starts_at, time_zone, status")
              .eq("organization_id", org)
              .eq("title", titulo)
              .eq("starts_at", comeca)
              .in("status", ["confirmed", "pending"])
              .neq("id", compromisso),
            "compromisso do piloto",
          ) as Array<{
            id: string;
            owner_user_id: string | null;
            starts_at: string;
            time_zone: string;
            status: string;
          }>)
        : [];
    if (piloto.length > 1) throw new Error("piloto clínico ambíguo: mais de um compromisso");
    if (piloto[0]) {
      compromisso = piloto[0].id;
      responsavelAgenda = piloto[0].owner_user_id ?? pessoa.helena;
      inicioCompromisso = piloto[0].starts_at;
      fusoCompromisso = piloto[0].time_zone;
      statusCompromisso = piloto[0].status;
    } else {
      const campos = {
        organization_id: org,
        contact_id: contato,
        title: titulo,
        starts_at: comeca,
        ends_at: new Date(Date.parse(comeca) + 30 * 60_000).toISOString(),
        time_zone: "America/Sao_Paulo",
        status: "confirmed",
        owner_user_id: responsavelAgenda,
        location_kind: "in_person",
        location_details: empresa,
        description: textoDaDemonstracao(historia.contexto),
        notes: textoDaDemonstracao(cena.operacao),
        created_by_kind: "user",
        created_by_user_id: pessoa.helena,
        source: "ui",
      };
      semErro(
        existentes.length
          ? await db
              .from("calendar_appointments")
              .update(campos)
              .eq("organization_id", org)
              .eq("id", compromisso)
          : await db.from("calendar_appointments").insert({ id: compromisso, ...campos }),
        "compromisso da história",
      );
    }
  }
  if (superficies.includes("negocio")) {
    semErro(
      await db
        .from("crm_pipelines")
        .update({ name: `${empresa} · ${textoDaDemonstracao("oportunidades")}` })
        .eq("organization_id", org)
        .eq("id", funil.id),
      "funil da história",
    );
    for (const [i, nome] of [
      "Novo interesse",
      "Em análise",
      "Próximo passo",
      "Acompanhamento",
    ].entries()) {
      if (funil.etapas[i])
        semErro(
          await db
            .from("crm_stages")
            .update({ name: textoDaDemonstracao(nome) })
            .eq("organization_id", org)
            .eq("id", funil.etapas[i]),
          "etapa do funil",
        );
    }
    semErro(
      await db.from("crm_leads").insert({
        id: negocio,
        organization_id: org,
        pipeline_id: funil.id,
        stage_id: funil.etapas[indice >= 3 ? 2 : 0],
        contact_id: contato,
        title: titulo,
        status: "open",
        value_cents: 0,
        currency: "BRL",
      }),
      "negócio aberto",
    );
  }
  const tarefaStatus = receita.cenas[indice]!.tarefa_status;
  if (superficies.includes("tarefa") && !tarefaStatus)
    throw new Error("receita sem situação da tarefa nesta cena");
  if (superficies.includes("tarefa"))
    semErro(
      await db.from("crm_tasks").insert({
        id: tarefa,
        organization_id: org,
        title: titulo,
        description: textoDaDemonstracao(cena.operacao),
        contact_id: contato,
        lead_id: superficies.includes("negocio") ? negocio : null,
        status: tarefaStatus,
        priority: "medium",
        assigned_to: pessoa.helena,
        created_by: pessoa.helena,
        due_date: horarioDaHistoria(),
      }),
      "tarefa da equipe",
    );
  if (superficies.includes("caso")) {
    const evolucao = evolucaoDoCaso(receita, indice);
    semErro(
      await db.from("agent_cases").insert({
        id: caso,
        organization_id: org,
        conversation_id: conversa,
        agent_id: agenteId,
        status: evolucao.status,
        kind: "duvida",
        source: "agent",
        title: casoTitulo,
        summary: textoDaDemonstracao(historia.contexto),
        blocker: textoDaDemonstracao(historia.cenas[1]!.operacao),
        opened_at: em(1),
        closed_at: evolucao.fechado ? em(indice + 1) : null,
      }),
      "caso demonstrativo",
    );
    semErro(
      await db.from("agent_case_events").insert({
        organization_id: org,
        case_id: caso,
        kind: "opened",
        actor_kind: "system",
        body: textoDaDemonstracao(
          "Estado semeado para o roteiro demonstrativo; não é execução observada de IA.",
        ),
        created_at: em(1),
      }),
      "origem do exemplo",
    );
    if (evolucao.eventos.length)
      semErro(
        await db.from("agent_case_events").insert(
          evolucao.eventos.map((evento, i) => ({
            organization_id: org,
            case_id: caso,
            kind: evento.kind,
            actor_kind: evento.actor_kind,
            actor_user_id: evento.actor_kind === "human" ? pessoa.helena : null,
            human_action: evento.human_action ?? null,
            body: textoDaDemonstracao(evento.body),
            created_at: new Date(Date.parse(em(evento.cena)) + i * 1000).toISOString(),
          })),
        ),
        "evolução demonstrativa do caso",
      );
  }
  if (superficies.includes("configuracao-externa") || superficies.includes("fonte-externa")) {
    semErro(
      await db.from("platform_config").upsert(
        {
          chave: "MODULO_BANCO_EXTERNO",
          valor: "ligado",
          eh_segredo: false,
          semeado_do_env: false,
          updated_by: pessoa.helena,
        },
        { onConflict: "chave" },
      ),
      "habilitar tela de configuração",
    );
  }
  return {
    contato,
    conversa,
    compromisso,
    tarefa,
    negocio,
    caso,
    titulo,
    casoTitulo,
    empresa,
    responsavelAgenda,
    inicioCompromisso,
    fusoCompromisso,
    statusCompromisso,
    tarefaStatus,
  };
}

async function main() {
  const historia = lerHistorias().find((h) => h.id === process.argv[2]);
  if (!historia) throw new Error("informe o ID de uma jornada");
  const receita = receitas.find((r) => r.jornada === historia.id)!;
  const indice = process.argv[3] ? historia.cenas.findIndex((c) => c.id === process.argv[3]) : 0;
  if (indice < 0) throw new Error("cena desconhecida");
  await semearCena(await contextoDaBancada(), historia, receita, indice);
  console.info(`estado semeado: ${historia.id}/${historia.cenas[indice]!.id}`);
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  main().catch(() => {
    console.error("Falha ao semear jornada; confira a bancada local e o catálogo.");
    process.exitCode = 1;
  });
}
