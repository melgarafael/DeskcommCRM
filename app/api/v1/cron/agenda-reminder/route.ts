/**
 * O LEMBRETE DO COMPROMISSO — o consumidor que faltava.
 *
 * A migration 0177 declarou que `calendar_appointments.contact_id` é "quem
 * recebe o LEMBRETE", `calendar_event_types` ganhou `reminder_enabled` e
 * `reminder_minutes_before`, a tela oferece os dois — e nada nunca leu
 * `reminder_sent_at`. O comentário de `app/api/v1/agenda/agendamentos/_handler.ts`
 * fala desta rota no futuro do pretérito: "no dia em que o worker de lembrete
 * nascer". Este é o dia.
 *
 * Enquanto ele não existia, ligar o lembrete no tipo de agendamento não fazia
 * nada — e não fazia nada EM SILÊNCIO, que é o caro: quem configurou acreditou
 * que o paciente seria avisado. Coluna sem consumidor é o anti-pattern nº 3 do
 * CLAUDE.md deste repo, e este era um deles.
 *
 * ═══ O QUE ESTA ROTA DECIDE, E POR QUÊ ═══
 *
 * **Lembrete é transacional, não marketing.** Quem recusou receber campanha
 * continua recebendo aviso do próprio compromisso. `consent.marketing.declined_at`
 * NÃO barra: esconder de alguém que o pedido dele está pronto não é respeitar a
 * recusa, é perder a entrega. Bloqueio de contato (`is_blocked`) e ausência de
 * telefone barram, porque aí não há para onde mandar.
 *
 * **A janela de envio vale.** Um lembrete que chega às 6h da manhã é o tipo de
 * mensagem que faz o número ser denunciado. Fora da janela do canal a rodada
 * simplesmente não marca `reminder_sent_at`, e a próxima tenta de novo — o
 * adiamento é o silêncio, não uma fila nova.
 *
 * **O carimbo é da TENTATIVA, não da entrega.** `sendMessageHandler` marca
 * `failed`/`queued` na própria mensagem e devolve normalmente; o estado da
 * entrega vive lá. Se este carimbo esperasse a entrega, um contato com número
 * permanentemente inválido receberia uma tentativa a cada 5 minutos até a hora
 * do compromisso.
 *
 * **Compromisso que já começou não gera lembrete.** Avisar às 15h de uma
 * retirada das 14h não é lembrete, é ruído — e o carimbo some com a linha da
 * varredura seguinte de qualquer jeito.
 *
 * ⚠️ **O contato é resolvido DENTRO da organização do compromisso.** É a
 * preocupação literal do handler de agendamentos: "esta linha vira a organização
 * A mandando WhatsApp para o cliente da B". Aqui `organization_id` sai sempre da
 * linha do compromisso e filtra a busca do contato, da conversa e do canal —
 * nunca de parâmetro. `tests/unit/agenda-reminder-nao-cruza-tenant.test.ts`
 * prende isso.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { ensureConversation } from "@/lib/automation/start-conversation";
import { adiarAteAJanelaAbrir } from "@/lib/automation/janela-do-canal";
import { espacarEnvio } from "@/lib/automation/throttle";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Teto de compromissos examinados por rodada — a varredura roda a cada 5 min. */
const LIMITE_DA_VARREDURA = 200;

/** Maior antecedência aceita pela coluna (43200 min = 30 dias). */
const MAIOR_ANTECEDENCIA_MS = 43_200 * 60_000;

interface TipoDoCompromisso {
  name: string;
  reminder_enabled: boolean;
  reminder_minutes_before: number;
  reminder_template_name: string | null;
  location_details: string | null;
}

interface CompromissoAVencer {
  id: string;
  organization_id: string;
  contact_id: string;
  title: string;
  starts_at: string;
  location_details: string | null;
  calendar_event_types: TipoDoCompromisso | TipoDoCompromisso[] | null;
}

/** O join do PostgREST devolve objeto ou array conforme a cardinalidade inferida. */
function tipoDe(linha: CompromissoAVencer): TipoDoCompromisso | null {
  const t = linha.calendar_event_types;
  if (!t) return null;
  return Array.isArray(t) ? (t[0] ?? null) : t;
}

/**
 * O texto do lembrete.
 *
 * `reminder_template_name` é a outra coluna que a 0177 criou e ninguém leu.
 * Quando ela aponta para um modelo de mensagem da organização, ele vence; sem
 * ela, sai o texto abaixo, que diz as três coisas que a pessoa precisa saber:
 * o que é, quando, e onde.
 */
