/**
 * POST /api/v1/shipments/[id]/rota/finalizar — a rota vira histórico.
 *
 * em_rota→concluída, exigindo zero pendência. O realizado (km/tempo) a tela
 * calcula do rastro GPS — sem dado suficiente, mostra só o planejado.
 */
import { type NextRequest } from "next/server";

import { transicaoDeRota } from "../_transicao";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return transicaoDeRota(req, id, "finalizar");
}
