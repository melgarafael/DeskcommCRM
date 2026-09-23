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
 * nunca de parâmetro. O `route.test.ts` ao lado prende isso.
 *
 * ⚠️ **ESTA ROTA NASCE DORMENTE, E ISSO É DE PROPÓSITO.** A migration 0194
 * (`lembrete_nasce_desligado`) pôs `calendar_event_types.reminder_enabled` em
 * `default false` e zerou o histórico, justamente porque não havia disparador —
 * e escreveu por extenso que "ligar lembrete por padrão fica com o dono do
 * produto NO DIA em que o disparador nascer". Este é o disparador; a decisão
 * segue sendo dele, e nada aqui a toma por ele.
 *
 * Medido na main 58dcb811: `reminder_enabled` não aparece no `criarSchema` nem
 * no `alterarSchema` de `app/api/v1/agenda/tipos/route.ts`, não é projetado no
 * GET dessa rota, e não existe em `app/app/settings/tenant/agenda/`. Ou seja:
 * hoje ninguém consegue LIGAR o lembrete pela tela nem pela API. Enquanto isso
 * for verdade, a consulta abaixo devolve zero linhas em toda instalação — a
 * varredura é barata e o envio é nenhum. A superfície de configuração é o outro
 * meio do par, e falta escrevê-la (invariante 6 do Sistema Vivo).
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { ensureConversation } from "@/lib/automation/start-conversation";
import { adiarAteAJanelaAbrir } from "@/lib/automation/janela-do-canal";
import { espacarEnvio } from "@/lib/automation/throttle";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO, normalizarIdioma, type Idioma } from "@/lib/i18n/idiomas";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { moldeDoDegrau } from "@/lib/agenda/lembretes";
import { autorizaCron } from "@/lib/auth/cron-auth";

export const dynamic = "force-dynamic";

/** Teto de compromissos examinados por rodada — a varredura roda a cada 5 min. */
const LIMITE_DA_VARREDURA = 200;

/** Maior antecedência aceita pela coluna (43200 min = 30 dias). */
const MAIOR_ANTECEDENCIA_MS = 43_200 * 60_000;

interface TipoDoCompromisso {
  name: string;
  reminder_enabled: boolean;
  reminder_minutes_before: number;
  reminder_extra_offsets_minutes: number[] | null;
  reminder_template_name: string | null;
  reminder_body: string | null;
  reminder_bodies: Record<string, string> | null;
  location_details: string | null;
}

interface CompromissoAVencer {
  id: string;
  organization_id: string;
  contact_id: string;
  title: string;
  starts_at: string;
  location_details: string | null;
  reminder_sent_offsets_minutes: number[] | null;
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
 * Sem molde, sai a frase abaixo — o quê, quando e onde. Com molde, as
 * variáveis `{{nome}}`, `{{primeiro_nome}}`, `{{titulo}}`, `{{tipo}}`,
 * `{{dia}}`, `{{hora}}`, `{{endereco}}` e `{{quando}}` são preenchidas com
 * os mesmos dados; chave desconhecida fica no texto, para quem digitou
 * `{{foo}}` ver o erro em vez de uma mensagem manca.
 *
 * `reminder_body` / `reminder_bodies` do tipo vencem por degrau; senão
 * `reminder_template_name` aponta para um modelo da organização; senão, esta
 * frase.
 */
export function aplicarMoldeDoLembrete(
  molde: string,
  pecas: Record<string, string>,
): string {
  return molde.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (literal, raw: string) => {
    const v = pecas[raw.toLowerCase()];
    return v === undefined ? literal : v;
  });
}

