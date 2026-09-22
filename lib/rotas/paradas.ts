/**
 * OS PARADOS DA ROTA — tipos e montagem, sem entidade paralela.
 *
 * A parada NÃO é uma tabela: é `shipment_orders` agrupado por cliente.
 * Vários pedidos do mesmo cliente viram UMA parada (o motorista visita uma
 * vez só). O endereço da parada segue a prioridade do negócio: endereço de
 * entrega do pedido → endereço do contato → nada (nunca chute).
 */

export interface ParadaDaRota {
  /** Chave estável: contact_id ou "avulso:<cliente_nome>". */
  chave: string;
  contact_id: string | null;
  cliente: string;
  fone: string | null;
  endereco: string | null;
  latitude: number | null;
  longitude: number | null;
  geo_status: string;
  /** nominatim:numero|nominatim:rua|manual — a tela diz quando é aproximado. */
  geo_fonte: string | null;
  pedidos: { shipment_order_id: string; order_id: string; numero: number; total_cents: number; status: string }[];
  total_cents: number;
}

export interface ItemDaCargaParaParada {
  shipment_order_id: string;
  order_id: string;
  sequencia: number;
  status: string;
  numero: number;
  cliente_nome: string;
  contact_id: string | null;
  contato_nome: string | null;
  fone: string | null;
  endereco_entrega: string | null;
  latitude: number | null;
  longitude: number | null;
  geo_status: string | null;
  geo_fonte: string | null;
  total_cents: number;
}

/**
 * Agrupa os itens da carga por cliente, preservando a menor sequência como
 * ordem inicial. Pedido sem contato agrupa pelo nome (avulso).
 */
export function agruparParadas(itens: ItemDaCargaParaParada[]): ParadaDaRota[] {
  const mapa = new Map<string, ParadaDaRota & { menorSeq: number }>();
  for (const i of itens) {
    // Avulso normaliza (caixa, espaço duplo, acento): "João  Silva" e
    // "joao silva" são a mesma visita — sem isso, o motorista para duas
    // vezes na mesma porta.
    const nomeChave = i.cliente_nome
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    const chave = i.contact_id ?? `avulso:${nomeChave}`;
    let p = mapa.get(chave);
    if (!p) {
      p = {
        chave,
        contact_id: i.contact_id,
        cliente: i.contato_nome?.trim() || i.cliente_nome,
        fone: i.fone,
        endereco: i.endereco_entrega?.trim() || null,
        latitude: i.latitude,
        longitude: i.longitude,
        geo_status: i.geo_status ?? "pendente",
        geo_fonte: i.geo_fonte ?? null,
        pedidos: [],
        total_cents: 0,
        menorSeq: i.sequencia,
      };
      mapa.set(chave, p);
    }
    // Primeiro endereço não-vazio vence (prioridade: pedido > contato já
    // resolvida na montagem de `endereco_entrega` pela rota).
    if (!p.endereco && i.endereco_entrega?.trim()) p.endereco = i.endereco_entrega.trim();
    if (i.latitude != null && i.longitude != null && (p.latitude == null || p.longitude == null)) {
      p.latitude = i.latitude;
      p.longitude = i.longitude;
    }
    p.pedidos.push({
      shipment_order_id: i.shipment_order_id,
      order_id: i.order_id,
      numero: i.numero,
      total_cents: i.total_cents,
      status: i.status,
    });
    p.total_cents += i.total_cents;
    if (i.sequencia < p.menorSeq) p.menorSeq = i.sequencia;
  }
  return [...mapa.values()]
    .sort((a, b) => a.menorSeq - b.menorSeq)
    .map(({ menorSeq: _menor, ...resto }) => resto);
}
