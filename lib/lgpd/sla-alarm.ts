/**
 * LGPD SLA alarm dispatcher.
 *
 * Triggered by the lgpd-sla-watcher cron (S-08.08) when a request is
 * approaching or past its D+5 / D+10 threshold.
 *
 * Privacy rules (L-08):
 *  - Sentry payload: zero PII — only ids, counts, thresholds.
 *  - DPO email: recipient address from DB column or env, never logged in plaintext.
 *  - request_payload.last_alarm_at updated as fire-once-per-24h dedup guard.
 *
 * ─── Língua do destinatário, e não país (issue #2347, itens 1 e 2) ──────────
 *
 * O e-mail fala com QUEM RECEBE. O `lang` do HTML e as frases saem da LÍNGUA do
 * país (`PerfilDoPais.idioma`), não do código do país: Portugal falava português
 * e mandava `lang="pt-BR"`, e o "Acesse:" — que só existe em português — sairia
 * igual num país que não fale português. A LEI continua vindo do país
 * (`noBrasil`): as duas coisas são ortogonais.
 *
 * O rodapé de fora do Brasil tem duas figuras. Antes de vencer o mês do
 * art. 12.º, n.º 3, ele diz que o prazo interno é mais curto que o legal; depois
 * de vencido, dizer isso faria o encarregado achar que ainda há folga, e ele
 * passa a afirmar o vencimento.
 */

import * as Sentry from "@sentry/nextjs";

import { NEUTROS_DE_SAIDA, type MarcaDeSaida } from "@/lib/branding/saida";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/roteador";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { valorDaInstalacao } from "@/lib/instalacao/config";
import { citacaoDaLei, PAIS_PADRAO, perfilDoPais, type PerfilDoPais } from "@/lib/legal/perfil-do-pais";
import { traduzir } from "@/lib/i18n/dicionario";
import { idiomaDoTexto } from "@/lib/i18n/idiomas";
import { diaDoPrazo, diasAtePrazo, diasDeAtraso, prazoEmBr } from "./sla";
import type { LgpdRequest } from "./types";

export type AlarmThreshold = "data_request_d5" | "redact_d10";

export interface TriggerSlaAlarmArgs {
  request: LgpdRequest;
  threshold: AlarmThreshold;
  organizationDpoEmail?: string | null;
  /**
   * `organizations.display_name`, quando o chamador o tem. Aqui o fallback era
   * borda de verdade — ao contrário do irmão em `email-delivery.ts`, o cron
   * SEMPRE passava este campo (`app/api/v1/cron/lgpd-sla-watcher/route.ts`), e
   * a coluna é `NOT NULL` no schema (`supabase/baseline.sql:1750`). Os dois
   * `?? "DeskcommCRM"` se pareciam e não eram a mesma coisa; tratá-los com a
   * mesma urgência teria errado a prioridade.
   */
  organizationName?: string | null;
  /**
   * A marca resolvida da instalação/organização. Substitui o antigo literal e
   * pinta o botão — sem ela o alarme sairia com a cor de outro produto.
   */
  marca: MarcaDeSaida;
  /**
   * `organizations.country`, lido na MESMA consulta do watcher que já traz o
   * encarregado — nenhuma leitura a mais por pedido. `null`/ausente = Brasil,
   * com o texto de sempre. Fora do Brasil o alarme não afirma a LGPD (doc 88).
   * Obrigatória de propósito: quem esquecer de passá-la recebe erro de tipo, e
   * não o alarme brasileiro calado numa organização de Portugal.
   */
  country: string | null;
}

export interface TriggerSlaAlarmResult {
  alarmed: boolean;
  sentry: boolean;
  email: boolean;
  reason?: string;
}

const DEDUP_MS = 24 * 60 * 60 * 1_000; // 24 h

