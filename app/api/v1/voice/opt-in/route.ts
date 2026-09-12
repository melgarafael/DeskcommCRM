/**
 * GET/PUT /api/v1/voice/opt-in — a chamada de voz desta organização está ligada?
 *
 * ═══ O QUE ESTA ROTA LIGA, E POR QUE ELA EXISTE ═══
 *
 * A chamada de voz (spec 18) vincula um SEGUNDO APARELHO ao mesmo número de
 * WhatsApp que já atende, por um caminho que não é o oficial. O risco não é o
 * aparelho ser desconectado — é a CONTA ser bloqueada, e com ela o canal onde a
 * empresa vende.
 *
 * Antes desta rota a única trava era "ninguém escaneou o QR ainda", e a aba
 * aparecia para todo admin de toda instalação. Isso não é opt-in: é a decisão
 * sendo tomada por quem nunca foi perguntado.
 *
 * ═══ DUAS PERGUNTAS, NÃO UMA ═══
 *
 * `WACALLS_API_BASE_URL` responde CAPACIDADE (o serviço está de pé?), a linha
 * em `org_voice_calls` responde CONSENTIMENTO (esta organização aceita?). A
 * combinação é `&&`, e o argumento inteiro está em `lib/voice/opt-in.ts`. O GET
 * devolve as duas separadas de propósito: sem isso a tela diria "desligada" e
 * mandaria o admin clicar um botão que não resolveria nada quando o problema é
 * a instalação.
 *
 * ═══ CLIENT DE SESSÃO, NÃO SERVICE ROLE ═══
 *
 * `org_voice_calls` tem `org_voice_calls_select`/`org_voice_calls_admin_write`
 * via `fn_user_org_ids()` + `fn_role_at_least` (migration 0234), então a RLS já
 * faz a tenancy E o papel. Service role aqui trocaria uma garantia do banco por
 * um filtro manual — a vizinhança do anti-pattern 10 do CLAUDE.md. O filtro por
 * `organization_id` continua explícito no SQL porque o usuário pode pertencer a
 * mais de uma organização, e a RLS deixaria passar as duas.
 */
import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { env } from "@/lib/env";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { despareaVoz } from "@/lib/voice/desparear";
import { lerEscolhaDaOrg } from "@/lib/voice/guarda";
import { estadoDaVoz, instalacaoOfereceVoz } from "@/lib/voice/opt-in";
import { getWacallsClient, wacallsFriendlyError } from "@/lib/wacalls/client";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "org_voice_calls" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const db = await createClient();

  // Falha FECHADA na informação de estado: dizer "ligada" porque a leitura
  // estourou faria a tela oferecer parear um número cujo consentimento ninguém
  // conseguiu confirmar.
  let escolha, riscoAceitoEm;
  try {
    ({ escolha, riscoAceitoEm } = await lerEscolhaDaOrg(db, org.orgId));
  } catch (err) {
    return fail("read_failed", err instanceof Error ? err.message : String(err), 500, {
      requestId,
    });
  }

  const estado = estadoDaVoz(escolha, instalacaoOfereceVoz(env.WACALLS_API_BASE_URL));

  return ok(
    { ...estado, riscoAceitoEm, podeEditar: roleAtLeast(org.role, "admin") },
    { requestId },
  );
}

const corpoDoPut = z.object({
  enabled: z.boolean(),
  /**
   * Ligar exige aceitar o risco EXPLICITAMENTE, no mesmo corpo.
   *
   * Não é cerimônia: é o que separa "o admin leu o que pode acontecer com a
   * conta" de "alguém chamou a rota". Desligar nunca exige nada — pôr atrito
   * para sair de uma decisão de risco é o desenho errado.
   */
  riscoAceito: z.boolean().optional(),
});

