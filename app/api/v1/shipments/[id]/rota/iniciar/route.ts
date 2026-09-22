/**
 * POST /api/v1/shipments/[id]/rota/iniciar — a rota sai do papel.
 *
 * montando→em_rota (vira os itens junto) + carimba quem/quando.
 */
import { type NextRequest } from "next/server";

import { transicaoDeRota } from "../_transicao";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return transicaoDeRota(req, id, "iniciar");
}
