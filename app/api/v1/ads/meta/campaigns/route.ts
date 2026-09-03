/**
 * GET /api/v1/ads/meta/campaigns — a tabela de campanhas do período.
 *
 * DUAS chamadas à plataforma por requisição, e não é desperdício: o endpoint de
 * insights não expõe `effective_status`, então "Status" e "Veiculação" só
 * existem no endpoint de campanhas. É a razão de a leitura custar 2 unidades de
 * cota por atualização, e de a tela ter debounce no botão.
 *
 * As duas vão em paralelo porque não dependem uma da outra — o cruzamento
 * acontece depois, em `montarTabelaDeCampanhas`, que é puro e testado sem rede.
 *
 * Sem cache, deliberadamente: o botão da tela se chama "Atualizar" e promete
 * número de agora. `force-dynamic` aqui, `cache: "no-store"` no fetch de lá.
 *
 * Read-only ⇒ sem audit (mesma regra de `metrics/attendants`). Piso `manager`,
 * mesmo de `accounts`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { lerCredencialDeLeitura } from "@/lib/plataformas-de-anuncio/credenciais-de-leitura";
import { lerCampanhas, lerInsights } from "@/lib/plataformas-de-anuncio/meta/insights";
import { montarTabelaDeCampanhas } from "@/lib/plataformas-de-anuncio/meta/tabela-de-campanhas";
import { createAdminClient } from "@/lib/supabase/admin";

import { respostaDeFalha, respostaSemConexao } from "../_falha";

export const dynamic = "force-dynamic";

/** `YYYY-MM-DD`, o formato que o `time_range` da plataforma aceita. */
const DATA = /^\d{4}-\d{2}-\d{2}$/;

const querySchema = z
  .object({
    // `act_` obrigatório: o identificador cru (sem prefixo) é aceito por alguns
    // endpoints e não por outros, e deixar os dois formatos circularem faria a
    // conta selecionada na tela não bater com a chave do cache do cliente.
    account_id: z.string().regex(/^act_\d+$/, "conta no formato act_<id>"),
    from: z.string().regex(DATA, "data no formato AAAA-MM-DD").optional(),
    to: z.string().regex(DATA, "data no formato AAAA-MM-DD").optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    message: "o início do período não pode ser depois do fim",
    path: ["from"],
  });

/** AAAA-MM-DD em UTC. */
function comoData(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Últimos 7 dias, terminando ONTEM.
 *
 * Não termina hoje de propósito: o dia corrente está incompleto e a plataforma
 * ainda reprocessa atribuição dele por horas. Incluí-lo faria o CPA de hoje
 * parecer alto de manhã e melhorar sozinho à tarde — um número que muda sem
 * ninguém mexer em nada é o que ensina o operador a não confiar na tela.
 */
function periodoPadrao(): { from: string; to: string } {
  const ontem = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const seteDiasAntes = new Date(ontem.getTime() - 6 * 24 * 60 * 60 * 1000);
  return { from: comoData(seteDiasAntes), to: comoData(ontem) };
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "ads_insights" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return fail("validation_failed", "Parâmetros inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const padrao = periodoPadrao();
  const de = parsed.data.from ?? padrao.from;
  const ate = parsed.data.to ?? padrao.to;

  const admin = createAdminClient();
  const credencial = await lerCredencialDeLeitura(admin, org.orgId, "meta_ads");
  if (!credencial.ok) return respostaSemConexao(credencial.motivo, { requestId });

  const token = credencial.credencial.accessToken;
  const contaId = parsed.data.account_id;

  const [campanhas, insights] = await Promise.all([
    lerCampanhas(token, contaId),
    lerInsights(token, contaId, de, ate),
  ]);

  // A primeira falha manda. As duas chamadas falham pela MESMA causa quase
  // sempre (token, permissão, cota), e reportar as duas produziria dois avisos
  // na tela dizendo a mesma coisa.
  if (!campanhas.ok) return respostaDeFalha(campanhas.falha, campanhas.detalhe, { requestId });
  if (!insights.ok) return respostaDeFalha(insights.falha, insights.detalhe, { requestId });

  const linhas = montarTabelaDeCampanhas(campanhas.dados, insights.dados);

  return ok(
    {
      campanhas: linhas,
      periodo: { from: de, to: ate },
      account_id: contaId,
      // Quando a leitura aconteceu de verdade. A tela estampa isto embaixo do
      // botão: sem carimbo, uma tabela que falhou ao atualizar é visualmente
      // idêntica a uma que acabou de atualizar.
      lido_em: new Date().toISOString(),
    },
    { requestId },
  );
}