export function montarLembrete(input: {
  nomeDoContato: string | null;
  titulo: string;
  quando: Date;
  timezone: string;
  local: string | null;
}): string {
  const dia = new Intl.DateTimeFormat("pt-BR", {
    timeZone: input.timezone,
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
  }).format(input.quando);
  const hora = new Intl.DateTimeFormat("pt-BR", {
    timeZone: input.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(input.quando);

  const saudacao = input.nomeDoContato ? `Oi, ${input.nomeDoContato}!` : "Oi!";
  const onde = input.local ? ` Endereço: ${input.local}.` : "";
  return `${saudacao} Passando pra lembrar do seu compromisso: ${input.titulo}, ${dia} às ${hora}.${onde}`;
}

/**
 * Está na hora de lembrar?
 *
 * Pura, e exportada, porque é a regra que o teste precisa exercitar sem banco:
 * cedo demais não manda, tarde demais (já começou) também não.
 */
export function estaNaHora(agora: Date, comeca: Date, antecedenciaMin: number): boolean {
  if (comeca.getTime() <= agora.getTime()) return false;
  return comeca.getTime() - antecedenciaMin * 60_000 <= agora.getTime();
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const fornecido = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const aceitos = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (aceitos.length === 0 || !fornecido || !aceitos.includes(fornecido)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const agora = new Date();

  // `!inner` no tipo: só interessa compromisso cujo TIPO pede lembrete. O corte
  // por `starts_at` usa a maior antecedência possível — o corte fino, que depende
  // do `reminder_minutes_before` de cada linha, é `estaNaHora` logo abaixo.
  const { data, error } = await admin
    .from("calendar_appointments")
    .select(
      "id, organization_id, contact_id, title, starts_at, location_details, " +
        "calendar_event_types!inner(name, reminder_enabled, reminder_minutes_before, reminder_template_name, location_details)",
    )
    .eq("status", "confirmed")
    .eq("calendar_event_types.reminder_enabled", true)
    .not("contact_id", "is", null)
    .is("reminder_sent_at", null)
    .gt("starts_at", agora.toISOString())
    .lte("starts_at", new Date(agora.getTime() + MAIOR_ANTECEDENCIA_MS).toISOString())
    .order("starts_at", { ascending: true })
    .limit(LIMITE_DA_VARREDURA);

  if (error) {
    logger.error("[agenda-reminder] consulta falhou", { error: error.message, requestId });
    return fail("internal_error", "Falha ao buscar compromissos.", 500, { requestId });
  }

  const linhas = (data ?? []) as unknown as CompromissoAVencer[];
  let enviados = 0;
  let pulados = 0;
  const motivos: Record<string, number> = {};
  const pular = (motivo: string) => {
    pulados += 1;
    motivos[motivo] = (motivos[motivo] ?? 0) + 1;
  };

  for (const linha of linhas) {
    const tipo = tipoDe(linha);
    if (!tipo) {
      pular("sem_tipo");
      continue;
    }
    if (!estaNaHora(agora, new Date(linha.starts_at), tipo.reminder_minutes_before)) {
      pular("ainda_nao");
      continue;
    }

    // ⚠️ organization_id SEMPRE da linha do compromisso — ver o cabeçalho.
    const org = linha.organization_id;

    const { data: contato } = await admin
      .from("contacts")
      .select("id, name, display_name, phone_number, is_blocked")
      .eq("id", linha.contact_id)
      .eq("organization_id", org)
      .maybeSingle();

    if (!contato) {
      pular("contato_fora_da_org");
      continue;
    }
    if (contato.is_blocked) {
      pular("contato_bloqueado");
      continue;
    }
    if (!contato.phone_number) {
      pular("sem_telefone");
      continue;
    }

    const { data: canal } = await admin
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", org)
      .eq("status", "WORKING")
      .limit(1)
      .maybeSingle();

    if (!canal) {
      pular("sem_canal");
      continue;
    }

    const foraDaJanela = await adiarAteAJanelaAbrir(admin, org, canal.id);
    if (foraDaJanela) {
      pular("fora_da_janela");
      continue;
    }

    const { data: organizacao } = await admin
      .from("organizations")
      .select("timezone")
      .eq("id", org)
      .maybeSingle();

    let corpo = montarLembrete({
      nomeDoContato: contato.display_name ?? contato.name ?? null,
      titulo: linha.title,
      quando: new Date(linha.starts_at),
      timezone: organizacao?.timezone ?? "America/Sao_Paulo",
      local: linha.location_details ?? tipo.location_details ?? null,
    });

    if (tipo.reminder_template_name) {
      const { data: modelo } = await admin
        .from("message_templates")
        .select("body")
        .eq("organization_id", org)
        .or(`shortcut.eq.${tipo.reminder_template_name},title.eq.${tipo.reminder_template_name}`)
        .limit(1)
        .maybeSingle();
      if (modelo?.body) corpo = modelo.body;
    }

    await espacarEnvio(canal.id);

    try {
      const conversaId = await ensureConversation(admin, org, contato.id, canal.id);
      // `webhook_source` é o ator que esta base dá a envio nascido de worker —
      // o mesmo que `lib/followup/enviar-texto-fixo.ts` usa. O `id` é o
      // compromisso, para o audit da mensagem correlacionar com a linha que a
      // originou.
      await sendMessageHandler(
        admin,
        {
          organization_id: org,
          actor: { type: "webhook_source", id: linha.id },
          requestId: `agenda-reminder:${linha.id}`,
        },
        { conversation_id: conversaId, type: "text", body: corpo } as Parameters<
          typeof sendMessageHandler
        >[2],
      );
      // Carimba a TENTATIVA — o desfecho da entrega vive na mensagem.
      await admin
        .from("calendar_appointments")
        .update({ reminder_sent_at: new Date().toISOString() })
        .eq("id", linha.id)
        .eq("organization_id", org);
      enviados += 1;
    } catch (err) {
      const mensagem = err instanceof Error ? err.message : String(err);
      logger.error("[agenda-reminder] envio falhou", { appointmentId: linha.id, error: mensagem, requestId });
      pular("erro_no_envio");
    }
  }

  // Rodada que não avisou ninguém NÃO é mutação, e não audita — a lei está no
  // CLAUDE.md §Audit log, e `tests/unit/cron-audita-so-quando-ha-efeito.test.ts`
  // varre o AST de toda rota deste diretório atrás de `audit` incondicional.
  if (enviados > 0) {
    await audit({
      action: "agenda.lembrete_enviado",
      resourceType: "calendar_appointment",
      requestId,
      metadata: { enviados, pulados, motivos },
    });
  }

  return ok({ examinados: linhas.length, enviados, pulados, motivos }, { requestId });
}

export const GET = handle;
export const POST = handle;