export async function PUT(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("admin", { requestId, resource: "org_voice_calls" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  const parsed = corpoDoPut.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_body", t("corpo inválido"), 422, {
      requestId,
      details: parsed.error.issues,
    });
  }
  const corpo = parsed.data;

  if (corpo.enabled && !corpo.riscoAceito) {
    return fail(
      "voice_risco_nao_aceito",
      t(
        "Para ligar a chamada de voz é preciso aceitar o risco de vincular um segundo aparelho ao seu número.",
      ),
      422,
      { requestId },
    );
  }

  // Ligar num ambiente sem o serviço grava uma escolha que não vira capacidade
  // nenhuma, e a tela mostraria "ligada" com o botão de parear devolvendo 503.
  // Recusar aqui é dizer a verdade uma vez, em vez de mentir e falhar depois.
  if (corpo.enabled && !instalacaoOfereceVoz(env.WACALLS_API_BASE_URL)) {
    return fail(
      "voice_indisponivel_na_instalacao",
      t(
        "A chamada de voz não está disponível neste servidor. Quem administra a instalação precisa ligá-la antes.",
      ),
      503,
      { requestId },
    );
  }

  const db = await createClient();

  // ═══ DESLIGAR DESCONECTA DE VERDADE ═══
  //
  // Gravar `enabled=false` e parar aí esconderia a aba e deixaria o segundo
  // aparelho vinculado ao número, do lado do WhatsApp, para sempre — o
  // interruptor viraria um rótulo sobre nada, e o risco que ele existe para
  // encerrar continuaria correndo.
  //
  // Vem ANTES da escrita de propósito: se o WaCalls falhar, a organização
  // continua marcada como ligada e a pessoa vê o erro. O contrário — gravar
  // "desligada" e falhar em desconectar — deixaria a tela dizendo que o risco
  // acabou com o aparelho ainda lá.
  let aparelhoDesconectado = false;
  if (!corpo.enabled) {
    const wacalls = getWacallsClient();
    if (wacalls) {
      try {
        const resultado = await despareaVoz(db, wacalls, org.orgId);
        aparelhoDesconectado = resultado.desapareado;
        if (resultado.desapareado) {
          void audit({
            action: "voice.session_unpaired",
            actorUserId: user.id,
            organizationId: org.orgId,
            resourceType: "channel_session",
            resourceId: resultado.channelSessionId,
            requestId,
            metadata: { origem: "desligou_a_feature" },
          });
        }
      } catch (err) {
        logger.error("wacalls: desligar a feature não conseguiu desparear", {
          request_id: requestId,
          organization_id: org.orgId,
          error: err instanceof Error ? err.message : String(err),
        });
        return fail("wacalls_error", wacallsFriendlyError(err), 502, { requestId });
      }
    }
    // `wacalls === null` (instalação sem o serviço) NÃO bloqueia o desligamento:
    // não há a quem pedir o logout, e impedir a organização de registrar que não
    // quer mais a feature seria prendê-la na decisão por causa da configuração
    // de outra pessoa.
  }

  const agora = new Date().toISOString();
  const { data: gravado, error } = await db
    .from("org_voice_calls")
    .upsert(
      {
        organization_id: org.orgId,
        enabled: corpo.enabled,
        // Desligar não apaga quem aceitou: o rastro de que alguém autorizou
        // aquilo um dia é o que responde "quem foi" depois de um bloqueio.
        ...(corpo.enabled ? { risco_aceito_em: agora, risco_aceito_por: user.id } : {}),
        updated_at: agora,
      },
      { onConflict: "organization_id" },
    )
    .select("enabled, risco_aceito_em")
    .maybeSingle();

  if (error) return fail("save_failed", error.message, 500, { requestId });
  if (!gravado) {
    // Upsert que casa zero linhas devolve SUCESSO no PostgREST — a tela diria
    // "salvo" sem nada ter sido gravado. Mesmo cuidado da rota de guardrails.
    return fail(
      "save_failed",
      t("nada foi gravado — verifique as permissões da organização"),
      500,
      { requestId },
    );
  }

  void audit({
    action: "voice.opt_in_changed",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "org_voice_calls",
    // A chave é a própria organização — não há uuid de recurso a referenciar.
    resourceId: null,
    requestId,
    metadata: { enabled: corpo.enabled },
  });

  // `aparelhoDesconectado` viaja porque a TELA não pode inventá-lo. Sem este
  // campo ela diria "e o aparelho foi desconectado" também no caso em que não
  // havia serviço a quem pedir o logout — uma frase tranquilizadora sobre algo
  // que não aconteceu, exatamente onde o assunto é risco.
  return ok({ ...gravado, aparelhoDesconectado }, { requestId });
}
