/**
 * POST /api/v1/voice/sessions/pair — inicia (ou reinicia) o pareamento de
 * chamada de voz WhatsApp da organização.
 *
 * Segundo dispositivo vinculado no MESMO número WhatsApp da sessão de mensagens já
 * pareada — risco aceito, opt-in por org, decisão de produto §1.2 da spec
 * docs/specs/18-spec-voice-calls-wacalls.md. Admin only, igual a
 * channel-sessions/[id]/reconnect.
 *
 * ═══ ESTA ROTA NUNCA CHAMA `POST /api/sessions/{sid}/pair` DO WACALLS ═══
 *
 * `POST /api/sessions` já inicia o pareamento por dentro (`Manager.Create` →
 * `startPairing`). O `/pair` do upstream existe para RE-parear uma sessão viva,
 * e faz isso trocando o cliente whatsmeow (`replaceClient`) — sem refazer o
 * subsistema de chamadas, que fica amarrado ao cliente antigo, já
 * desconectado. Medido na VPS em 2026-09-15: a versão anterior chamava
 * `createSession` e `pairSession` em sequência, o QR que a pessoa lia era o do
 * SEGUNDO cliente, e toda ligação morria em "websocket not connected" até
 * alguém reiniciar o contêiner. O racional inteiro está no cabeçalho de
 * `wacallsSemConexao` (`lib/wacalls/client.ts`).
 *
 * Então: sessão nova = `createSession`, e só. Sessão que existe mas nunca
 * pareou (QR venceu, aba fechada, restart do WaCalls — que descarta sessão sem
 * JID ao subir) = apagar a antiga e criar outra. Sessão pareada = 409; a saída
 * é `DELETE /api/v1/voice/sessions`, que desloga e apaga.
 *
 * ═══ "PAREADA" É PERGUNTADO AO WACALLS, NÃO SÓ AO BANCO ═══
 *
 * Quem grava `wacalls_paired_at` é a ponte do WORKER. Worker reiniciando, ou
 * só atrasado, e o banco diz "não pareada" para um aparelho que a pessoa acabou
 * de vincular — a tela oferece "Parear" de novo, e apagar a sessão ali DESLOGA
 * o aparelho (`Manager.Delete` chama `Logout` quando há JID). Por isso a rota
 * lê `GET /api/sessions` antes de apagar qualquer coisa: sessão pareada lá é
 * gravada aqui e responde 409, nunca vai para o lixo. A mesma leitura limpa as
 * sessões órfãs com o nome desta organização — as que uma tentativa anterior
 * criou e não conseguiu registrar —, para o relay não repassar QR delas.
 *
 * O QR não volta nesta resposta: o WaCalls empurra por SSE, relayado pra tela
 * via `GET /api/v1/voice/events`. A tela abre a stream ANTES deste POST, e o
 * relay reconhece a sessão pelo NOME (`nomeDaSessaoDeVoz`) no `session-list`
 * que o broker emite na criação — por isso o primeiro QR não se perde mesmo
 * saindo antes de o banco conhecer o id.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { exigirVozLigada } from "@/lib/voice/guarda";
import {
  getWacallsClient,
  wacallsFriendlyError,
  type WacallsClient,
  type WacallsSessionInfo,
} from "@/lib/wacalls/client";
import { nomeDaSessaoDeVoz } from "@/lib/wacalls/nome-da-sessao";

export const dynamic = "force-dynamic";

/**
 * O corpo não tem campos: `prepare_only`, da versão anterior, foi embora junto
 * com o passo que ele servia. Uma aba antiga que ainda o mande cai no fluxo
 * normal — e o Zod descarta a chave, em vez de mantê-la como controle
 * decorativo.
 */
const PareamentoSchema = z.object({});

/**
 * Apaga a sessão que nunca pareou, tolerando que o WaCalls já não a conheça:
 * `Manager.Restore` descarta, ao subir, toda sessão sem JID — então depois de
 * um restart o id gravado no banco aponta para o nada, e o 404 daqui é o caso
 * normal, não erro.
 */
/** O WaCalls conta como pareada a sessão com JID mesmo quando `paired` ainda não subiu. */
function pareadaNoWacalls(sessao: WacallsSessionInfo): boolean {
  return sessao.paired || !!sessao.jid;
}

async function descartarSessaoNaoPareada(wacalls: WacallsClient, sessionId: string): Promise<void> {
  try {
    await wacalls.deleteSession(sessionId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.startsWith("wacalls_404")) throw err;
  }
}

