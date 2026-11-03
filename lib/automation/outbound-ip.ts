/**
 * Faixas de IP que um webhook de saída nunca deve alcançar, e o guard que
 * RESOLVE o hostname antes de decidir.
 *
 * O guard textual (`assertSafeOutboundUrl`) declarava a própria dívida: um
 * hostname público que resolve para IP privado no momento do fetch passava
 * batido. Numa VPS de self-host isso alcança o que mora na rede do compose —
 * o cache e o gateway de mensageria sem autenticação de rede, o Postgres, e o serviço de
 * metadados da nuvem em 169.254.169.254, que entrega credencial de instância.
 *
 * Quem cadastra a URL precisa ser `manager+`, então o atacante já é alguém de
 * dentro do tenant; o que se impede aqui é a escalada de "posso configurar um
 * webhook" para "posso varrer e falar com a rede interna do servidor".
 */
import { lookup } from "node:dns/promises";
import type { LookupAddress, LookupOptions } from "node:dns";
import { isIPv4, isIPv6 } from "node:net";
import type { LookupFunction } from "node:net";

/** Converte IPv4 pontuado em inteiro de 32 bits. */
function ipv4ParaInt(ip: string): number | null {
  const partes = ip.split(".");
  if (partes.length !== 4) return null;
  let total = 0;
  for (const parte of partes) {
    const n = Number(parte);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    total = total * 256 + n;
  }
  return total;
}

/** [base, prefixo] das faixas IPv4 que não podem ser destino. */
const FAIXAS_IPV4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "este host"
  ["10.0.0.0", 8], // privada
  ["100.64.0.0", 10], // CGNAT — ausente do guard textual
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local — inclui o metadata de nuvem
  ["172.16.0.0", 12], // privada (a rede default do Docker mora aqui)
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16], // privada
  ["198.18.0.0", 15], // benchmark
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reservada (inclui 255.255.255.255)
];

export function ipEhEspecial(ip: string): boolean {
  if (isIPv4(ip)) {
    const alvo = ipv4ParaInt(ip);
    if (alvo === null) return true; // não parseou: trata como perigoso
    for (const [base, prefixo] of FAIXAS_IPV4) {
      const baseInt = ipv4ParaInt(base);
      if (baseInt === null) continue;
      const mascara = prefixo === 0 ? 0 : (0xffffffff << (32 - prefixo)) >>> 0;
      if ((alvo & mascara) >>> 0 === (baseInt & mascara) >>> 0) return true;
    }
    return false;
  }

  if (isIPv6(ip)) {
    const normal = ip.toLowerCase();
    // IPv4-mapped (::ffff:127.0.0.1) esconde um IPv4 — decide pelo IPv4 embutido.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normal);
    if (mapped?.[1]) return ipEhEspecial(mapped[1]);
    if (normal === "::" || normal === "::1") return true;
    if (normal.startsWith("fe80")) return true; // link-local
    if (/^f[cd]/.test(normal)) return true; // ULA fc00::/7
    if (normal.startsWith("ff")) return true; // multicast
    if (normal.startsWith("2001:db8")) return true; // documentação
    if (normal.startsWith("64:ff9b")) return true; // NAT64 — alcança IPv4 privado
    return false;
  }

  return true; // nem IPv4 nem IPv6: não é destino que se saiba julgar
}

/** Resolve e valida todos os destinos, devolvendo os mesmos IPs para o socket. */
export async function resolverDestinosPublicos(
  hostname: string,
  resolve: (host: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]> = lookup,
): Promise<LookupAddress[]> {
  const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (isIPv4(host) || isIPv6(host)) {
    if (ipEhEspecial(host)) throw new Error("unsafe_url:private_ip");
    return [{ address: host, family: isIPv4(host) ? 4 : 6 }];
  }

  let addresses: LookupAddress[];
  try {
    addresses = await resolve(host, { all: true, verbatim: true });
  } catch {
    throw new Error("unsafe_url:dns_failed");
  }
  if (addresses.length === 0) throw new Error("unsafe_url:dns_empty");
  if (addresses.some(({ address }) => ipEhEspecial(address))) {
    throw new Error("unsafe_url:private_ip");
  }
  return addresses;
}

/** Lookup preso aos endereços já verificados; não consulta DNS durante a conexão. */
export function lookupFixo(hostname: string, addresses: LookupAddress[]): LookupFunction {
  const expected = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return (requested, options: LookupOptions, callback) => {
    if (requested !== expected || addresses.length === 0) {
      callback(Object.assign(new Error("Destino DNS não validado."), { code: "EHOSTUNREACH" }), "", 0);
      return;
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  };
}

/**
 * Resolve o hostname e devolve os endereços, recusando se QUALQUER um cair em
 * faixa especial.
 *
 * Recusar quando *qualquer* endereço é especial (e não "quando todos são") é
 * deliberado: um domínio que devolve dois registros, um público e um privado,
 * é a assinatura do rebinding — o `fetch` pode escolher o privado, e não temos
 * como saber qual ele pegou.
 *
 * O resultado é passado ao `lookupFixo`, que impede uma segunda resolução
 * durante a conexão TCP.
 */
export async function assertDestinoResolvidoSeguro(hostname: string): Promise<void> {
  await resolverDestinosPublicos(hostname);
}
