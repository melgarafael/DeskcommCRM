/**
 * CARGA PARA ROTA — o carregador único dos endpoints `rota/*`.
 *
 * Uma carga, seus pedidos, os contatos desses pedidos: três selects, nenhum
 * N+1. O frontend NUNCA decide quem pertence à carga nem as coordenadas —
 * tudo sai daqui, validado no backend (a rota confia no banco, não no body).
 */
import { agruparParadas, type ItemDaCargaParaParada, type ParadaDaRota } from "@/lib/rotas/paradas";
import type { createClient } from "@/lib/supabase/server";

type Supabase = Awaited<ReturnType<typeof createClient>>;

export interface CargaRota {
  id: string;
  numero: number;
  status: string;
  placa: string | null;
  veiculo_tipo: string | null;
  motorista_nome: string | null;
  origem_endereco: string | null;
  origem_lat: number | null;
  origem_lng: number | null;
  retornar_origem: boolean;
  tempo_parada_min: number;
  distancia_m: number | null;
  duracao_s: number | null;
  rota_geojson: { geometria?: number[][]; provedor?: string; ruas?: boolean; modo?: string } | null;
  rota_em: string | null;
  rota_versao: number;
  started_at: string | null;
  finished_at: string | null;
}

export interface CargaComParadas {
  carga: CargaRota;
  itens: ItemDaCargaParaParada[];
  paradas: ParadaDaRota[];
}

const COLUNAS_CARGA_ROTA =
  "id, numero, status, placa, veiculo_tipo, motorista_nome, origem_endereco, origem_lat, origem_lng, " +
  "retornar_origem, tempo_parada_min, distancia_m, duracao_s, rota_geojson, rota_em, rota_versao, started_at, finished_at";

export async function carregarCargaComParadas(
  supabase: Supabase,
  orgId: string,
  shipmentId: string,
): Promise<CargaComParadas | null> {
  const { data: carga, error: erroCarga } = await supabase
    .from("shipments")
    .select(COLUNAS_CARGA_ROTA)
    .eq("id", shipmentId)
    .eq("organization_id", orgId)
    .single();
  if (erroCarga || !carga) return null;

  const { data: itens } = await supabase
    .from("shipment_orders")
    .select("id, order_id, sequencia, status")
    .eq("shipment_id", shipmentId)
    .eq("organization_id", orgId)
    .order("sequencia");
  const lista = ((itens ?? []) as unknown as { id: string; order_id: string; sequencia: number; status: string }[]);
  if (lista.length === 0) {
    return { carga: carga as unknown as CargaRota, itens: [], paradas: [] };
  }

  const idsPedidos = lista.map((i) => i.order_id);
  const { data: pedidos } = await supabase
    .from("commercial_orders")
    .select("id, numero, cliente_nome, contact_id, endereco_entrega, total_cents, status")
    .eq("organization_id", orgId)
    .in("id", idsPedidos);
  const porPedido = new Map(
    ((pedidos ?? []) as unknown as {
      id: string;
      numero: number;
      cliente_nome: string;
      contact_id: string | null;
      endereco_entrega: string | null;
      total_cents: number;
      status: string;
    }[]).map((p) => [p.id, p]),
  );

  const idsContatos = [...new Set([...porPedido.values()].map((p) => p.contact_id).filter(Boolean))] as string[];
  let porContato = new Map<string, {
    id: string;
    display_name: string | null;
    name: string | null;
    phone_number: string | null;
    cidade: string | null;
    uf: string | null;
    latitude: number | null;
    longitude: number | null;
    geo_status: string | null;
    geo_fonte: string | null;
  }>();
  if (idsContatos.length > 0) {
    const { data: contatos } = await supabase
      .from("contacts")
      .select("id, display_name, name, phone_number, cidade, uf, latitude, longitude, geo_status, geo_fonte")
      .eq("organization_id", orgId)
      .in("id", idsContatos);
    porContato = new Map(
      ((contatos ?? []) as unknown as {
        id: string;
        display_name: string | null;
        name: string | null;
        phone_number: string | null;
        cidade: string | null;
        uf: string | null;
        latitude: number | null;
        longitude: number | null;
        geo_status: string | null;
        geo_fonte: string | null;
      }[]).map((c) => [c.id, c]),
    );
  }

  const paraParada: ItemDaCargaParaParada[] = lista.map((i) => {
    const p = porPedido.get(i.order_id);
    const c = p?.contact_id ? porContato.get(p.contact_id) : undefined;
    return {
      shipment_order_id: i.id,
      order_id: i.order_id,
      sequencia: i.sequencia,
      status: i.status,
      numero: p?.numero ?? 0,
      cliente_nome: p?.cliente_nome ?? "?",
      contact_id: p?.contact_id ?? null,
      contato_nome: c ? (c.display_name ?? c.name) : null,
      fone: c?.phone_number ?? null,
      endereco_entrega: p?.endereco_entrega ?? null,
      latitude: c?.latitude ?? null,
      longitude: c?.longitude ?? null,
      geo_status: c?.geo_status ?? "pendente",
      geo_fonte: c?.geo_fonte ?? null,
      total_cents: p?.total_cents ?? 0,
    };
  });

  return {
    carga: carga as unknown as CargaRota,
    itens: paraParada,
    paradas: agruparParadas(paraParada),
  };
}