export function montarLembrete(input: {
  nomeDoContato: string | null;
  titulo: string;
  quando: Date;
  timezone: string;
  local: string | null;
  /**
   * O idioma da ORGANIZAÇÃO (`organizations.locale`), e não um literal.
   *
   * `tests/unit/i18n-a-data-segue-o-idioma.test.ts` proíbe `"pt-BR"` escrito à
   * mão em formatação de data fora de `lib/i18n/datas.ts` — e o motivo não é
   * estética: uma instalação em espanhol receberia o lembrete com "jueves, 03/09"
   * no meio de uma frase em português, que é a tela meio traduzida que aquele
   * guarda existe para impedir. Aqui vale em dobro, porque isto não é tela: é
   * mensagem que sai para o WhatsApp de um cliente e não dá para desfazer.
   *
   * Opcional com o padrão do produto para a função seguir pura e testável sem
   * banco — o mesmo desenho de `montarPares` em `lib/metrics/atrito.ts`.
   */
  idioma?: Idioma;
  /** Texto próprio do tipo. Vazio/nulo = a frase padrão. */
  molde?: string | null;
  /** Nome do tipo de atendimento, para `{{tipo}}`. Cai no título se faltar. */
  tipoNome?: string | null;
}): string {
  const idioma = input.idioma ?? IDIOMA_PADRAO;
  const t = (texto: string) => traduzir(texto, idioma);
  const etiqueta = tagDeIdioma(idioma);

  const dia = new Intl.DateTimeFormat(etiqueta, {
    timeZone: input.timezone,
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
  }).format(input.quando);
  const hora = new Intl.DateTimeFormat(etiqueta, {
    timeZone: input.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(input.quando);

  const nome = input.nomeDoContato?.trim() ?? "";
  const pecas: Record<string, string> = {
    nome,
    primeiro_nome: nome.split(/\s+/)[0] ?? "",
    titulo: input.titulo,
    tipo: (input.tipoNome ?? input.titulo).trim() || input.titulo,
    dia,
    hora,
    endereco: input.local?.trim() ?? "",
    quando: `${dia} ${t("às")} ${hora}`,
  };

  const molde = input.molde?.trim();
  if (molde) return aplicarMoldeDoLembrete(molde, pecas);

  // Cada `t()` cobre só a parte FIXA da frase: nome, título, data e endereço
  // são dado do tenant e nunca passam por tradução.
  // A pontuação entra na CHAVE de propósito: em espanhol a exclamação abre a
  // frase ("¡Hola"), e um `t("Oi")` solto com o `!` colado do lado de fora
  // devolveria "Hola, Rose!" — meio traduzido, que é o defeito que o guarda de
  // i18n existe para impedir.
  const saudacao = nome ? `${t("Oi,")} ${nome}!` : t("Oi!");
  const onde = pecas.endereco ? ` ${t("Endereço")}: ${pecas.endereco}.` : "";
  return (
    `${saudacao} ${t("Passando pra lembrar do seu compromisso:")} ` +
    `${input.titulo}, ${dia} ${t("às")} ${hora}.${onde}`
  );
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

/**
 * Quais degraus de lembrete estão vencidos e ainda não saíram.
 *
 * Um tipo pode pedir mais de um aviso — um dia antes e de novo três horas antes,
 * por exemplo. O degrau principal é `reminder_minutes_before`; os demais vêm de
 * `reminder_extra_offsets_minutes`.
 *
 * ⚠️ **Devolve todos os vencidos, e quem chama manda UMA mensagem só.** Se o
 * cron ficou parado e dois degraus venceram no intervalo, o certo é avisar uma
 * vez e dar os dois por cumpridos: mandar dois textos em sequência — mesmo
 * diferentes — é o que faz a pessoa bloquear o número. O texto é o do degrau
 * mais próximo do compromisso (o "agora"); o mais antecipado já perdeu a
 * função quando o mais perto venceu.
 *
 * Pura e exportada pelo mesmo motivo que `estaNaHora`: é a regra que decide se
 * alguém recebe mensagem, e ela precisa ser exercitável sem banco.
 */
export function degrausPendentes(input: {
  agora: Date;
  comeca: Date;
  principal: number;
  extras: number[] | null;
  jaEnviados: number[] | null;
}): number[] {
  const enviados = new Set(input.jaEnviados ?? []);
  const todos = new Set([input.principal, ...(input.extras ?? [])]);
  return [...todos]
    .filter((degrau) => !enviados.has(degrau) && estaNaHora(input.agora, input.comeca, degrau))
    .sort((a, b) => b - a);
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
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
      "id, organization_id, contact_id, title, starts_at, location_details, reminder_sent_offsets_minutes, " +
        "calendar_event_types!inner(name, reminder_enabled, reminder_minutes_before, reminder_extra_offsets_minutes, reminder_template_name, reminder_body, reminder_bodies, location_details)",
    )
    .eq("status", "confirmed")
    .eq("calendar_event_types.reminder_enabled", true)
    .not("contact_id", "is", null)
    // ⚠️ NÃO se filtra por `reminder_sent_at is null` aqui, e a ausência é a
    // feature: com ela, o compromisso que recebeu o aviso de um dia nunca
    // voltaria para receber o de três horas. Quem decide o que falta é
    // `degrausPendentes`, sobre `reminder_sent_offsets_minutes`.
    //
    // O teto da varredura continua sendo o de sempre, e a ordem por `starts_at`
    // crescente é o que o torna seguro: quando ele corta, corta os compromissos
    // mais distantes, que só precisam do degrau mais antecipado e voltam nas
    // próximas rodadas. Os próximos — os únicos com degrau curto vencendo —
    // estão sempre no começo da lista.
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
    const pendentes = degrausPendentes({
      agora,
      comeca: new Date(linha.starts_at),
      principal: tipo.reminder_minutes_before,
      extras: tipo.reminder_extra_offsets_minutes,
      jaEnviados: linha.reminder_sent_offsets_minutes,
    });
    if (pendentes.length === 0) {
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
      .select("timezone, locale")
      .eq("id", org)
      .maybeSingle();

    let molde = moldeDoDegrau(tipo, Math.min(...pendentes));
    if (!molde && tipo.reminder_template_name) {
      const { data: modelo } = await admin
        .from("message_templates")
        .select("body")
        .eq("organization_id", org)
        .or(`shortcut.eq.${tipo.reminder_template_name},title.eq.${tipo.reminder_template_name}`)
        .limit(1)
        .maybeSingle();
      if (modelo?.body) molde = modelo.body;
    }

    const corpo = montarLembrete({
      nomeDoContato: nomeDoContato(contato),
      titulo: linha.title,
      quando: new Date(linha.starts_at),
      timezone: organizacao?.timezone ?? "America/Sao_Paulo",
      local: linha.location_details ?? tipo.location_details ?? null,
      idioma: normalizarIdioma(organizacao?.locale),
      molde,
      tipoNome: tipo.name,
    });

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
      //
      // Carimba TODOS os degraus vencidos, não só o que motivou este texto: os
      // outros já venceram, e deixá-los pendentes faria a próxima rodada mandar
      // a mesma mensagem de novo.
      await admin
        .from("calendar_appointments")
        .update({
          reminder_sent_at: new Date().toISOString(),
          reminder_sent_offsets_minutes: [
            ...new Set([...(linha.reminder_sent_offsets_minutes ?? []), ...pendentes]),
          ],
        })
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
