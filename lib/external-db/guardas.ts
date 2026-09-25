/**
 * Guarda de destino do banco externo.
 *
 * O `pg` abre TCP cru — não passa pelo allowlist HTTP de
 * `lib/agent-engine/edge/egress.ts`, nem pelo guard de webhook
 * (`lib/automation/outbound-ip.ts`). Sem uma guarda própria, cadastrar uma
 * conexão vira "posso fazer o servidor falar com qualquer coisa da rede dele".
 *
 * ⚠️ A POLÍTICA AQUI É DIFERENTE DA DO WEBHOOK, e é deliberado.
 *
 * `assertDestinoResolvidoSeguro` bloqueia TODA faixa privada, porque um webhook
 * é cadastrado por `manager` e não deve alcançar a rede interna do compose. Aqui
 * quem cadastra é `admin` — na prática, o dono da VPS — e o caso de uso legítimo
 * inclui um Postgres na mesma rede local. Então:
 *
 *   - RFC1918 (10/8, 172.16/12, 192.168/16) é PERMITIDO: LAN é caso real.
 *   - link-local/metadata (169.254/16), loopback, CGNAT, multicast, reservadas
 *     e TEST-NET continuam BLOQUEADOS SEMPRE: nenhum deles é um banco de dados
 *     de cliente, e o 169.254.169.254 entrega credencial de instância de nuvem.
 *
 * A janela de DNS-rebinding é a mesma descrita em `outbound-ip.ts`: entre a
 * resolução desta guarda e a que o `pg` faz, o DNS pode mudar. Fechar de vez
 * exigiria fixar o IP na conexão, o que muda SNI e quebra TLS com vários
 * destinos. A dívida fica declarada, não escondida.
 */
import { lookup } from "node:dns/promises";
import { isIP, isIPv4, isIPv6 } from "node:net";

export type MotivoHostBloqueado =
  | "host_invalido"
  | "ip_especial"
  | "dns_falhou"
  | "dns_vazio";

export type ResultadoDeHost = { ok: true; enderecos: string[] } | { ok: false; motivo: MotivoHostBloqueado };

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

/**
 * Faixas IPv4 que NUNCA são destino de banco. Note a ausência de 10/8, 172.16/12
 * e 192.168/16: essas são permitidas de propósito (LAN do dono).
 */
const FAIXAS_PROIBIDAS: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "este host"
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local — inclui o metadata de nuvem (169.254.169.254)
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["198.18.0.0", 15], // benchmark
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reservada (inclui 255.255.255.255)
];

/**
 * Expande um IPv6 para 16 bytes. `null` se não for parseável. Cobre a compressão
 * `::`, grupos hex e IPv4 embutido (decimal, como em `::ffff:127.0.0.1`).
 *
 * A normalização é o ponto: `isIPv6` aceita VÁRIAS grafias do MESMO endereço.
 * `::1`, `0:0:0:0:0:0:0:1` e `::ffff:7f00:1` são todas loopback — decidir por
 * prefixo de string deixaria as duas últimas passarem batido.
 */
function ipv6ParaBytes(ip: string): number[] | null {
  const semZona = ip.split("%")[0] ?? "";
  const lados = semZona.split("::");
  if (lados.length > 2) return null;

  const parseLado = (lado: string): number[] | null => {
    if (lado === "") return [];
    const tokens = lado.split(":");
    const bytes: number[] = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i] ?? "";
      if (token.includes(".")) {
        if (i !== tokens.length - 1) return null; // IPv4 embutido só no fim
        const v4 = token.split(".");
        if (v4.length !== 4) return null;
        for (const parte of v4) {
          const n = Number(parte);
          if (!Number.isInteger(n) || n < 0 || n > 255) return null;
          bytes.push(n);
        }
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(token)) return null;
        const n = Number.parseInt(token, 16);
        bytes.push((n >> 8) & 0xff, n & 0xff);
      }
    }
    return bytes;
  };

  const esquerda = parseLado(lados[0] ?? "");
  const direita = parseLado(lados[1] ?? "");
  if (esquerda === null || direita === null) return null;

  if (lados.length === 2) {
    const zeros = 16 - esquerda.length - direita.length;
    if (zeros < 0) return null;
    return [...esquerda, ...new Array<number>(zeros).fill(0), ...direita];
  }
  return esquerda.length === 16 ? esquerda : null;
}

/** Acesso indexado que o `noUncheckedIndexedAccess` do repo não deixa mentir. */
function byte(bytes: ReadonlyArray<number>, i: number): number {
  return bytes[i] ?? 0;
}

