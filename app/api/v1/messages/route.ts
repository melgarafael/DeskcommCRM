import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/messages — envia mensagem outbound (handler em ./_handler.ts).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ESCOPO_MENSAGENS_INSTITUCIONAIS, tokenTemEscopo } from "@/lib/api/escopos-do-token";
import { MODO_DE_ENVIO_INSTITUCIONAL } from "@/lib/messaging/modo-de-envio";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { resolveAuthDual } from "@/lib/api/auth-dual";
import { ApiErrorCodes } from "@/lib/api/errors";
import { FRASES_DE_FALHA } from "@/lib/channels/frases-de-falha";
import { chaveDaRequisicao, comIdempotencia, type DesfechoIdempotente } from "@/lib/api/idempotency";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { roleAtLeast } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { assumirConversaAposEnvio } from "@/lib/inbox/assumir-conversa-apos-envio";
import { JANELA_SEGUNDOS, TETO_DE_ESCRITA, TETO_POR_ORGANIZACAO } from "@/lib/mcp/rate-limit";
import { openSharedContactConversation } from "@/lib/messaging/open-shared-contact-conversation";
import {
  depsDoRitmo,
  registrarEnvioPorToken,
  segurarEnvioPorToken,
  type EnvioSegurado,
} from "@/lib/messaging/ritmo-do-envio-por-token";
import {
  sendMessagePorTelefoneSchema,
  validateRequest,
  type SendMessageInput,
  type SendMessagePorTelefoneInput,
} from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Message } from "@/lib/types/messaging";

import { sendMessageHandler } from "./_handler";

export const dynamic = "force-dynamic";

/**
 * Tag do endpoint no recibo de idempotência (#1613, item A). Muda de rota muda
 * de recibo — e o método entra na tag porque a MESMA rota com GET não guarda
 * envio nenhum.
 */
const ENDPOINT = "POST /api/v1/messages";
/** Escopo que o token precisa para enviar `on_behalf_of_user_id` (#1613, item C). */
const SCOPE_EM_NOME_DE = "messages:on_behalf";
/** Papel mínimo de quem é apontado "em nome de": atendente ou acima. */
const PAPEL_MINIMO_EM_NOME_DE = "agent";

/**
 * ─── A PORTA POR TELEFONE (#4513) ───────────────────────────────────────────
 *
 * O conector do DeskVoice manda `{ "to": "+55…", "text": "…", "callId": "…" }`;
 * esta rota pedia `conversation_id` e as duas pontas nunca se encontravam. O
 * que faltava era a PORTA, não a regra: achar/criar o contato pelas grafias do
 * número e abrir (ou reabrir) a conversa 1:1 já é
 * `openSharedContactConversation` — o MESMO ponto único de
 * `POST /api/v1/conversations/open-with-contact` e da tool MCP
 * `crm_start_conversation_and_send` (`lib/mcp/tools/start-conversation.ts`).
 * Nada de `upsert` paralelo: um contato, um caminho.
 *
 * O cliente é o ADMIN, e não o da sessão, por medição e não por hábito: quem
 * grava o contato é `fn_upsert_wa_contact`, cujo `grant execute` é de
 * `service_role` só (`20260805180000_0108_revoke_definido_exposto.sql`). O
 * isolamento por organização não vem do RLS nesse caminho — vem do
 * `organization_id` que `encontrarContatoPorTelefone` filtra em toda consulta.
 * A organização é SEMPRE a da autenticação (`authz.organizationId`), nunca um
 * campo do corpo: o corpo não tem onde trazer organização.
 *
 * O freio anti-ban entra DEPOIS desta resolução, e isso é deliberado: ele
 * pergunta a sessão pela CONVERSA (`segurarEnvioPorToken`), e a conversa só
 * existe depois daqui. A consequência é conhecida e pequena: um envio
 * segurado pelo teto diário pode deixar a conversa do contato aberta, vazia —
 * o mesmo estado que "iniciar conversa" deixa no inbox, e não uma conversa
 * órfã de um contato que não existe.
 *
 * ─── DE QUAL NÚMERO (#5028) ────────────────────────────────────────────────
 *
 * `channel_session_id` no corpo chega até aqui e é repassado ao helper, que já
 * sabe a regra (#3483/:107): sessão escolhida é procurada com
 * `organization_id` E `id`, e precisa estar utilizável. A organização continua
 * sendo só a da autenticação — o corpo não tem onde trazer outra.
 *
 * A recusa MUDA DE NÚMERO quando houve canal escolhido: 422
 * `validation_error` com `campo: "channel_session_id"`, tanto para "não
 * encontrada" quanto para "fora do ar". Não é capricho: 404 e 409 distinguem
 * os dois casos, e a diferença entre eles é justamente o que diz se a sessão
 * existe em OUTRA organização. Sem canal escolhido, 404/409 seguem como
 * sempre — o caminho antigo não ganha tradução nova.
 */
