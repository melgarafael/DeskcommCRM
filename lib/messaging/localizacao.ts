/**
 * Localização compartilhada pelo cliente — a parte AGNÓSTICA.
 *
 * Quem vende com entrega pede o endereço, e o cliente, muitas vezes, manda o
 * pino do WhatsApp em vez de digitar: ele pode não ter número de casa, morar de
 * aluguel, ou simplesmente achar mais fácil. O pino É o endereço — mas só se
 * as coordenadas chegarem até quem entrega. Uma mensagem gravada só como
 * "📍 Location" não diz onde é, nem para o atendente, nem para o agente.
 *
 * Aqui mora o que vale para qualquer transporte: ler as coordenadas que o
 * canal gravou em `messages.metadata.location`, montar o link do mapa e o
 * corpo legível. COMO cada canal obtém as coordenadas mora na pasta dele.
 */

export interface Localizacao {
  latitude: number;
  longitude: number;
  /** Nome do lugar, quando o cliente escolheu um ponto com nome. */
  nome?: string | null;
  /** Endereço escrito, quando o WhatsApp o anexou ao pino. */
  endereco?: string | null;
}

function numero(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function texto(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Lê coordenadas de um objeto cru (payload do canal ou `metadata.location`).
 * Fora da faixa da Terra é `null`: um pino inválido que vira link leva o
 * entregador para o meio do oceano, e isso é pior que não ter pino.
 */
export function lerLocalizacao(bruto: unknown): Localizacao | null {
  if (!bruto || typeof bruto !== "object") return null;
  const o = bruto as Record<string, unknown>;
  const latitude = numero(o.latitude ?? o.lat);
  const longitude = numero(o.longitude ?? o.lng ?? o.lon);
  if (latitude === null || longitude === null) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  // (0, 0) é o valor que um cliente de mapa manda quando não sabe onde está.
  if (latitude === 0 && longitude === 0) return null;
  const nome = texto(o.name ?? o.nome);
  const endereco = texto(o.address ?? o.endereco);
  return {
    latitude,
    longitude,
    ...(nome ? { nome } : {}),
    ...(endereco ? { endereco } : {}),
  };
}

/** Link que abre o ponto no mapa — no celular, abre o app de mapas. */
export function linkDoMapa(loc: Localizacao): string {
  return `https://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
}

/**
 * O `body` da mensagem de localização. É o que o agente lê e o que aparece na
 * prévia da lista de conversas — então leva o link, que é a parte útil, e o
 * nome/endereço quando houver. Sem palavra de idioma: o pino já diz o que é.
 */
export function corpoDaLocalizacao(loc: Localizacao): string {
  const partes = [loc.nome, loc.endereco].filter((p): p is string => Boolean(p));
  return `📍 ${[...partes, linkDoMapa(loc)].join(" — ")}`;
}

/** A localização de uma mensagem já gravada, quando ela tem uma. */
export function localizacaoDaMensagem(m: {
  type?: string | null;
  metadata?: Record<string, unknown> | null;
}): Localizacao | null {
  if (m.type !== "location") return null;
  return lerLocalizacao(m.metadata?.location);
}
