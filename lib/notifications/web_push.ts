import webpush from "web-push";

import { roleAtLeast, type Role } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import { vapidPronto, vapidPublica, vapidSubject } from "./vapid";
import { ehServicoDePushConhecido } from "./servicos-de-push";
import type { PushPayload } from "./push_payload";
import { lerTelaBloqueada, redigirParaATelaBloqueada } from "./tela-bloqueada";

type Admin = ReturnType<typeof createAdminClient>;

export type PushSubRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

type Inscricao = PushSubRow & { user_id: string };

const NADA = { sent: 0, gone: 0 } as const;

/**
 * Quem tem vínculo ativo na organização — e, com `papelMinimo`, o papel que o
 * alcança. `null` quando a leitura falha: ninguém recebe.
 */
async function membrosAtivos(
  admin: Admin,
  organizationId: string,
  papelMinimo?: Role,
): Promise<Set<string> | null> {
  const { data, error } = await admin
    .from("user_organizations")
    .select("user_id, role")
    .eq("organization_id", organizationId)
    .is("revoked_at", null);
  if (error) {
    logger.warn("push_membros_ativos_falhou", { detail: error.message });
    return null;
  }
  const membros = (data ?? []) as Array<{ user_id: string; role: string | null }>;
  return new Set(
    membros.filter((m) => !papelMinimo || roleAtLeast(m.role, papelMinimo)).map((m) => m.user_id),
  );
}

/**
 * As inscrições da organização que calaram este tipo de aviso
 * (`push_subscriptions.tipos_calados`). Falha de leitura devolve o conjunto
 * vazio: um aviso a mais incomoda, um a menos deixa cliente sem resposta.
 */
async function inscricoesQueCalaram(
  admin: Admin,
  organizationId: string,
  tipo: NonNullable<PushPayload["tipo"]>,
): Promise<Set<string>> {
  const { data, error } = await admin
    .from("push_subscriptions")
    .select("id")
    .eq("organization_id", organizationId)
    .contains("tipos_calados", [tipo]);
  if (error) {
    logger.warn("push_tipos_calados_falhou", { detail: error.message });
    return new Set();
  }
  return new Set(((data ?? []) as Array<{ id: string }>).map((l) => l.id));
}

/**
 * O FUNIL: todo push do produto sai daqui, e só daqui (vigiado por
 * `tests/unit/push-sai-so-pelo-funil.test.ts`). Só sai para inscrições de quem
 * tem vínculo ativo na organização (e o papel mínimo, quando pedido), e só para
 * serviço de push conhecido (`servicos-de-push.ts`). Aparelho que calou o tipo
 * do aviso (`payload.tipo`) não recebe. A regra de host mora no
 * envio, não só na rota de inscrição: vale para toda linha gravada, qualquer
 * que seja a origem. O conteúdo segue a opção da empresa sobre o que aparece
 * com a tela bloqueada (`./tela-bloqueada.ts`). Inscrição morta (404/410) é
 * apagada.
 */
async function enviarAsInscricoes(
  admin: Admin,
  organizationId: string,
  inscricoes: Inscricao[],
  payload: PushPayload,
  papelMinimo?: Role,
): Promise<{ sent: number; gone: number }> {
  const conhecidas = inscricoes.filter((i) => ehServicoDePushConhecido(i.endpoint));
  if (conhecidas.length === 0) return NADA;
  const membros = await membrosAtivos(admin, organizationId, papelMinimo);
  if (!membros) return NADA;
  const caladas = payload.tipo ? await inscricoesQueCalaram(admin, organizationId, payload.tipo) : null;
  const rows = conhecidas.filter((i) => membros.has(i.user_id) && !caladas?.has(i.id));
  if (rows.length === 0) return NADA;

  const { modo, idioma } = await lerTelaBloqueada(admin, organizationId);
  const body = JSON.stringify(redigirParaATelaBloqueada(payload, modo, idioma));

  webpush.setVapidDetails(await vapidSubject(), vapidPublica()!, env.VAPID_PRIVATE_KEY.trim());

  let sent = 0;
  let gone = 0;

  await Promise.all(
    rows.map(async (row) => {
      try {
        await webpush.sendNotification(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          body,
        );
        sent += 1;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          gone += 1;
          await admin
            .from("push_subscriptions")
            .delete()
            .eq("id", row.id)
            .eq("organization_id", organizationId);
          return;
        }
        logger.warn("web_push_send_failed", { status: status ?? 0 });
      }
    }),
  );

  return { sent, gone };
}