export async function POST(request: Request): Promise<Response> {
  // Acompanhamento administrativo somente-leitura não liga, não atende, não
  // desliga e não pareia: o efeito é do tenant, não de quem observa.
  const suporteNegado = await requireSupportWrite();
  if (suporteNegado) return suporteNegado;

  const requestId = randomUUID();

  const authz = await requireRole("admin", {
    requestId,
    resource: "channel_sessions",
    allowPlatformAdmin: true,
  });
  if (!authz.ok) return authz.response;
  const { user, org: activeOrg } = authz;

  try {
    const texto = await request.text();
    const corpo = PareamentoSchema.safeParse(texto ? JSON.parse(texto) : {});
    if (!corpo.success) {
      return fail("invalid_request", "Opções de pareamento inválidas.", 400, { requestId });
    }
  } catch {
    return fail("invalid_request", "Corpo da solicitação inválido.", 400, { requestId });
  }

  const wacalls = getWacallsClient();
  if (!wacalls) {
    return fail(
      "wacalls_not_configured",
      "Configure o endereço e a credencial do serviço de voz: WACALLS_API_BASE_URL e WACALLS_API_TOKEN.",
      503,
      { requestId },
    );
  }

  const supabase = await createClient();

  // ⚠️ O CONSENTIMENTO É EXIGIDO AQUI, e este é o lugar certo: parear é o ato
  // que CRIA a exposição — a partir dele existe um segundo aparelho vinculado
  // ao número da empresa, com o risco de o WhatsApp bloquear a CONTA inteira.
  //
  // Sem esta linha, o interruptor de Configurações › Segurança era decorativo
  // pelo caminho de entrada: a tela pedia "eu li o aviso e aceito o risco",
  // e quem fosse direto a Conexões pareava sem passar por ela. Desligar
  // continuava real (o PUT do opt-in despareia de verdade), mas LIGAR nunca foi
  // necessário — e um consentimento que dá para pular não é consentimento.
  //
  // O que NÃO ganha esta guarda, de propósito: `DELETE /sessions` (desparear),
  // `reject` e `hangup`. A porta de saída nunca depende do interruptor — é a
  // mesma razão escrita no cabeçalho da rota de DELETE.
  // `instalacaoOferece: true` porque o `getWacallsClient()` acima já provou
  // o fato e já devolveu 503 se fosse falso — a guarda não o relê pelo env.
  const vozDesligada = await exigirVozLigada(supabase, activeOrg.orgId, {
    requestId,
    instalacaoOferece: true,
  });
  if (vozDesligada) return vozDesligada;

  const { data: existingRaw } = await supabase
    .from("channel_sessions")
    .select("id, wacalls_session_id, wacalls_paired_at")
    .eq("organization_id", activeOrg.orgId)
    .eq("provider", "wacalls")
    .is("archived_at", null)
    .maybeSingle();
  const existing = existingRaw as {
    id: string;
    wacalls_session_id: string | null;
    wacalls_paired_at: string | null;
  } | null;

  if (existing?.wacalls_paired_at) {
    // Re-parear por cima de um aparelho vinculado é exatamente o `/pair` que
    // este arquivo existe para não chamar. Quem quer trocar de número
    // desconecta primeiro (`DELETE /api/v1/voice/sessions`).
    return jaPareada(requestId);
  }

  const nome = nomeDaSessaoDeVoz(activeOrg.orgId);
  // A sessão criada NESTA requisição, enquanto o banco ainda não a conhece.
  // Se o registro falhar, ela é desfeita no `catch` — sem isto ficava no
  // WaCalls uma sessão com o nome desta organização em laço de QR, que o relay
  // repassaria à tela junto com a verdadeira.
  let criadaSemRegistro: string | null = null;

  try {
    let channelSessionId = existing?.id ?? null;

    // Falha aqui é 502 e NADA é apagado: sem saber o estado do WaCalls, apagar
    // pode deslogar um aparelho vinculado.
    const noWacalls = await wacalls.listSessions();

    const pareada = noWacalls.find(
      (s) =>
        pareadaNoWacalls(s) &&
        (s.id === existing?.wacalls_session_id || s.name === nome),
    );
    if (pareada) {
      // O banco estava atrasado. Grava o que o WaCalls já sabe e devolve 409 —
      // a tela recarrega o estado e passa a dizer "pareado".
      const agora = new Date().toISOString();
      const vinculo = {
        wacalls_session_id: pareada.id,
        wacalls_paired_at: agora,
        wacalls_jid: pareada.jid || null,
        status: "WORKING",
        last_status_change_at: agora,
      };
      const { error: recErr } = channelSessionId
        ? await supabase
            .from("channel_sessions")
            .update(vinculo)
            .eq("id", channelSessionId)
            .eq("organization_id", activeOrg.orgId)
        : await supabase.from("channel_sessions").insert({
            organization_id: activeOrg.orgId,
            provider: "wacalls",
            webhook_secret_encrypted: Buffer.from([0]),
            ...vinculo,
          });
      if (recErr) throw new Error(`channel_sessions reconcile: ${recErr.message}`);
      logger.warn("wacalls: pareamento pedido para sessão já pareada no serviço de voz", {
        request_id: requestId,
        organization_id: activeOrg.orgId,
      });
      return jaPareada(requestId);
    }

    const descartadas: string[] = [];
    for (const s of noWacalls) {
      const minha = s.id === existing?.wacalls_session_id || s.name === nome;
      if (!minha) continue;
      await descartarSessaoNaoPareada(wacalls, s.id);
      descartadas.push(s.id);
    }

    const created = await wacalls.createSession(nome);
    const wacallsSessionId = created.id;
    criadaSemRegistro = wacallsSessionId;

    if (channelSessionId) {
      const { error: updErr } = await supabase
        .from("channel_sessions")
        .update({ wacalls_session_id: wacallsSessionId, status: "STARTING" })
        .eq("id", channelSessionId)
        .eq("organization_id", activeOrg.orgId);
      if (updErr) throw new Error(`channel_sessions update: ${updErr.message}`);
    } else {
      // webhook_path_token/webhook_secret_encrypted são NOT NULL na tabela
      // mas não fazem sentido pra este provider — o WaCalls empurra estado
      // por SSE (§4.2 da spec), não webhook HMAC. Mesmo placeholder que
      // onboarding/whatsapp/session/route.ts usa quando o fluxo não assina:
      // path_token cai no DEFAULT do banco, secret é 1 byte zero (bytea).
      //
      // `engine` NÃO entra: `channel_sessions_engine_check` só aceita
      // NOWEB/WEBJS (vocabulário do transporte principal) — omitido, cai no DEFAULT
      // 'NOWEB' da coluna, que não significa nada pra este provider mas
      // satisfaz o CHECK. Mesmo padrão do canal oficial/parceiro, que
      // também não grava `engine`.
      const { data: inserted, error: insertErr } = await supabase
        .from("channel_sessions")
        .insert({
          organization_id: activeOrg.orgId,
          provider: "wacalls",
          wacalls_session_id: wacallsSessionId,
          status: "STARTING",
          webhook_secret_encrypted: Buffer.from([0]),
        })
        .select("id")
        .single();
      if (insertErr || !inserted)
        throw new Error(`channel_sessions insert: ${insertErr?.message}`);
      channelSessionId = (inserted as { id: string }).id;
    }
    criadaSemRegistro = null;

    void audit({
      action: "voice.session_pair_started",
      actorUserId: user.id,
      organizationId: activeOrg.orgId,
      resourceType: "channel_session",
      resourceId: channelSessionId,
      requestId,
      metadata: { wacalls_session_id: wacallsSessionId, descartadas },
    });

    return ok({ channelSessionId, wacallsSessionId }, { requestId });
  } catch (err) {
    logger.error("wacalls: pareamento falhou", {
      request_id: requestId,
      organization_id: activeOrg.orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    if (criadaSemRegistro) {
      // Sessão recém-criada, sem QR lido ainda (a resposta nem chegou à tela):
      // apagá-la não desloga ninguém.
      await descartarSessaoNaoPareada(wacalls, criadaSemRegistro).catch((erroAoDesfazer: unknown) => {
        logger.error("wacalls: sessão criada sem registro não pôde ser desfeita", {
          request_id: requestId,
          organization_id: activeOrg.orgId,
          error: erroAoDesfazer instanceof Error ? erroAoDesfazer.message : String(erroAoDesfazer),
        });
      });
    }
    return fail("wacalls_error", wacallsFriendlyError(err), 502, { requestId });
  }
}

function jaPareada(requestId: string): Response {
  return fail(
    "voice_already_paired",
    "A chamada de voz já está pareada. Desconecte o número antes de parear outro.",
    409,
    { requestId },
  );
}
