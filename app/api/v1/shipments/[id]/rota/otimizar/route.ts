/**
 * POST /api/v1/shipments/[id]/rota/otimizar — a sequência de entrega.
 *
 * Dois modos (`modo`):
 * - `distancia` (padrão): radial a partir da base — do mais perto ao mais
 *   longe da origem. É a ordem do romaneio ("sai e vai entregando").
 *   EXIGE origem (sem base, "perto" não significa nada).
 * - `tsp`: caixeiro-viajante pelas ruas (OSRM trip) — caminho mais curto,
 *   nem sempre radial.
 * Devolve a PROPOSTA sem salvar: a tela mostra distância/tempo e o operador
 * confirma (ou reordena à mão). Parada sem coordenada volta em
 * `nao_roteirizaveis` — fora do cálculo, nunca num ponto inventado.
 *
 * Origem: `{ endereco }` (geocodifica 1×), `{ latitude, longitude }`, ou
 * ausente (= salva sem origem: radial indisponível, TSP começa na 1ª parada).
 * A origem confirmada só é gravada no PATCH ordem.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { geocodificarEndereco } from "@/lib/rotas/geocodificacao";
import { otimizarComFallback, OsmrmProvider, type Coordenada } from "@/lib/rotas/osrm";
import { haversineM, ordenarPorDistanciaDaOrigem } from "@/lib/rotas/roteamento";
import { createClient } from "@/lib/supabase/server";

import { carregarCargaComParadas } from "../_carga";

export const dynamic = "force-dynamic";

const corpoSchema = z.object({
  origem: z
    .union([
      z.object({ endereco: z.string().trim().min(3).max(300) }),
      z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }),
    ])
    .nullable()
    .optional(),
  retornar_origem: z.boolean().optional(),
  tempo_parada_min: z.number().int().min(0).max(120).optional(),
  modo: z.enum(["tsp", "distancia"]).default("distancia"),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "shipments" });
  if (!authz.ok) return authz.response;

  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const { id } = await params;
  const supabase = await createClient();
  const d = await carregarCargaComParadas(supabase, authz.org.orgId, id);
  if (!d) return fail("not_found", "Carga não encontrada.", 404, { requestId });
  if (d.paradas.length === 0) return fail("validation_failed", "Carga sem pedidos.", 422, { requestId });

  const comCoord = d.paradas.filter((p) => p.latitude != null && p.longitude != null);
  const naoRoteirizaveis = d.paradas.filter((p) => p.latitude == null || p.longitude == null).map((p) => p.chave);
  if (comCoord.length === 0) {
    return fail("validation_failed", "Nenhuma parada geocodificada. Geocodifique antes de otimizar.", 422, { requestId });
  }

  // Origem: coordenada direta, endereço (1 geocodificação) ou nenhuma.
  let origem: (Coordenada & { endereco: string | null }) | null = null;
  const ret = parsed.data.retornar_origem ?? d.carga.retornar_origem;
  const tParada = parsed.data.tempo_parada_min ?? d.carga.tempo_parada_min;
  const reqOrigem = parsed.data.origem ?? null;
  if (reqOrigem && "endereco" in reqOrigem) {
    const g = await geocodificarEndereco(reqOrigem.endereco);
    if (g.estado !== "ok" || g.latitude == null || g.longitude == null) {
      return fail("validation_failed", "Origem não localizada. Ajuste o endereço ou marque no mapa.", 422, { requestId });
    }
    origem = { lat: g.latitude, lng: g.longitude, endereco: reqOrigem.endereco };
  } else if (reqOrigem && "latitude" in reqOrigem) {
    origem = { lat: reqOrigem.latitude, lng: reqOrigem.longitude, endereco: null };
  } else if (d.carga.origem_lat != null && d.carga.origem_lng != null) {
    origem = { lat: d.carga.origem_lat, lng: d.carga.origem_lng, endereco: d.carga.origem_endereco };
  }

  const pontos: Coordenada[] = [
    ...(origem ? [origem] : []),
    ...comCoord.map((p) => ({ lat: p.latitude as number, lng: p.longitude as number })),
  ];

  const modo = parsed.data.modo;
  if (modo === "distancia" && !origem) {
    return fail("validation_failed", "Ordem por distância precisa da origem (a base). Informe o endereço ou use sua posição.", 422, { requestId });
  }

  let prop: Awaited<ReturnType<typeof otimizarComFallback>>;
  if (modo === "distancia") {
    // Radial: ordena por distância da base e desenha a rua nessa ordem.
    const ordemRadial = ordenarPorDistanciaDaOrigem(pontos, ret);
    const naOrdem = ordemRadial.map((i) => pontos[i]!);
    try {
      const rua = await new OsmrmProvider().rota(naOrdem);
      prop = { ...rua, ordem: ordemRadial };
    } catch {
      let distanciaM = 0;
      for (let i = 1; i < naOrdem.length; i++) {
        distanciaM += haversineM(naOrdem[i - 1]!, naOrdem[i]!);
      }
      distanciaM = Math.round(distanciaM * 1.3);
      prop = {
        ordem: ordemRadial,
        distanciaM,
        duracaoS: Math.round((distanciaM / 1000 / 30) * 3600),
        geometria: [],
        provedor: "local",
        ruas: false,
      };
    }
  } else {
    prop = await otimizarComFallback(new OsmrmProvider(), pontos, ret && !!origem);
  }

  // Traduz índices de volta para chaves de parada (índice 0 = origem).
  const semOrigem = prop.ordem.filter((i) => (origem ? i !== 0 : true));
  const ordem = semOrigem.map((i) => comCoord[(origem ? i - 1 : i) as number]?.chave).filter(Boolean) as string[];
  const duracaoDirigindoS = prop.duracaoS;
  const tempoParadasS = ordem.length * tParada * 60;

  return ok(
    {
      ordem,
      origem,
      retornar_origem: ret,
      tempo_parada_min: tParada,
      modo,
      distancia_m: prop.distanciaM,
      duracao_dirigindo_s: duracaoDirigindoS,
      duracao_total_s: duracaoDirigindoS + tempoParadasS,
      geometria: prop.geometria,
      provedor: prop.provedor,
      ruas: prop.ruas,
      nao_roteirizaveis: naoRoteirizaveis,
    },
    { requestId },
  );
}