export type DestinoDoPush = { soUsuario?: string; papelMinimo?: Role; excetoUsuario?: string };

/** Push às inscrições da organização — ou só às de `soUsuario` (sem as de `excetoUsuario`), e só a quem alcança `papelMinimo`. */
export async function enviarPushDaOrg(
  organizationId: string,
  payload: PushPayload,
  quem: DestinoDoPush = {},
  admin: Admin = createAdminClient(),
): Promise<{ sent: number; gone: number }> {
  if (!vapidPronto()) return NADA;

  let query = admin
    .from("push_subscriptions")
    .select("id, user_id, endpoint, p256dh, auth")
    .eq("organization_id", organizationId);
  if (quem.soUsuario) query = query.eq("user_id", quem.soUsuario);
  const { data, error } = await query;
  if (error) {
    logger.warn("push_subscriptions_list_failed", { detail: error.message });
    return NADA;
  }
  // `excetoUsuario` existe para não repetir o aviso a quem já recebeu um texto
  // PRÓPRIO no mesmo evento (o dono do negócio ganho, que tem a soma dele).
  const linhas = quem.excetoUsuario
    ? ((data ?? []) as Inscricao[]).filter((l) => l.user_id !== quem.excetoUsuario)
    : ((data ?? []) as Inscricao[]);
  return enviarAsInscricoes(admin, organizationId, linhas, payload, quem.papelMinimo);
}

export async function enviarPushAoUsuario(
  organizationId: string,
  userId: string,
  payload: PushPayload,
): Promise<{ sent: number; gone: number }> {
  return enviarPushDaOrg(organizationId, payload, { soUsuario: userId });
}

/**
 * Push de mensagem recebida: só às inscrições de quem PODE VER a conversa.
 *
 * Quem decide é `fn_can_view_conversation` (a RLS de `conversations`), avaliada
 * para cada inscrito por `fn_push_inscricoes_que_veem_a_conversa` — a regra não
 * é repetida aqui. Falha na leitura não envia a ninguém.
 *
 * `soUsuarios` é a lista de quem DEVE ser avisado (`./destinatarios-da-mensagem.ts`);
 * ela só estreita o conjunto, nunca alarga além de quem pode ver.
 */
export async function enviarPushAQuemVeAConversa(
  organizationId: string,
  conversationId: string,
  payload: PushPayload,
  soUsuarios?: ReadonlyArray<string>,
  admin: Admin = createAdminClient(),
): Promise<{ sent: number; gone: number }> {
  if (!vapidPronto() || soUsuarios?.length === 0) return NADA;
  const { data, error } = await admin.rpc("fn_push_inscricoes_que_veem_a_conversa", {
    p_org: organizationId,
    p_conversation: conversationId,
  });
  if (error) {
    logger.warn("push_subscriptions_visible_list_failed", { detail: error.message });
    return NADA;
  }
  // O admin client não é tipado pelo schema: a forma vem de `lib/database.types.ts`.
  const visiveis: Inscricao[] = data ?? [];
  const linhas = visiveis.filter((l) => !soUsuarios || soUsuarios.includes(l.user_id));
  return enviarAsInscricoes(admin, organizationId, linhas, payload);
}

/** A inscrição de quem vê o negócio, com a LARGURA do que a pessoa vê. */
type InscricaoQueVeONegocio = Inscricao & { ampla: boolean };

/**
 * Os textos do push da etapa que avisa, um por régua de visibilidade — o mesmo
 * aviso, com o número que cada pessoa veria na tela.
 */
