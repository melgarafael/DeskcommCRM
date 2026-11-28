import { requireSupportWrite } from "@/lib/impersonate/support";
import { carteiraDoContato } from "@/lib/carteira/dono";
import { MOTIVO_DA_RECUSA, recusaNegocioNaCarteiraDeOutro } from "@/lib/carteira/negocio-novo";
import { traduzir } from "@/lib/i18n/dicionario";
/**
 * POST /api/v1/leads — create lead (handler em ./_handler.ts).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { chaveDaRequisicao, comIdempotencia, type DesfechoIdempotente } from "@/lib/api/idempotency";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { requireRole } from "@/lib/auth/require-role";
import { somenteOProprio, type VisibilityMode } from "@/lib/auth/types";
import {
  AVISO_NEGOCIO_ABERTO_EXISTENTE,
  negocioAbertoExistente,
} from "@/lib/leads/negocio-aberto-duplicado";
import { createLeadSchema, validateRequest, type CreateLeadInput } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";

import { createLeadHandler } from "./_handler";

export const dynamic = "force-dynamic";

/** Tag do endpoint no recibo de idempotência. Muda de rota muda de recibo. */
const ENDPOINT = "/api/v1/leads";

/** O que o efeito devolve: o lead criado e o aviso do #1751, se houver. */
type CriacaoDeLead = {
  lead: Awaited<ReturnType<typeof createLeadHandler>>;
  negocioExistente: Awaited<ReturnType<typeof negocioAbertoExistente>>;
};

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "crm_leads",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "leads_create", requestId);
  if (teto) return teto;
  const { organizationId, actor, idioma } = authz;
  const t = (texto: string) => traduzir(texto, idioma ?? IDIOMA_PADRAO);

  let input;
  try {
    input = await validateRequest(createLeadSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  // ─── NO "SÓ OS SEUS", O QUE O ATENDENTE CRIA É DELE (issue #2547) ──────────
  //
  // Em `visibility_mode = 'own'` a policy de `crm_leads` só deixa o Atendente
  // gravar o negócio que ele enxergaria depois — o que tem ELE de responsável.
  // O "Novo Lead" não manda responsável, então a criação era recusada (500, e
  // 403 explicado desde o #2556). Decisão do mantenedor (opção A): sem
  // responsável no corpo, o responsável é o próprio Atendente. Ele passa pela
  // mesma régua de atribuição de quem manda o campo (`ownerPatchOrThrow`:
  // membro ativo, `owner_kind`, `assigned_at`).
  //
  // Só quando o corpo NÃO menciona dono: `owner_user_id: null` explícito ou um
  // colega de responsável continuam sendo pedidos que a regra recusa (403).
  // Gerente e admin enxergam a organização inteira e criam como sempre. O modo
  // vem da org do cookie validado, nunca do corpo — admin client, como em
  // `app/app/layout.tsx`.
  // O papel real só existe na sessão (o token não é "o Atendente"): o responsável
  // padrão é do papel `agent`, como era antes da porta do token.
  let papelDaSessao: string | null = null;
  if (authz.via === "session") {
    const sessao = await requireRole("viewer", { requestId, resource: "crm_leads" });
    if (sessao.ok) papelDaSessao = sessao.org.role;
  }
  if (
    papelDaSessao === "agent" &&
    input.owner_user_id === undefined &&
    input.owner_agent_id === undefined
  ) {
    // Um client só para as duas leituras do modo/carteira (service-role: RLS
    // não segura nada aqui, então `organization_id` junto em todo `.eq`).
    const admin = createAdminClient();
    const { data: orgRow, error: orgErr } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", organizationId)
      .maybeSingle();
    // Leitura do modo falhou: segue SEM o padrão e registra. Seguir não amplia
    // acesso (a RLS de `crm_leads` lê o mesmo modo e decide); derrubar a criação
    // criaria uma falha nova nos modos em que ela daria certo — as leituras
    // vizinhas deste fluxo (moeda, origem) também degradam em vez de falhar.
    if (orgErr) {
      logger.error("leads.create: leitura do modo de visibilidade falhou; segue sem responsável padrão", {
        requestId,
        orgId: organizationId,
        error: orgErr.message,
      });
    }
    const modo = (orgRow?.settings as { visibility_mode?: VisibilityMode } | null)?.visibility_mode;
    // `modo === "own"` estava escrito à mão aqui, na tela do Inbox e no catálogo
    // de recursos — três cópias da MESMA pergunta. Agora ela é um predicado só
    // (`somenteOProprio`), e a #3479 é o que acontece quando uma das cópias fica
    // para trás: no negócio o criador vira responsável, na conversa não.
    if (somenteOProprio(modo)) {
      // ─── CARTEIRA DE OUTRO VENDEDOR (issue #2591, regra 4) ─────────────────
      //
      // O padrão do #2547 acima dá o negócio a quem o criou — mas isso só é
      // justo enquanto ninguém é o DONO do cliente. Com o contato na carteira
      // de outro vendedor, o que o Atendente acabou de fazer foi riscar um
      // cliente do colega sem ninguém avisar. A issue decide: com carteira de
      // outro vendedor o negócio recusa com o motivo (403 explicado, molde do
      // #2556) em vez de nascer silenciosamente no nome errado.
      //
      // O dono que NÃO conta (viewer, revogado, de outra org) passa como
      // `donoDaCarteira: null` — aí nada muda, que é o padrão.
      const carteira = await carteiraDoContato(admin, organizationId, input.contact_id);
      if (
        recusaNegocioNaCarteiraDeOutro({
          modo,
          criadorId: actor.id,
          donoDaCarteira: carteira.qualificado ? carteira.dono : null,
        })
      ) {
        return fail("carteira_de_outro_vendedor", t(MOTIVO_DA_RECUSA), 403, {
          requestId,
        });
      }
      // Só a sessão chega aqui (papelDaSessao), logo o ator é pessoa; o guarda é explícito
      // para que o id de um token nunca vá para coluna de pessoa (tests/unit/ator-modulo-nao-vira-pessoa).
      if (actor.type === "user") {
        input = { ...input, owner_user_id: actor.id };
      }
    }
  }

  const supabase = authz.supabase;

  // ─── IDEMPOTÊNCIA DO POST (issue #5338) ────────────────────────────────────
  //
  // O `apiClient` carimba `Idempotency-Key` em todo POST (`lib/api/client.ts`),
  // então uma retentativa de rede ou um duplo clique chegam aqui com a MESMA
  // chave. Até aqui esta rota não lia o cabeçalho e o INSERT era incondicional:
  // as duas requisições criavam negócio, e o "Novo Lead" virava dois cartões
  // para o mesmo contato no mesmo funil.
  //
  // O caminho é o do resto do repositório (`lib/api/idempotency.ts`): a chave é
  // por ORGANIZAÇÃO + endpoint (`ENDPOINT`), reservada ANTES do efeito, e a
  // repetição devolve o recibo do primeiro request — o MESMO lead, com o mesmo
  // `meta`. Sem chave, o caminho é o de sempre: uma chave só existe quando quem
  // chama quer retentativa segura, e é isso que mantém todo chamador atual de
  // pé. Chave, quando vem, é UUID, como nas outras rotas de escrita.
  const chave = chaveDaRequisicao(req);
  if (chave !== null && !z.string().uuid().safeParse(chave).success) {
    return fail("validation_error", "Idempotency-Key deve ser UUID.", 400, { requestId });
  }

  // ─── O EFEITO: aviso de negócio aberto + criação ───────────────────────────
  //
  // O aviso (#1751) mora DENTRO do efeito de propósito: ele descreve o mundo em
  // que a pessoa pediu a criação. Lido no replay, o negócio NOVO — criado pela
  // primeira requisição — entraria na própria contagem; e lido fora do efeito,
  // a resposta repetida perderia o `meta` que a primeira devolveu. A consulta
  // nunca recusa: a migration 0256 decidiu que um cliente PODE ter dois
  // negócios abertos, então o segundo nasce e a resposta avisa.
  const criar = async (): Promise<CriacaoDeLead> => {
    const negocioExistente = input.contact_id
      ? await negocioAbertoExistente(supabase, {
          organizationId,
          contactId: input.contact_id,
          pipelineId: input.pipeline_id,
        })
      : null;

    const lead = await createLeadHandler(
      supabase,
      {
        organization_id: organizationId,
        actor,
        requestId,
        idioma,
      },
      input as CreateLeadInput,
    );
    return { lead, negocioExistente };
  };

  try {
    const desfecho: DesfechoIdempotente<CriacaoDeLead> =
      chave === null
        ? { tipo: "executou", resposta: await criar(), status: 201 }
        : await comIdempotencia({
            db: supabase,
            organizationId,
            endpoint: ENDPOINT,
            chave,
            // O corpo VALIDADO define a identidade da operação: mesmo pedido +
            // mesma chave = replay; mesma chave com corpo diferente = 409.
            corpo: input,
            executar: async () => ({ resposta: await criar(), status: 201 }),
          });

    if (desfecho.tipo === "conflito")
      return fail(
        "idempotency_conflict",
        t("Esta chave de idempotência já foi usada com outro conteúdo."),
        409,
        { requestId },
      );

    // Mesma chave, MESMO corpo, e a primeira execução ainda está em curso: a
    // chave está reservada (migration 0321) e a resposta ainda não existe — não
    // há o que devolver, e reexecutar duplicaria a criação. Código próprio e
    // não `idempotency_conflict`: aqui a chave está CERTA, retentar resolve.
    if (desfecho.tipo === "em_curso")
      return fail(
        "idempotency_in_progress",
        t("A mesma requisição ainda está em curso. Tente de novo em instantes."),
        409,
        { requestId },
      );

    // 201 também no replay: é o status que o recibo guarda (a criação termina
    // sempre em 201), então é ele que a repetição devolve.
    const { lead, negocioExistente } = desfecho.resposta;
    return ok(lead, {
      requestId,
      status: 201,
      // `meta` só quando há aviso: uma resposta sem `meta` continua sem
      // `meta`, e o que muda é acrescentar, nunca esconder.
      ...(negocioExistente
        ? {
            meta: {
              avisos: [AVISO_NEGOCIO_ABERTO_EXISTENTE],
              negocio_aberto_existente: negocioExistente,
            },
          }
        : {}),
    });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}