async function conversaDoTelefone(p: {
  organizationId: string;
  telefone: string;
  /** O canal que quem chamou escolheu (#5028); ausente = a escolha de sempre. */
  canalEscolhido?: string;
  requestId: string;
  t: (texto: string) => string;
}): Promise<string> {
  try {
    const aberta = await openSharedContactConversation(createAdminClient(), p.organizationId, {
      phone_number: p.telefone.trim(),
      // Ausente continua ausente: o helper distingue "escolhida pelo chamador"
      // de "escolha de sempre" por `Boolean(input.channel_session_id)`.
      ...(p.canalEscolhido ? { channel_session_id: p.canalEscolhido } : {}),
    });
    return aberta.conversation_id;
  } catch (err) {
    // As recusas são as MESMAS da rota irmã `open-with-contact`, com os mesmos
    // números: o helper é um só, então a tradução de erro também é. Recusa
    // nomeada aqui é o que o conector precisa para distinguir "número ruim"
    // (422, não adianta retentar) de "canal fora do ar" (409, retentar depois).
    const motivo = err instanceof Error ? err.message : "open_failed";
    // #5028: com canal ESCOLHIDO, 404 e 409 viram o MESMO 422 — a diferença
    // entre eles revelaria se a sessão existe em outra organização. O detalhe
    // nomeia o campo, para quem integra corrigir o corpo em vez de adivinhar.
    if (
      p.canalEscolhido &&
      (motivo === "session_not_found" || motivo === "session_unavailable")
    ) {
      throw new ApiError(
        422,
        "validation_error",
        { campo: "channel_session_id" },
        p.requestId,
        p.t(
          "Canal informado indisponível: ele precisa existir nesta organização e estar conectado.",
        ),
      );
    }
    if (motivo === ApiErrorCodes.numero_sem_whatsapp) {
      throw new ApiError(
        422,
        ApiErrorCodes.numero_sem_whatsapp,
        undefined,
        p.requestId,
        p.t(FRASES_DE_FALHA.numero_sem_whatsapp!),
      );
    }
    if (motivo === "invalid_phone") {
      throw new ApiError(
        422,
        "validation_error",
        { campo: "phone_number" },
        p.requestId,
        p.t("Telefone inválido."),
      );
    }
    if (motivo === "session_not_found") {
      throw new ApiError(
        404,
        "not_found",
        undefined,
        p.requestId,
        p.t("Sessão de canal não encontrada."),
      );
    }
    if (motivo === "session_unavailable") {
      throw new ApiError(
        409,
        "state_conflict",
        undefined,
        p.requestId,
        p.t("Este canal está desligado ou fora do ar. Reative a conexão ou escolha outro canal."),
      );
    }
    if (motivo === "contact_personal") {
      throw new ApiError(403, "forbidden", undefined, p.requestId, p.t("Contato marcado como pessoal."));
    }
    throw new ApiError(
      500,
      "internal_error",
      undefined,
      p.requestId,
      p.t("Não foi possível abrir a conversa deste telefone."),
    );
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  // spec 13 §4: escrita é agent+ (viewer é read-only).
  //
  // Aceita sessão de navegador OU token de servidor (`dsk_…` com `mcp:write`),
  // porque esta rota é a porta de envio de quem não tem navegador: o gateway do
  // CRM que está sendo absorvido, e qualquer integração server-to-server. A org
  // nunca vem do corpo; no ramo do token ela sai da linha do token.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "messages",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const { supabase, organizationId, actor, idioma } = authz;

  // O corpo aceita UM DOS DOIS identificadores (#4513): `conversation_id`, como
  // sempre, ou `phone_number` — o que o conector do DeskVoice manda. O schema
  // exige pelo menos um; quem recusa os dois juntos é o bloco logo abaixo.
  let entrada: SendMessagePorTelefoneInput;
  try {
    entrada = await validateRequest(sendMessagePorTelefoneSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const t = (texto: string) => traduzir(texto, idioma ?? "pt-BR");

  /**
   * ─── Os dois identificadores juntos são AMBIGUIDADE (#4513) ───────────────
   *
   * "O `conversation_id` vence" seria uma escolha, e uma escolha aqui é uma
   * adivinhação: quem manda os dois está dizendo duas coisas diferentes, e a
   * que perder virou engano silencioso — o telefone aponta para o contato B e o
   * id para a conversa do contato A. A mensagem sai pelo caminho que ninguém
   * pediu e ninguém descobre até o cliente responder.
   *
   * Então a recusa é NOMEADA (`ambiguous_target`), com 422, antes de qualquer
   * efeito: nem teto, nem freio, nem conversa aberta, nem recibo de
   * idempotência. Quem integra corrige o corpo e retenta com a mesma chave.
   */
  if (entrada.conversation_id && entrada.phone_number?.trim()) {
    return fail(
      "ambiguous_target",
      t("Informe conversation_id ou phone_number — os dois juntos não dizem para qual conversa enviar."),
      422,
      { requestId, details: { campos: ["conversation_id", "phone_number"] } },
    );
  }

  // Idempotency-Key, quando vem, tem de ser UUID — mesma régua de
  // `message-templates` e do contrato (spec 01 §7.3). Chave malformada não vira
  // recibo: recusar cedo é mais honesto que gravar lixo e devolver 201.
  const chave = chaveDaRequisicao(req);
  if (chave !== null && !z.string().uuid().safeParse(chave).success) {
    return fail("validation_error", "Idempotency-Key deve ser UUID", 400, { requestId });
  }

  /**
   * ─── Item C: autoria "em nome de" (#1613) ─────────────────────────────────
   *
   * O token é da organização, não de uma pessoa. Quando a mensagem foi
   * DECIDIDA por alguém no outro sistema, a conversa tem de guardar quem
   * decidiu — sem forjar autoria: o token continua sendo quem envia, e a
   * pessoa entra como "em nome de".
   *
   * Duas checagens, e nenhuma vem do corpo: o escopo mora na LINHA DO TOKEN e
   * o membership, no banco. Quem não tem escopo não grava nada; quem aponta
   * para usuário de outra organização, revogado ou abaixo de atendente não
   * passa daqui — e o handler ainda recusa alto se o campo chegar sem este
   * ctx, porque a mesma entrada atravessa o MCP (item B, fora deste PR).
   */
  const ehInstitucional = entrada.dispatch_mode === MODO_DE_ENVIO_INSTITUCIONAL;
  if (ehInstitucional) {
    if (authz.actor.type === "ai_agent") {
      return fail("forbidden", t("Agentes de IA não podem enviar mensagens institucionais."), 403, {
        requestId,
      });
    }
    if (authz.via !== "token" || !tokenTemEscopo(authz.scopes, ESCOPO_MENSAGENS_INSTITUCIONAIS)) {
      return fail("forbidden", t("Envio institucional exige o escopo messages:institutional."), 403, {
        requestId,
      });
    }
    if (entrada.on_behalf_of_user_id) {
      return fail(
        "validation_failed",
        t("Mensagens institucionais não podem ser enviadas em nome de um atendente."),
        422,
        { requestId },
      );
    }
    if (!entrada.conversation_id || Boolean(entrada.phone_number?.trim())) {
      return fail(
        "validation_failed",
        t("Mensagens institucionais exigem conversation_id explícito de uma conversa ativa e não aceitam phone_number."),
        422,
        { requestId },
      );
    }
  }

  let onBehalf: HandlerCtx["onBehalfOf"];
  if (entrada.on_behalf_of_user_id) {
    // A sessão do navegador não tem escopos — e não precisa: quem digita no
    // CRM já É a pessoa, e "em nome de" só existe para quem envia por token.
    if (authz.via !== "token" || !(authz.scopes ?? []).includes(SCOPE_EM_NOME_DE)) {
      return fail(
        "forbidden",
        t("Envio em nome de outro usuário exige o escopo messages:on_behalf."),
        403,
        { requestId },
      );
    }

    // Membro ATIVO desta organização com papel de atendente ou acima. A org
    // vem da linha do token, então usuário de OUTRA organização não é nem
    // encontrado — a pergunta "é daqui?" já está no filtro. `roleAtLeast` não
    // decide o gate da rota (isso foi `requireRole` lá em cima): é a régua do
    // ALVO, a mesma que as rotas usam para regra extra sobre um role já
    // resolvido.
    const { data: membro, error: erroDeMembro } = await supabase
      .from("user_organizations")
      .select("user_id, role, revoked_at")
      .eq("organization_id", organizationId)
      .eq("user_id", entrada.on_behalf_of_user_id)
      .is("revoked_at", null)
      .maybeSingle();
    if (erroDeMembro) {
      return fail(
        "internal_error",
        t("Não foi possível ler o membro apontado em on_behalf_of_user_id."),
        500,
        { requestId },
      );
    }
    const papel = (membro as { role?: string } | null)?.role;
    if (!papel || !roleAtLeast(papel, PAPEL_MINIMO_EM_NOME_DE)) {
      return fail(
        "forbidden",
        t("on_behalf_of_user_id precisa apontar para um atendente ativo desta organização."),
        403,
        { requestId },
      );
    }

    // Os dois NOMES são lidos aqui, no servidor, para irem gravados na linha
    // junto da autoria: o balão desenha "Fulano · via {token}" sem join, e um
    // nome que o balão tivesse de buscar seria um nome que ele não mostra.
    // São enfeite — se a leitura falhar, a autoria continua na coluna.
    const tokenId =
      actor.type === "api_token" || actor.type === "module"
        ? actor.id
        : actor.type === "ai_agent"
          ? (actor.api_token_id ?? actor.id)
          : null;
    const [usuario, linhaDoToken] = await Promise.all([
      supabase.auth.admin.getUserById(entrada.on_behalf_of_user_id).catch(() => null),
      // O builder do PostgREST é thenable, mas o TIPO dele não declara
      // `.catch` — o envolvimento tem de ser por fora. E é enfeite: se a
      // leitura falhar, a autoria continua gravada na coluna, e o balão cai
      // para o rótulo de sempre.
      Promise.resolve(
        supabase
          .from("api_tokens")
          .select("name")
          .eq("id", tokenId ?? "")
          .eq("organization_id", organizationId)
          .maybeSingle(),
      ).then(
        (r) => r,
        () => null,
      ),
    ]);
    onBehalf = {
      userId: entrada.on_behalf_of_user_id,
      userName: (usuario?.data.user?.user_metadata?.full_name as string | undefined) ?? null,
      tokenName: (linhaDoToken?.data as { name?: string } | null)?.name ?? null,
    };
  }

  /**
   * O efeito — o envio de verdade, e a ÚNICA coisa que a idempotência protege.
   *
   * O freio de chamadas do token mora DENTRO dele, e não antes: uma
   * RETENTATIVA com a mesma chave não envia nada, e portanto não pode gastar
   * cota nem levar 429 no lugar do recibo — a promessa da chave é devolver a
   * MESMA resposta, e um contador de chamada que não aconteceu seria mentira.
   * Sem chave, o caminho é o de sempre: uma checagem por requisição, depois
   * de validar o corpo, como dava antes de existir chave nenhuma.
   */
  const enviar = async (): Promise<Message> => {
    // Por token, esta rota é a mesma porta de escrita do MCP — e leva o mesmo
    // teto por token e agregado por organização (`lib/mcp/rate-limit.ts`, #1491).
    // Pela sessão do navegador não há teto: quem digita é uma pessoa.
    if (authz.via === "token") {
      const tokenId = actor.type === "ai_agent" ? (actor.api_token_id ?? actor.id) : actor.id;
      const teto = await checkRateLimit(`messages:tok:${tokenId}`, TETO_DE_ESCRITA, JANELA_SEGUNDOS);
      if (!teto.allowed) {
        throw new ApiError(429, "rate_limited", { retry_after_seconds: JANELA_SEGUNDOS }, requestId, "Too many requests.");
      }

      const tetoOrg = await checkRateLimit(
        `messages:org:${organizationId}`,
        TETO_POR_ORGANIZACAO,
        JANELA_SEGUNDOS,
      );
      if (!tetoOrg.allowed) {
        throw new ApiError(
          429,
          "rate_limited",
          { retry_after_seconds: JANELA_SEGUNDOS },
          requestId,
          "Too many requests for organization.",
        );
      }
    }

    // ─── #4513: a conversa vem do TELEFONE quando não veio pronta ──────────
    //
    // Fica DENTRO do efeito, e depois do teto de chamadas, de propósito:
    //   - dentro do efeito: a chave de idempotência cobre o PAR abrir-conversa
    //     + enviar, como na tool MCP. Um replay não abre uma segunda conversa
    //     nem um segundo contato;
    //   - depois do teto: quem já estourou cota não ganha conversa nova no
    //     banco antes de ser recusado.
    //
    // Quando vem `conversation_id`, nada disto roda: o caminho antigo continua
    // sendo exatamente o de antes, sem consulta a contato nenhum.
    //
    // #5028 — com `conversation_id`, o canal JÁ ESTÁ FIXADO pela conversa (o
    // par contato+sessão do thread). `channel_session_id` no mesmo corpo não
    // muda nada nesse caminho, e a rota não inventa recusa para a combinação:
    // recusar seria decidir pelo mantenedor que "os dois juntos são
    // ambiguidade", e a issue só decidiu que, sem o campo, nada muda. Diferente
    // de `conversation_id` + `phone_number`, aqui não há dois DESTINOS — há um
    // destino e uma preferência de transporte que ele não usa.
    const conversaId =
      entrada.conversation_id ??
      (await conversaDoTelefone({
        organizationId,
        telefone: entrada.phone_number ?? "",
        canalEscolhido: entrada.channel_session_id,
        requestId,
        t,
      }));

    // O handler recebe o corpo de SEMPRE — `conversation_id` obrigatório, sem
    // `phone_number`. A resolução mora na porta; o handler não sabe (e não
    // precisa saber) que a conversa veio de um telefone.
    //
    // `channel_session_id` também é da PORTA (#5028): quem envia é o handler
    // pela sessão da CONVERSA, e deixar o campo vazar no corpo que ele recebe
    // faria o mesmo pedido, na mesma conversa, chegar com uma chave a mais.
    const {
      phone_number: _telefone,
      channel_session_id: _canalEscolhido,
      ...camposDoCorpo
    } = entrada;
    const input: SendMessageInput = { ...camposDoCorpo, conversation_id: conversaId };

    // Freio anti-ban do número (espaçamento + teto diário), só para token:
    // ver o cabeçalho de `lib/messaging/ritmo-do-envio-por-token.ts`.
    const ritmo = authz.via === "token" ? await depsDoRitmo(createAdminClient()) : null;
    const segurado: EnvioSegurado = ritmo
      ? await segurarEnvioPorToken(ritmo, {
          organizationId,
          conversationId: input.conversation_id,
          requestId,
        })
      : null;

    const message = await sendMessageHandler(
      supabase,
      {
        organization_id: organizationId,
        actor,
        requestId,
        idioma,
        // Só chega aqui com o escopo e o membership já validados acima; o
        // handler recusa se `on_behalf_of_user_id` vier sem este ctx (#1613).
        ...(onBehalf ? { onBehalfOf: onBehalf } : {}),
        ...(ehInstitucional ? { dispatchMode: MODO_DE_ENVIO_INSTITUCIONAL } : {}),
      },
      input,
    );
    // Uma resposta humana pelo inbox assume uma conversa livre — SÓ quando a
    // empresa ligou "a conversa fica com quem atendeu" (settings.routing,
    // desligado por padrão). A regra mora em `assumirConversaAposEnvio`, e é a
    // MESMA que o encaminhamento chama: uma regra, dois caminhos de escrita.
    if (!ehInstitucional) {
      await assumirConversaAposEnvio({
        supabase,
        organizationId,
        actor,
        requestId,
        via: authz.via,
        conversationId: message.conversation_id,
        status: message.status,
      });
    }
    if (ritmo) await registrarEnvioPorToken(ritmo, organizationId, segurado, message.status);
    return message;
  };

  try {
    // ─── Item A: idempotência (#1613) ────────────────────────────────────────
    //
    // Sem chave, o caminho é o de sempre: envia, sem recibo nenhum — é o caso
    // que impede o conserto degenerado de "exigir chave sempre", que
    // quebraria todo chamador atual. Com chave, o helper reserva ANTES do
    // efeito (`lib/api/idempotency.ts`, migration 0321), então uma retentativa
    // devolve o recibo gravado sem reenviar, e a mesma chave com corpo
    // DIFERENTE vira 409: a chave é que está errada, não o pedido.
    const desfecho: DesfechoIdempotente<Message> =
      chave === null
        ? { tipo: "executou", resposta: await enviar(), status: 201 }
        : await comIdempotencia({
            db: supabase,
            organizationId,
            endpoint: ENDPOINT,
            chave,
            // O corpo VALIDADO define a identidade da operação — e é o corpo
            // que CHEGOU, não o normalizado: no caminho por telefone, o hash
            // sai do `phone_number` e NUNCA do `conversation_id` resolvido. Se
            // saísse do resolvido, duas coisas quebariam em silêncio: (a) a
            // retentativa do mesmo pedido só casaria depois de resolver a
            // conversa de novo — e resolver é justamente o efeito que a chave
            // existe para não repetir; (b) o mesmo telefone e o mesmo id
            // virariam a mesma operação, quando são dois jeitos diferentes de
            // pedir (e o pedido com os dois é recusado antes, em
            // `ambiguous_target`). Do lado de quem já manda `conversation_id`,
            // o corpo validado é byte a byte o de antes — nenhum campo novo,
            // nenhum default novo —, então o hash das chaves em voo não muda.
            // `channel_session_id` (#5028) entra no hash pela mesma régua:
            // escolher OUTRO número é outro pedido, e um replay com a mesma
            // chave e outro canal tem de virar 409 — não um envio pelo canal
            // errado devolvendo o recibo do anterior.
            corpo: entrada,
            executar: async () => ({ resposta: await enviar(), status: 201 }),
          });

    if (desfecho.tipo === "conflito") {
      return fail(
        "idempotency_conflict",
        t("Esta chave de idempotência já foi usada com outro conteúdo."),
        409,
        { requestId },
      );
    }
    // Mesma chave, MESMO corpo, primeira execução ainda em curso: a chave está
    // reservada e a resposta ainda não existe. Código próprio, e não
    // `idempotency_conflict`: aqui a chave está CERTA e retentar resolve.
    if (desfecho.tipo === "em_curso") {
      return fail(
        "idempotency_in_progress",
        t("A mesma requisição ainda está em curso. Tente de novo em instantes."),
        409,
        { requestId },
      );
    }

    // 201, e não `desfecho.status`: o efeito desta rota termina sempre em 201
    // (a mensagem aceita) e é esse número que o recibo guarda — o replay
    // responde 201 também, que é a MESMA resposta da primeira chamada.
    return ok(desfecho.resposta, { status: 201, requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      const retryAfter = (err.details as { retry_after_seconds?: number } | undefined)
        ?.retry_after_seconds;
      return fail(err.code, err.message, err.status, {
        requestId,
        // `details` saía SÓ no 429, e a recusa da janela (#1614) é um 422 que
        // PROMETE detalhe: `use: "template"` e a última mensagem do cliente
        // são a resposta inteira para quem integra. Repassar o que existe não
        // muda resposta nenhuma anterior — os outros `ApiError` desta rota
        // chamam o construtor com `details: undefined`.
        ...(err.details !== undefined
          ? { details: err.details as Record<string, unknown> }
          : {}),
        ...(err.status === 429 && retryAfter
          ? {
              headers: { "Retry-After": String(retryAfter) },
            }
          : {}),
      });
    }
    throw err;
  }
}