export type TextosDaEtapa = {
  /** Quem vê a organização inteira (gestão): o valor e a soma do dia. */
  ampla: PushPayload;
  /** Quem vê só a própria carteira: o valor, sem a soma do dia — ela é da organização. */
  daCarteira: PushPayload;
  /** Quem NÃO vê o negócio: a frase de antes, sem valor nenhum. */
  semValor: PushPayload;
};

/**
 * Push da etapa que avisa, decidido por DESTINATÁRIO (#3981).
 *
 * O aviso vai à mesma audiência de sempre (todo membro ativo que alcança
 * `papelMinimo`), mas não com o mesmo texto: quem decide é `fn_can_view_lead`,
 * avaliada por inscrito em `fn_push_inscricoes_que_veem_o_negocio` — a régua de
 * negócio que a RLS de `crm_leads` já usa. Nenhuma cópia dela mora aqui.
 *
 *   - quem VÊ o negócio e vê a organização inteira (gestão) → `ampla`, com o
 *     valor e a soma do dia, que é um número da organização;
 *   - quem VÊ o negócio mas só a própria carteira (o dono fora do «Todos veem
 *     tudo») → `daCarteira`, com o valor do negócio e sem a soma do dia. A soma
 *     organizacional que ele não veria na tela não vai no bolso dele;
 *   - quem NÃO vê o negócio → `semValor`, a frase fixa de antes. O aviso
 *     continua chegando (alguém precisa atender), sem a carteira alheia.
 *
 * Falha ao perguntar quem vê: o aviso sai como antes da #3981 — `semValor` para
 * todos, valor para ninguém. Na dúvida o push diz menos, nunca mais.
 */
export async function enviarPushDaEtapaAQuemVeONegocio(
  organizationId: string,
  leadId: string,
  textos: TextosDaEtapa,
  papelMinimo: Role,
  admin: Admin = createAdminClient(),
): Promise<{ sent: number; gone: number }> {
  if (!vapidPronto()) return NADA;
  const { data, error } = await admin.rpc("fn_push_inscricoes_que_veem_o_negocio", {
    p_org: organizationId,
    p_lead: leadId,
  });
  if (error) {
    logger.warn("push_inscricoes_que_veem_o_negocio_falhou", { detail: error.message });
    return enviarPushDaOrg(organizationId, textos.semValor, { papelMinimo }, admin);
  }
  const veem = (data ?? []) as InscricaoQueVeONegocio[];
  const daGestao = await enviarAsInscricoes(
    admin,
    organizationId,
    veem.filter((l) => l.ampla),
    textos.ampla,
    papelMinimo,
  );
  const daCarteira = await enviarAsInscricoes(
    admin,
    organizationId,
    veem.filter((l) => !l.ampla),
    textos.daCarteira,
    papelMinimo,
  );

  // O resto da audiência: quem não vê o negócio. A lista sai da MESMA tabela de
  // inscrições e é só o complemento de quem viu — nunca uma segunda régua.
  const { data: todas, error: erroDaLista } = await admin
    .from("push_subscriptions")
    .select("id, user_id, endpoint, p256dh, auth")
    .eq("organization_id", organizationId);
  if (erroDaLista) {
    // Sem saber quem sobrou, o aviso não sai para eles — a direção segura é a
    // que não manda valor a ninguém; os de cima já receberam o texto certo.
    logger.warn("push_subscriptions_list_failed", { detail: erroDaLista.message });
    return { sent: daGestao.sent + daCarteira.sent, gone: daGestao.gone + daCarteira.gone };
  }
  const idsQueVeem = new Set(veem.map((l) => l.user_id));
  const naoVeem = ((todas ?? []) as Inscricao[]).filter((l) => !idsQueVeem.has(l.user_id));
  const fixo = await enviarAsInscricoes(admin, organizationId, naoVeem, textos.semValor, papelMinimo);

  return {
    sent: daGestao.sent + daCarteira.sent + fixo.sent,
    gone: daGestao.gone + daCarteira.gone + fixo.gone,
  };
}
