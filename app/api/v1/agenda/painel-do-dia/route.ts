/**
 * GET /api/v1/agenda/painel-do-dia?dia=YYYY-MM-DD — o painel do dia, SÓ LEITURA.
 *
 * Issue #4029, saída 3: num lugar só, por turma, quantas reservas, quantas
 * pessoas são esperadas e qual o percentual de confirmadas. A leitura mora em
 * `lib/agenda/painel-do-dia.ts` e reusa `listaAgendamentos` — esta rota só
 * autentica, valida a forma do dia e traduz o resultado.
 *
 * ─── SÓ GET, e não é limitação ─────────────────────────────────────────────
 *
 * Não há POST, PATCH nem DELETE neste caminho. O painel não confirma, não
 * remarca e não cancela: confirmar continua sendo o PATCH de
 * `/api/v1/agenda/agendamentos`, com o `revision` que a tela já carrega. Uma
 * rota de leitura que também escrevesse obrigaria quem só quer olhar o dia a
 * carregar permissão de escrita.
 *
 * ─── A permissão é a da agenda, reusada ────────────────────────────────────
 *
 * Piso `viewer` em `agenda` — o MESMO do `GET /api/v1/agenda/agendamentos`
 * (ver o cabeçalho de lá). Nenhuma segunda régua: quem não pode ler a agenda não
 * lê o resumo dela. E a consulta sai pelo cliente de SESSÃO (`createClient`),
 * então a RLS de `calendar_appointments` filtra por organização como em toda
 * leitura desta base; `organization_id` vai explícito além dela, como manda a
 * doutrina do repo (`organization_id` é ESCOPO, e a RLS é piso).
 *
 * ─── O DIA É O DA ORGANIZAÇÃO ─────────────────────────────────────────────
 *
 * `dia` é dia CIVIL no `organizations.timezone` — não em UTC e não no fuso do
 * navegador. É o que faz um compromisso às 23h de Brasília cair no dia certo:
 * em UTC ele já seria "amanhã". Sem `dia`, o padrão é HOJE nesse mesmo fuso, e
 * não `new Date().toISOString().slice(0, 10)` — que é o dia em UTC e mentiria
 * três horas por dia para o Brasil.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { diaDeHojeNoFuso } from "@/lib/agenda/semana-semente";
import { lerPainelDoDia } from "@/lib/agenda/painel-do-dia";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

export const dynamic = "force-dynamic";

const consultaSchema = z.object({
  dia: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "O dia é uma data no formato AAAA-MM-DD." })
    .optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "agenda" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = consultaSchema.safeParse({
    dia: req.nextUrl.searchParams.get("dia") ?? undefined,
  });
  if (!parsed.success) {
    return fail("validation_failed", t("Consulta inválida."), 422, {
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  // O fuso da ORGANIZAÇÃO é a régua do dia. `fusoUtilizavel` nunca lança: a
  // coluna não é validada por escritor nenhum e um acento no campo viraria tela
  // branca (ver `lib/tempo/fusos`).
  const fuso = fusoUtilizavel(authz.org.timezone);
  const dia = parsed.data.dia ?? diaDeHojeNoFuso(new Date(), fuso);

  const supabase = await createClient();
  try {
    const painel = await lerPainelDoDia(supabase, authz.org.orgId, dia, fuso);
    return ok(painel, { requestId });
  } catch (erro) {
    return fail("internal_error", t("Não foi possível ler o painel do dia agora."), 500, {
      details: { motivo: erro instanceof Error ? erro.message : String(erro) },
      requestId,
    });
  }
}