export async function triggerSlaAlarm(
  args: TriggerSlaAlarmArgs,
): Promise<TriggerSlaAlarmResult> {
  const { request, threshold, organizationDpoEmail, organizationName, marca } = args;
  const perfil = perfilDoPais(args.country);
  const noBrasil = perfil.codigo === PAIS_PADRAO;

  // ──────────────────────────────────────────────────────────────────────────
  // 1. 24-hour dedup guard
  // ──────────────────────────────────────────────────────────────────────────
  const lastAlarmRaw = request.request_payload?.last_alarm_at;
  if (lastAlarmRaw && typeof lastAlarmRaw === "string") {
    const lastAlarmMs = new Date(lastAlarmRaw).getTime();
    if (!Number.isNaN(lastAlarmMs) && Date.now() - lastAlarmMs < DEDUP_MS) {
      return { alarmed: false, sentry: false, email: false, reason: "dedup_24h" };
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Dias de atraso — contados em DIAS CIVIS, no eixo em que o prazo foi
  //    contado. Ver `lib/lgpd/sla.ts`: `due_at` é a meia-noite UTC de um dia
  //    útil, e o prazo vai até o FIM desse dia.
  //
  //    A versão anterior (`Math.round((now - due_at) / 86_400_000)`) errava por
  //    dois motivos somados: media milissegundos — que a oeste de UTC já são o
  //    dia seguinte — e arredondava meio dia para cima. Efeito medido em São
  //    Paulo, prazo no dia 05/10: às 09h de 05/10 (12h UTC) o e-mail dizia
  //    "1 dia(s) em atraso" ao lado de "o prazo vence em 04/10, 21:00" — dois
  //    números que não podem estar certos ao mesmo tempo, e o primeiro é o que
  //    o DPO lê.
  // ──────────────────────────────────────────────────────────────────────────
  // Um `Date` só para a passada inteira: `diasDeAtraso`, `diasAtePrazo` e a
  // checagem do mês legal do RGPD (item 1 da #2347) leem o MESMO agora — duas
  // leituras de relógio na virada do dia civil dariam números que não podem
  // estar certos ao mesmo tempo.
  const agora = new Date();
  const daysOverdue = diasDeAtraso(request.due_at, agora);

  const daysToDue = diasAtePrazo(request.due_at, agora); // negativo = atrasado

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Sentry warning — zero PII in payload
  // ──────────────────────────────────────────────────────────────────────────
  let sentryOk = false;
  try {
    Sentry.captureMessage("LGPD SLA threshold reached", {
      level: "warning",
      tags: {
        request_id: request.id,
        organization_id: request.organization_id,
        request_type: request.request_type,
        threshold,
      },
      extra: {
        received_at: request.received_at,
        due_at: request.due_at,
        attempts: request.attempts,
        days_overdue: daysOverdue,
        status: request.status,
      },
    });
    sentryOk = true;
  } catch (err) {
    console.warn("[lgpd-sla-alarm] Sentry.captureMessage failed", err);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Email DPO
  // ──────────────────────────────────────────────────────────────────────────
  const recipientEmail =
    organizationDpoEmail || (await valorDaInstalacao("LGPD_DPO_EMAIL")).valor;
  let emailOk = false;

  if (!recipientEmail) {
    console.warn("[lgpd-sla-alarm] dpo_email_missing — skipping email for request", request.id);
  } else {
    try {
      const shortId = request.id.slice(0, 8);
      const orgName = escapeHtml(organizationName || marca.nome);
      const appUrl = env.NEXT_PUBLIC_APP_URL;
      // Porta neutra, não `/app` nem o hub: a empresa pode ser suspensa ou
      // reativada entre o envio e o clique, e quem decide é o clique
      // (`app/lgpd/pedido/[id]/route.ts`).
      const requestUrl = `${appUrl}/lgpd/pedido/${request.id}`;

      // O IDIOMA do DESTINATÁRIO, não o país (issue #2347, item 2): o `lang` do
      // HTML e as frases do alarme saem da LÍNGUA que o país fala. Hoje o
      // seletor só oferece Brasil e Portugal e os dois falam português — o que
      // muda de imediato é o `lang` de Portugal, que era um `pt-BR` de mentira,
      // e o "Acesse:", que só existe em português. O país continua decidindo a
      // LEI (`noBrasil`): língua e lei são coisas ortogonais, e um país pode
      // falar português sem ser o Brasil.
      const idioma = perfil.idioma;
      const t = (texto: string) => traduzir(texto, idiomaDoTexto(idioma));

      // O Brasil fica byte a byte igual; fora dele, o rótulo não nomeia lei.
      // `store_redact` é a Nuvemshop avisando que o lojista desinstalou o app
      // (`webhooks/nuvemshop/store-redact`): não é pedido de titular, e o prazo
      // do art. 12.º, n.º 3 do RGPD não o rege.
      const daLoja = !noBrasil && request.request_type === "store_redact";
      // `[LGPD]` fica em duro porque só sai no BRASIL, que é sempre `pt-BR` (a
      // coluna vazia vale Brasil). Os rótulos de fora do Brasil saem pelo
      // idioma: são texto ao destinatário, não citação de lei.
      const etiqueta = noBrasil
        ? "[LGPD]"
        : daLoja
          ? t("[Apagamento da loja]")
          : t("[Pedido de titular]");
      // Item 1 da #2347: passado o mês do art. 12.º, n.º 3, o rodapé não pode
      // mais dizer que o prazo interno é "mais curto que o legal" — nesse ponto
      // o prazo legal TAMBÉM venceu e a frase fazia parecer que havia folga.
      const mesLegalVencido = mesLegalDoPedidoVencido(request.received_at, agora);
      const rodapeForaDoBrasil = daLoja
        ? t("Prazo interno do sistema.")
        : prazoInternoForaDoBrasil(perfil, mesLegalVencido, t);
      // O rótulo vem do PERFIL do país (issue #2344): o art. 18 da LGPD é um
      // DIREITO do titular, não uma base legal. O Brasil declara "Direito
      // exercido"; o `??` cobre só perfil construído à mão em teste.
      const rotulo = perfil.lei?.rotuloNoDocumento ?? "Base legal";
      const rodapeHtml = noBrasil
        ? `${rotulo}: LGPD Lei nº 13.709/2018, Art. 18. SLA obrigatório conforme regulamentação vigente.`
        : rodapeForaDoBrasil;
      const rodapeTexto = noBrasil
        ? `${rotulo}: LGPD Lei nº 13.709/2018, Art. 18.`
        : rodapeForaDoBrasil;

      const subject = `${etiqueta} ${t("Solicitação {id} próxima do vencimento").replace("{id}", shortId)}`;

      const thresholdLabel =
        threshold === "data_request_d5"
          ? t("D+5 (acesso a dados)")
          : t("D+10 (anonimização/exclusão)");

      // A DATA vem do dia civil que a coluna guarda, não do instante com fuso:
      // `toLocaleString` com `timeZone: America/Sao_Paulo` devolvia o dia
      // ANTERIOR (a meia-noite UTC do dia 05 é 21:00 do dia 04 em São Paulo).
      // Ver `prazoEmBr` — e, junto, `diaDoPrazo`.
      const dueFmt = prazoEmBr(request.due_at) ?? new Date(request.due_at).toISOString().slice(0, 10);

      // A frase do limiar: no Brasil ela nomeia a lei ("A solicitação LGPD") e
      // fica em duro, byte a byte como sempre foi; fora do Brasil sai pelo
      // idioma. Os `{id}`/`{org}`/`{limiar}` são substituídos DEPOIS, para o
      // HTML manter o `<strong>` que o texto puro não tem — é por isso uma frase
      // só com marcadores, e não a prosa remontada em pedaços traduzidos, que o
      // idioma desmontaria ("de" e "atingiu o limiar" soltos não são frase).
      const origemBruta = organizationName || marca.nome;
      const modeloDaFrase = noBrasil
        ? "A solicitação LGPD {id} de {org} atingiu o limiar {limiar}."
        : t("A solicitação {id} de {org} atingiu o limiar {limiar}.");
      // O nome da organização entra por ÚLTIMO e por FUNÇÃO: é texto de quem
      // cadastrou, e como string de substituição um `$$`/`$&`/`$'` no nome
      // seria lido como padrão do `replace` — o Brasil deixaria de sair byte a
      // byte igual para "Ca$$h Store".
      const fraseHtml = modeloDaFrase
        .replace("{id}", `<strong>#${shortId}</strong>`)
        .replace("{limiar}", `<strong>${thresholdLabel}</strong>`)
        .replace("{org}", () => `<strong>${orgName}</strong>`);
      const fraseTexto = modeloDaFrase
        .replace("{id}", `#${shortId}`)
        .replace("{limiar}", thresholdLabel)
        .replace("{org}", () => origemBruta);

      // `#dc2626` FICA, e não vira o accent: é semântica de ALERTA, não marca.
      // Um atraso que aparece em verde-sálvia porque o revendedor escolheu
      // verde deixa de comunicar urgência — a cor aqui é a informação.
      const notaDeAtraso = t("Esta solicitação está {n} dia(s) em atraso.").replace(
        "{n}",
        String(daysOverdue),
      );
      const overdueNote =
        daysOverdue > 0
          ? `<p style="color:#dc2626;font-weight:600;">⚠ ${notaDeAtraso}</p>`
          : `<p>${t("O prazo vence em {data}.").replace("{data}", `<strong>${dueFmt}</strong>`)}</p>`;
      // O texto puro diz o prazo curto ("Prazo: 20/10/2026."), e não "O prazo
      // vence em" — duas frases que sempre foram diferentes.
      const notaDePrazoTexto = daysOverdue > 0 ? notaDeAtraso : t("Prazo: {data}.").replace("{data}", dueFmt);

      const html = `<!doctype html>
<html lang="${idioma}">
<body style="font-family:-apple-system,Helvetica,Arial,sans-serif;color:${NEUTROS_DE_SAIDA.texto};line-height:1.5;max-width:560px;margin:0 auto;padding:24px;">
  <h2 style="margin:0 0 12px;font-size:18px;">${etiqueta} ${t("Alerta de SLA — Solicitação {id}").replace("{id}", `#${shortId}`)}</h2>
  <p>${t("Olá,")}</p>
  <p>${fraseHtml}</p>
  ${overdueNote}
  <p>${t("Status atual:")} <code>${request.request_type}</code> / <code>${request.status}</code></p>
  <p style="margin:24px 0;">
    <a href="${requestUrl}" style="background:${marca.accent};color:${marca.accentFg};padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block;">${t("Ver solicitação no painel")}</a>
  </p>
  <p style="font-size:12px;color:${NEUTROS_DE_SAIDA.suave};">${rodapeHtml}</p>
</body>
</html>`;

      // Texto puro não escapa: `&amp;` no corpo de um alarme é ruído.
      const text = `${etiqueta} ${t("Alerta de SLA — Solicitação {id}").replace("{id}", `#${shortId}`)}

${fraseTexto}
${notaDePrazoTexto}

${t("Status:")} ${request.request_type} / ${request.status}

${t("Acesse:")} ${requestUrl}

${rodapeTexto}`;

      const result = await sendEmail({
        to: recipientEmail,
        subject,
        html,
        text,
        fromName: marca.nome,
        tags: [
          { name: "kind", value: "lgpd_sla_alarm" },
          { name: "threshold", value: threshold },
          { name: "request_short", value: shortId },
        ],
      });

      emailOk = result.ok;
      if (!result.ok) {
        console.warn("[lgpd-sla-alarm] email send failed", result.error, result.details);
      }
    } catch (err) {
      console.warn("[lgpd-sla-alarm] email exception", err);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 5. Update request_payload.last_alarm_at (programmatic org filter)
  // ──────────────────────────────────────────────────────────────────────────
  try {
    const supabaseAdmin = createAdminClient();
    const { error } = await supabaseAdmin.rpc("jsonb_set_last_alarm_at", {
      p_id: request.id,
      p_organization_id: request.organization_id,
    });

    // RPC may not exist yet — fall back to raw update
    if (error) {
      await supabaseAdmin
        .from("lgpd_requests")
        .update({
          request_payload: {
            ...((request.request_payload as Record<string, unknown>) ?? {}),
            last_alarm_at: new Date().toISOString(),
          },
        })
        .eq("id", request.id)
        .eq("organization_id", request.organization_id); // programmatic filter — never from body
    }
  } catch (err) {
    console.warn("[lgpd-sla-alarm] failed to update last_alarm_at", err);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 6. Audit
  // ──────────────────────────────────────────────────────────────────────────
  const alarmed = sentryOk || emailOk;
  try {
    await audit({
      action: "lgpd.sla_alarm_triggered",
      organizationId: request.organization_id,
      resourceType: "lgpd_request",
      resourceId: request.id,
      bypassedRls: true,
      metadata: {
        threshold,
        days_to_due: daysToDue,
        sentry: sentryOk,
        email: emailOk,
      },
    });
  } catch (err) {
    console.warn("[lgpd-sla-alarm] audit write failed", err);
  }

  return { alarmed, sentry: sentryOk, email: emailOk };
}

/**
 * O rodapé do alarme fora do Brasil, JÁ no idioma do destinatário.
 *
 * Três figuras, e a ordem importa:
 *  - país sem citação de lei revisada não afirma lei nenhuma;
 *  - com o mês do art. 12.º, n.º 3 VENCIDO (issue #2347, item 1) não há mais
 *    prazo legal adiante, e "mais curto que o prazo legal" faria o encarregado
 *    concluir que ainda há folga — a frase passa a afirmar o vencimento;
 *  - antes disso, a frase de sempre: o prazo interno é mais curto que o legal.
 *
 * Recebe `t` porque a escolha da figura é do país/do relógio e a LÍNGUA é do
 * destinatário: cada frase sai de uma chamada `t()` com literal, para o guarda
 * de i18n cobrar o espanhol de todas elas.
 */
function prazoInternoForaDoBrasil(
  perfil: PerfilDoPais,
  mesLegalVencido: boolean,
  t: (texto: string) => string,
): string {
  const rgpd = perfil.lei?.nome === "RGPD" && citacaoDaLei(perfil) !== null;
  if (!rgpd) return t("Prazo interno do sistema, mais curto que o prazo legal.");
  if (mesLegalVencido) return t("O prazo do art. 12.º, n.º 3 do RGPD (um mês) venceu.");
  return t("Prazo interno do sistema, mais curto que o prazo legal (RGPD: um mês, art. 12.º, n.º 3).");
}

/**
 * O mês legal do art. 12.º, n.º 3 do RGPD — um mês desde o recebimento do
 * pedido — já passou? (issue #2347, item 1.)
 *
 * O watcher reenvia o alarme todo dia enquanto o pedido não fecha, e num pedido
 * de 40 dias o rodapé continuava prometendo um prazo legal à frente.
 *
 * "Um mês" é um MÊS DE CALENDÁRIO, não 30 dias: 31/01 + um mês acaba em 28/02,
 * e não em 03/03 como o estouro de `Date` faria.
 *
 * ─── O último dia VALE ATÉ O FIM DELE ──────────────────────────────────────
 *
 * O Regulamento (CEE) n.º 1182/71 conta prazo em meses até o FIM do dia que
 * corresponde ao dia do evento inicial: pedido recebido em 20/08 às 12h tem o
 * mês do art. 12.º, n.º 3 até o fim de 20/09. A primeira versão somava um mês ao
 * INSTANTE (`setUTCMonth` na mesma hora) e anunciava vencimento legal às 12h de
 * 20/09, com o dia legal ainda correndo — e ao lado de um `due_at` que este
 * mesmo módulo lê como dia civil que vale até o fim do dia (`diasDeAtraso`).
 * Eram duas réguas para o mesmo prazo.
 *
 * Agora a conta devolve o DIA do último dia legal e quem decide é
 * `diasDeAtraso`, a mesma âncora dos outros prazos: só o dia civil seguinte
 * conta como vencido. `received_at` ausente ou inválido devolve `false`: sem
 * data não se afirma vencimento legal.
 */
function mesLegalDoPedidoVencido(receivedAt: string | null | undefined, agora: Date): boolean {
  const ultimoDia = ultimoDiaDoMesLegal(receivedAt);
  if (ultimoDia === null) return false;
  // `diasDeAtraso` casa a unidade com a do resto do alarme e a do `due_at`:
  // dias civis, contados a partir do dia seguinte ao do prazo. Comparar
  // instantes aqui reintroduziria a hora do recebimento como vencimento.
  return diasDeAtraso(ultimoDia, agora) > 0;
}

/**
 * O DIA (`YYYY-MM-DD`) do último dia do mês legal — o dia em que o prazo do
 * art. 12.º, n.º 3 ainda vale inteiro. `null` quando `received_at` não é data.
 *
 * O eixo é o mesmo do motor de prazo (`lib/lgpd/sla.ts`): dias civis em UTC, e
 * o prazo vale até o fim do dia guardado. Um mês de calendário que não existe
 * no mês seguinte é cortado no último dia dele (31/01 → 28/02).
 */
function ultimoDiaDoMesLegal(receivedAt: string | null | undefined): string | null {
  if (!receivedAt) return null;
  const recebidoMs = Date.parse(receivedAt);
  if (!Number.isFinite(recebidoMs)) return null;
  const recebido = new Date(recebidoMs);
  const ultimo = new Date(recebidoMs);
  ultimo.setUTCMonth(ultimo.getUTCMonth() + 1);
  if (ultimo.getUTCDate() !== recebido.getUTCDate()) {
    // O dia não existe no mês seguinte (31/01 → 03/03): o mês legal acaba no
    // ÚLTIMO dia do mês seguinte.
    ultimo.setUTCDate(0);
  }
  return diaDoPrazo(ultimo);
}

/**
 * O nome da organização e a marca passaram a vir de campos que uma pessoa
 * digita numa tela (`organizations.display_name`, `settings.branding`) — então
 * entram no HTML escapados. Antes desta fase o pior caso era o literal
 * `"DeskcommCRM"`.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
