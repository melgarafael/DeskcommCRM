/**
 * GET /api/v1/campaigns/modelos?channel_session_id=… — o que uma campanha pode
 * mandar por ESTE número (migration 0710, issue #1330 fatia 4).
 *
 * Devolve o modo do número (`text` = texto livre, número por QR; `template` =
 * modelo aprovado, número oficial; `null` = canal que não faz campanha) e, no
 * oficial, os modelos espelhados DESTA conexão com as variáveis de cada um —
 * o rótulo, o tipo e as origens que servem — para a tela montar o mapa sem
 * reimplementar o contrato.
 *
 * Nenhuma outra rota servia: a de modelos do oficial não filtra por conexão, e
 * a do parceiro não devolve as variáveis. Dois números espelhando o mesmo nome
 * com conteúdos diferentes é o caso que a conexão resolve (`modelosDaConexao`).
 *
 * Só lê, com a sessão do usuário: a RLS de `meta_templates` e de
 * `channel_sessions` é a segunda tranca, e a organização vem do papel.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { slotKey } from "@/lib/channels/meta/build-components";
import { isStatusSendable } from "@/lib/channels/meta/template-binding";
import { lerModoDoCanal } from "@/lib/campanhas/conteudo-do-canal";
import { origensPermitidas, rotuloDaVariavel, tipoDaVariavel } from "@/lib/campanhas/modelo";
import { contratoDe, listarModelosDaConexao } from "@/lib/campanhas/modelo-da-conexao";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const querySchema = z.object({ channel_session_id: z.string().uuid() });

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams.entries()));
  if (!parsed.success) {
    return fail("validation_failed", t("Escolha um número."), 422, { requestId });
  }
  const channelSessionId = parsed.data.channel_session_id;

  const supabase = await createClient();
  const canal = await lerModoDoCanal(supabase, authz.org.orgId, channelSessionId);
  if (!canal.existe) {
    return fail(
      "campanha_canal_indisponivel",
      t("Escolha uma conexão de WhatsApp desta organização."),
      409,
      { requestId },
    );
  }
  if (canal.modo !== "template") {
    return ok({ modo: canal.modo, modelos: [] }, { requestId });
  }

  try {
    const definicoes = await listarModelosDaConexao(supabase, {
      organizationId: authz.org.orgId,
      channelSessionId,
    });
    const modelos = definicoes.map((d) => {
      const contrato = contratoDe(d);
      return {
        name: d.name,
        language: d.language,
        status: d.status,
        category: d.category,
        aprovado: isStatusSendable(d.status),
        parameter_format: d.parameterFormat,
        components: d.components,
        saved_values: d.savedValues,
        variaveis: contrato.slots.map((slot) => ({
          chave: slotKey(slot.address, slot.key),
          rotulo: rotuloDaVariavel(slot),
          tipo: tipoDaVariavel(slot),
          origens: origensPermitidas(slot),
          contexto_antes: slot.contextBefore,
          contexto_depois: slot.contextAfter,
        })),
      };
    });
    return ok({ modo: canal.modo, modelos }, { requestId });
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : String(err), 500, { requestId });
  }
}
