/**
 * GET /api/v1/agenda/horarios-livres — os horários que dá para oferecer.
 *
 * A rota é fina de propósito: ela busca, monta e devolve. Toda a REGRA mora em
 * função pura e testável — `lerJornadaDoBanco` (a travessia do jsonb),
 * `ocupadosDoDono` (o que ocupa) e `horariosLivres` (o motor). Rota que decide
 * regra é rota que ninguém consegue testar sem subir um banco.
 *
 * ─── Os dois fusos, e por que não podem se encostar ───────────────────────
 *
 * A REGRA vale no fuso da jornada (`attendant_availability.schedule.timezone`);
 * a APRESENTAÇÃO é escolha de quem exibe (`user_metadata.timezone`, DECISÃO 4).
 * Esta rota devolve **instantes** e o fuso da regra ao lado — nunca hora de
 * parede. Formatar aqui obrigaria a escolher um fuso, e a escolha erraria por
 * uma hora para quem está em Manaus, num jeito que passa em todo teste.
 *
 * ─── Escopo ───────────────────────────────────────────────────────────────
 *
 * Client user-scoped (cookie session), e MESMO ASSIM toda query filtra
 * `organization_id` explicitamente. Não é redundância à toa: a RLS é a defesa
 * que vale, e o filtro é a que sobra se uma policy for afrouxada — as cinco
 * tabelas são tenant-aware, e o `CLAUDE.md` cobra o filtro explícito em toda
 * query que as cruza. O `organization_id` vem do cookie validado, NUNCA da
 * query string.
 *
 * O caso concreto que isso cobre: `attendant_availability` seria buscada só por
 * `user_id`, e `user_id` chega pela query (`owner_user_id`). Sem o filtro de
 * org, uma policy frouxa deixaria consultar a agenda de alguém de outro tenant.
 *
 * Read-only ⇒ sem audit (invariante 3 cobra audit em MUTAÇÃO).
 *
 * Piso `viewer`: consultar horário livre é o menor privilégio que existe nesta
 * feature — quem só olha a agenda precisa ver o que está livre.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";
import { z } from "zod";

import {
  horariosLivresDaOrg,
  MAXIMO_DE_DIAS,
  type CodigoDeRecusaDaConsulta,
} from "@/lib/agenda/consulta";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

const querySchema = z.object({
  event_type_id: z.string().uuid(),
  owner_user_id: z.string().uuid().optional(),
  de: z.string().datetime({ offset: true }),
  ate: z.string().datetime({ offset: true }),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("viewer", { requestId, resource: "agenda" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    event_type_id: url.searchParams.get("event_type_id") ?? undefined,
    owner_user_id: url.searchParams.get("owner_user_id") ?? undefined,
    de: url.searchParams.get("de") ?? undefined,
    ate: url.searchParams.get("ate") ?? undefined,
  });
  if (!parsed.success) {
    return fail("validation_failed", "Consulta inválida.", 422, {
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  const de = new Date(parsed.data.de);
  const ate = new Date(parsed.data.ate);
  if (ate.getTime() <= de.getTime()) {
    return fail("validation_failed", "O fim do período precisa ser depois do começo.", 422, {
      requestId,
    });
  }
  if (ate.getTime() - de.getTime() > MAXIMO_DE_DIAS * 86_400_000) {
    return fail("validation_failed", `O período não pode passar de ${MAXIMO_DE_DIAS} dias.`, 422, {
      requestId,
    });
  }

  const supabase = await createClient();

  // O miolo mora em `lib/agenda/consulta.ts` porque as ferramentas MCP precisam
  // do MESMO cálculo sem ter request nem cookie. Duas coletas dariam à IA e à
  // tela respostas diferentes sobre o mesmo horário.
  const consulta = await horariosLivresDaOrg(supabase, activeOrg.orgId, {
    eventTypeId: parsed.data.event_type_id,
    eventTypeSlug: null,
    ownerUserId: parsed.data.owner_user_id ?? null,
    de,
    ate,
    agora: new Date(),
  });

  if (!consulta.ok) {
    // O consumidor desta rota é a TELA DO OPERADOR, então vai o motivo com o
    // nome do campo. Quem fala com o cliente final (as ferramentas MCP) usa
    // `motivoParaCliente` — dois campos para a escolha ser explícita.
    const status: Record<CodigoDeRecusaDaConsulta, { codigo: string; http: number }> = {
      tipo_desconhecido: { codigo: "not_found", http: 404 },
      tipo_desativado: { codigo: "validation_failed", http: 422 },
      sem_responsavel: { codigo: "validation_failed", http: 422 },
      jornada_mal_configurada: { codigo: "validation_failed", http: 422 },
      erro_interno: { codigo: "internal_error", http: 500 },
    };
    const { codigo, http } = status[consulta.codigo];
    return fail(codigo, consulta.motivoParaOperador, http, { requestId });
  }

  return ok(
    {
      slots: consulta.slots.map((s) => ({
        inicio: s.inicio.toISOString(),
        fim: s.fim.toISOString(),
      })),
      fuso_da_regra: consulta.fusoDaRegra,
      // "Não publiquei meus horários" e "não tenho vaga" chegam como a mesma
      // lista vazia se a tela não puder distingui-los (DECISÃO 1.1).
      publicou_horarios: consulta.publicouHorarios,
      // O fuso não foi escolhido por ninguém: veio do default. A tela precisa
      // poder pedir que a pessoa confirme, porque a IA oferece horário com ele.
      fuso_suposto: consulta.fusoSuposto,
      // Fechado na ação, aberto na informação: o horário fica bloqueado, e a
      // tela pode dizer desde quando a agenda conectada parou de atualizar.
      fontes_defasadas: consulta.fontesDefasadas,
      google_cobertura_parcial: consulta.googleCoberturaParcial,
      // Diferente de `fontes_defasadas`: lá a conexão já trouxe eventos e parou
      // de atualizar; aqui ela nunca trouxe nada, e a grade pode estar mentindo
      // por inteiro. Sai da mesma função que serve às ferramentas MCP, para a
      // tela e a IA nunca discordarem sobre o mesmo horário.
      agenda_externa_nunca_lida: consulta.agendaExternaNuncaLida,
    },
    { requestId },
  );
}