function ipv6Proibido(bytes: ReadonlyArray<number>): boolean {
  if (bytes.length !== 16) return true; // não é IPv6: trata como perigoso
  if (bytes.every((b) => b === 0)) return true; // ::
  if (bytes.slice(0, 15).every((b) => b === 0) && byte(bytes, 15) === 1) return true; // ::1
  if (byte(bytes, 0) === 0xfe && (byte(bytes, 1) & 0xc0) === 0x80) return true; // link-local fe80::/10
  if ((byte(bytes, 0) & 0xfe) === 0xfc) return true; // ULA fc00::/7
  if (byte(bytes, 0) === 0xff) return true; // multicast ff00::/8
  if (
    byte(bytes, 0) === 0x20 &&
    byte(bytes, 1) === 0x01 &&
    byte(bytes, 2) === 0x0d &&
    byte(bytes, 3) === 0xb8 // 2001:db8::/32 (documentação)
  ) {
    return true;
  }
  if (
    byte(bytes, 0) === 0x00 &&
    byte(bytes, 1) === 0x64 &&
    byte(bytes, 2) === 0xff &&
    byte(bytes, 3) === 0x9b &&
    bytes.slice(4, 12).every((b) => b === 0) // 64:ff9b::/96 (NAT64 — alcança IPv4)
  ) {
    return true;
  }

  // IPv4 embutido: `::ffff:a.b.c.d` (mapeado) e `::a.b.c.d` (compatível, legado).
  const dezZeros = bytes.slice(0, 10).every((b) => b === 0);
  if (dezZeros && byte(bytes, 10) === 0xff && byte(bytes, 11) === 0xff) {
    return ipDeBancoProibido(
      `${byte(bytes, 12)}.${byte(bytes, 13)}.${byte(bytes, 14)}.${byte(bytes, 15)}`,
    );
  }
  if (dezZeros && byte(bytes, 10) === 0 && byte(bytes, 11) === 0) {
    const embutido = `${byte(bytes, 12)}.${byte(bytes, 13)}.${byte(bytes, 14)}.${byte(bytes, 15)}`;
    if (embutido !== "0.0.0.0") return ipDeBancoProibido(embutido);
  }
  return false;
}

/** Um literal de IP é proibido? Exportado para teste direto da política. */
export function ipDeBancoProibido(ip: string): boolean {
  if (isIPv4(ip)) {
    const alvo = ipv4ParaInt(ip);
    if (alvo === null) return true; // não parseou: trata como perigoso
    for (const [base, prefixo] of FAIXAS_PROIBIDAS) {
      const baseInt = ipv4ParaInt(base);
      if (baseInt === null) continue;
      const mascara = prefixo === 0 ? 0 : (0xffffffff << (32 - prefixo)) >>> 0;
      if (((alvo & mascara) >>> 0) === ((baseInt & mascara) >>> 0)) return true;
    }
    return false;
  }

  if (isIPv6(ip)) {
    const bytes = ipv6ParaBytes(ip);
    if (bytes === null) return true; // não parseou: trata como perigoso
    return ipv6Proibido(bytes);
  }

  return true; // nem IPv4 nem IPv6
}

/** Tira colchetes de IPv6 literal e recusa host com espaço, barra ou vazio. */
function normalizarHost(host: string): string | null {
  const h = host.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (h === "" || h.length > 255) return null;
  if (/[\s/\\]/.test(h)) return null;
  return h;
}

/**
 * Valida o destino: literal de IP é julgado direto; hostname é resolvido e
 * recusado se QUALQUER endereço cair em faixa proibida (rebinding devolve um
 * público e um privado; o `pg` pode escolher o privado, então recusa tudo).
 */
export async function validarHostDeBanco(host: string): Promise<ResultadoDeHost> {
  const h = normalizarHost(host);
  if (h === null) return { ok: false, motivo: "host_invalido" };

  if (isIP(h) !== 0) {
    if (ipDeBancoProibido(h)) return { ok: false, motivo: "ip_especial" };
    return { ok: true, enderecos: [h] };
  }

  let enderecos: Array<{ address: string }>;
  try {
    enderecos = await lookup(h, { all: true });
  } catch {
    // Falha fechado: recusar custa um cadastro; falhar aberto custa a rede interna.
    return { ok: false, motivo: "dns_falhou" };
  }
  if (enderecos.length === 0) return { ok: false, motivo: "dns_vazio" };

  for (const { address } of enderecos) {
    if (ipDeBancoProibido(address)) return { ok: false, motivo: "ip_especial" };
  }
  return { ok: true, enderecos: enderecos.map((e) => e.address) };
}
