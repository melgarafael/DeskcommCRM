import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET/PUT /api/v1/ai/pacing/teto-de-respostas — o teto de respostas automáticas
 * por CONVERSA, por ORGANIZAÇÃO (#4590, fatia "configurável pela empresa").
 *
 * ## Por que uma rota aninhada, e não mais um campo do PUT de knobs
 *
 * O PUT de `/api/v1/ai/pacing` é por CONEXÃO: exige `channel_session_id` e grava
 * em `channel_knobs`, que é a ficha de UM número. O teto mede a CONVERSA, não o
 * número — a mesma empresa pode ter três números e um limite só. Enfiá-lo lá
 * obrigaria a tela a mandar um `channel_session_id` arbitrário para gravar uma
 * decisão que não é daquele canal, e a primeira conexão arquivada levaria a
 * configuração junto.
 *
 * O que ele usa do Anti-ban é o LUGAR: `organizations.settings.anti_ban`, o
 * mesmo bolso jsonb de `crm`, `llm` e `voz` — sem coluna nova e sem migration.
 *
 * ## Sem `channel_session_id`, o corpo é EXPLÍCITO
 *
 * Os três campos são obrigatórios: um PATCH parcial deixaria o valor antigo de
 * um deles e o operador sairia da tela achando que gravou os três. Organização
 * que nunca gravou nada lê `null` e cai no padrão da instalação — o
 * `TETO_DE_RESPOSTAS_POR_CONVERSA` / `TETO_DE_RESPOSTAS_JANELA_MIN` do `.env`, o
 * MESMO que o worker lê (o `app` recebe o mesmo `env_file`); sem eles, 20 em
 * 60 min — e o GET devolve o efetivo e o padrão lado a lado, para a tela poder
 * dizer "está no padrão" sem inventar número.
 *
 * `silenciar_minutos: 0` = não pausa a conversa: o veto e o aviso na Central
 * continuam (a resposta não sai), o que não acontece é o `bot_silenced_until`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import {
  CHAVE_DO_TETO_NO_ANTI_BAN,
  SILENCIO_DO_TETO_DE_RESPOSTAS_MINUTOS_MAXIMO,
  knobsDoTetoDeRespostas,
  lerTetoDoAntiBan,
  type TetoDeRespostasKnobs,
} from "@/lib/agent-engine/agent/teto-de-respostas";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

/** Mesmos limites da leitura (`lerTetoDoAntiBan`): abaixo de 1 não existe teto. */
const tetoDaOrganizacaoSchema = z.strictObject({
  por_conversa: z.number().int().min(1).max(500),
  janela_minutos: z.number().int().min(1).max(1_440),
  silenciar_minutos: z.number().int().min(0).max(SILENCIO_DO_TETO_DE_RESPOSTAS_MINUTOS_MAXIMO),
});

/**
 * O padrão da INSTALAÇÃO, lido do mesmo env que o worker usa como base do turno
 * (`turnKnobsFromEnv`). Uma constante aqui faria a rota mostrar 20/60 numa
 * instalação cujo turno aplica outro número. Ausente, vazio ou inválido cai no
 * padrão do arquivo, como no `knobsDoTetoDeRespostas`.
 */
function baseDaInstalacao(): TetoDeRespostasKnobs {
  return knobsDoTetoDeRespostas({
    porConversa: Number(process.env.TETO_DE_RESPOSTAS_POR_CONVERSA),
    janelaMinutos: Number(process.env.TETO_DE_RESPOSTAS_JANELA_MIN),
  });
}

/** O valor gravado, ou `null` quando a organização nunca configurou. */
async function lerGravado(organizationId: string): Promise<unknown> {
  const pool = getRequestPool();
  const { rows } = await pool.query<{ teto: unknown }>(
    `select settings -> 'anti_ban' -> $2 as teto
       from organizations
      where id = $1`,
    [organizationId, CHAVE_DO_TETO_NO_ANTI_BAN],
  );
  return rows[0]?.teto ?? null;
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "channel_knobs" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  try {
    const gravado = await lerGravado(authz.org.orgId);
    const base = baseDaInstalacao();
    return ok(
      {
        // `efetivo` já resolve ausência e jsonb torto pelo padrão — é o número que
        // o turno vai usar, não uma segunda conta feita na tela.
        efetivo: paraResposta(lerTetoDoAntiBan(gravado, base)),
        padrao: paraResposta(lerTetoDoAntiBan(null, base)),
        configurado: gravado !== null,
      },
      { requestId },
    );
  } catch {
    return fail("internal_error", t("Falha ao carregar o teto de respostas."), 500, { requestId });
  }
}

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "channel_knobs" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }
  const parsed = tetoDaOrganizacaoSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const { por_conversa, janela_minutos, silenciar_minutos } = parsed.data;

  // MERGE nos dois níveis do jsonb (`settings` e `anti_ban`): um
  // `set settings = $2` apagaria marca, `llm` e política de MFA em silêncio, e o
  // sintoma só apareceria dias depois. `jsonb_set` com o pai garantido é atômico
  // — dois operadores gravando ao mesmo tempo não se apagam, e nenhuma leitura
  // intermediária enxerga meio bloco.
  const pool = getRequestPool();
  let gravado: unknown;
  try {
    const { rows } = await pool.query<{ teto: unknown }>(
      `update organizations
          set settings = jsonb_set(
                jsonb_set(
                  coalesce(settings, '{}'::jsonb),
                  '{anti_ban}',
                  coalesce(settings -> 'anti_ban', '{}'::jsonb),
                  true
                ),
                '{anti_ban,teto_de_respostas}',
                $2::jsonb,
                true
              )
        where id = $1
    returning settings -> 'anti_ban' -> $3 as teto`,
      [
        authz.org.orgId,
        JSON.stringify({
          por_conversa,
          janela_minutos,
          silenciar_minutos,
        }),
        CHAVE_DO_TETO_NO_ANTI_BAN,
      ],
    );
    gravado = rows[0]?.teto ?? null;
  } catch {
    return fail("internal_error", t("Falha ao gravar o teto de respostas."), 500, { requestId });
  }

  await audit({
    action: "ai.teto_de_respostas_updated",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "organization",
    resourceId: authz.org.orgId,
    requestId,
    metadata: { por_conversa, janela_minutos, silenciar_minutos },
  });

  const base = baseDaInstalacao();
  return ok(
    {
      efetivo: paraResposta(lerTetoDoAntiBan(gravado, base)),
      padrao: paraResposta(lerTetoDoAntiBan(null, base)),
      configurado: true,
    },
    { requestId },
  );
}

/** O nome que a resposta usa é o do jsonb — o mesmo que o turno lê. */
function paraResposta(teto: {
  porConversa: number;
  janelaMinutos: number;
  silenciarMinutos: number;
}) {
  return {
    por_conversa: teto.porConversa,
    janela_minutos: teto.janelaMinutos,
    silenciar_minutos: teto.silenciarMinutos,
  };
}
