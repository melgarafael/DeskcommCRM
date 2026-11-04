/**
 * Baixa a imagem de `imagem_url` com a rede do CRM e confere o que chegou (Spec 25 R4,
 * opção A). Quem guarda e manda ao canal é o turno: o gateway nunca vê a URL da fonte.
 *
 * Ordem, e cada passo recusa antes do próximo:
 *  1. forma da URL e extensão (`formatoDeImagemPorUrl`) e guarda textual de saída
 *     (`assertSafeOutboundUrl`: esquema, http só fora de produção, host privado literal);
 *  2. DNS resolvido UMA vez; se QUALQUER endereço for especial, recusa
 *     (`ipEhEspecial`); conecta SOMENTE ao IP já validado, com a opção `lookup` do
 *     `node:https`. O hostname da URL segue sendo o do SNI e do Host, então o TLS não
 *     quebra e não se troca o hostname por IP;
 *  3. nunca segue redirect: qualquer 3xx é recusa;
 *  4. só status 200; teto de 5 MB lido em pedaços (para ao passar, sem ler o resto);
 *     timeout total de 8 s;
 *  5. content-type igual ao MIME da extensão, e bytes mágicos batendo com o mesmo MIME.
 *
 * As dependências de rede (`resolver`, `requisitar`) entram por parâmetro: os testes
 * injetam versões falsas e não abrem conexão nenhuma.
 */
import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIPv4, isIPv6 } from 'node:net';

import { assertSafeOutboundUrl } from '@/lib/automation/outbound-url';
import { ipEhEspecial } from '@/lib/automation/outbound-ip';
import { isMediaPathOwnedBy } from '@/lib/messaging/media/upload-validation';

import { formatoDeImagemPorUrl } from './imagem-por-url';

export const TETO_DE_BYTES_DA_IMAGEM = 5 * 1024 * 1024;
export const TIMEOUT_DO_DOWNLOAD_MS = 8000;

export type MimeDeImagem = 'image/jpeg' | 'image/png' | 'image/webp';

export type ResultadoDownload =
  | { ok: true; bytes: Buffer; mime: MimeDeImagem }
  | { ok: false; motivo: string };

/** Resposta crua da rede. `corpo` entrega pedaços; quem para de ler chama `descartar`. */
export interface RespostaDeRede {
  status: number;
  contentType: string | undefined;
  corpo: AsyncIterable<Buffer>;
  descartar: () => void;
}

export interface DepsDeDownload {
  resolver: (host: string) => Promise<Array<{ address: string; family: number }>>;
  requisitar: (args: {
    url: URL;
    ip: string;
    family: number;
    timeoutMs: number;
  }) => Promise<RespostaDeRede>;
}

/** Resolver real: `lookup` do DNS com todos os endereços. */
async function resolverDeVerdade(host: string): Promise<Array<{ address: string; family: number }>> {
  const enderecos = await dnsLookup(host, { all: true });
  return enderecos.map((e) => ({ address: e.address, family: e.family }));
}

/**
 * Requisição real. Conecta ao `ip` já validado através da opção `lookup`: o socket
 * recebe o IP validado, e o SNI e o cabeçalho Host seguem como o hostname da URL.
 * O prazo total (headers + corpo) é um único timer, que destrói a conexão ao vencer.
 */
function requisitarDeVerdade(args: {
  url: URL;
  ip: string;
  family: number;
  timeoutMs: number;
}): Promise<RespostaDeRede> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      args.url,
      {
        method: 'GET',
        headers: { accept: 'image/jpeg,image/png,image/webp' },
        lookup: (
          _host: string,
          opcoes: unknown,
          cb: (erro: Error | null, endereco: string | Array<{ address: string; family: number }>, familia?: number) => void,
        ) => {
          const todas =
            typeof opcoes === 'object' && opcoes !== null && (opcoes as { all?: boolean }).all === true;
          if (todas) cb(null, [{ address: args.ip, family: args.family }]);
          else cb(null, args.ip, args.family);
        },
      },
      (res) => {
        resolve({
          status: res.statusCode ?? 0,
          contentType: res.headers['content-type'],
          corpo: res,
          descartar: () => {
            res.resume();
            req.destroy();
          },
        });
        res.on('close', () => {
          clearTimeout(prazo);
        });
      },
    );
    const prazo = setTimeout(() => req.destroy(new Error('timeout_do_download')), args.timeoutMs);
    req.on('error', (erro) => {
      clearTimeout(prazo);
      reject(erro);
    });
    req.end();
  });
}

const DEPS_REAIS: DepsDeDownload = { resolver: resolverDeVerdade, requisitar: requisitarDeVerdade };

/**
 * Escolhe o IP de conexão. Literal de IPv4 é julgado direto; nome é resolvido UMA
 * vez, e se QUALQUER endereço cair em faixa especial a conexão nem é tentada.
 */
export async function escolherIpSeguro(
  host: string,
  resolver: DepsDeDownload['resolver'],
): Promise<{ ok: true; ip: string; family: number } | { ok: false; motivo: string }> {
  if (isIPv4(host)) {
    if (ipEhEspecial(host)) return { ok: false, motivo: 'destino_interno' };
    return { ok: true, ip: host, family: 4 };
  }
  if (isIPv6(host)) return { ok: false, motivo: 'destino_interno' };
  let enderecos: Array<{ address: string; family: number }>;
  try {
    enderecos = await resolver(host);
  } catch {
    return { ok: false, motivo: 'dns_falhou' };
  }
  if (enderecos.length === 0) return { ok: false, motivo: 'dns_falhou' };
  if (enderecos.some((e) => ipEhEspecial(e.address))) return { ok: false, motivo: 'destino_interno' };
  const escolhido = enderecos[0]!;
  return { ok: true, ip: escolhido.address, family: escolhido.family };
}

/**
 * Lê o corpo em pedaços e para ao passar do teto. `descartar` solta a conexão; o
 * que não foi lido não é lido.
 */
export async function lerComTeto(
  corpo: AsyncIterable<Buffer>,
  teto: number,
  descartar: () => void,
): Promise<{ ok: true; bytes: Buffer } | { ok: false; motivo: string }> {
  const pedacos: Buffer[] = [];
  let total = 0;
  for await (const pedaco of corpo) {
    total += pedaco.length;
    if (total > teto) {
      descartar();
      return { ok: false, motivo: 'imagem_grande_demais' };
    }
    pedacos.push(pedaco);
  }
  return { ok: true, bytes: Buffer.concat(pedacos) };
}

/** Bytes mágicos: o conteúdo precisa ser do MIME declarado pela extensão. */
export function bateComOTipo(bytes: Buffer, mime: MimeDeImagem): boolean {
  switch (mime) {
    case 'image/jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/png':
      return bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    case 'image/webp':
      return (
        bytes.length >= 12 &&
        bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
        bytes.subarray(8, 12).toString('ascii') === 'WEBP'
      );
    default:
      return false;
  }
}

export async function baixarImagemSegura(
  bruta: string,
  deps: DepsDeDownload = DEPS_REAIS,
): Promise<ResultadoDownload> {
  const forma = formatoDeImagemPorUrl(bruta);
  if (!forma.ok) return { ok: false, motivo: forma.motivo };

  let url: URL;
  try {
    assertSafeOutboundUrl(bruta);
    url = new URL(bruta);
  } catch (erro) {
    return { ok: false, motivo: erro instanceof Error ? erro.message : 'unsafe_url' };
  }

  const destino = await escolherIpSeguro(url.hostname, deps.resolver);
  if (!destino.ok) return destino;

  let resposta: RespostaDeRede;
  try {
    resposta = await deps.requisitar({
      url,
      ip: destino.ip,
      family: destino.family,
      timeoutMs: TIMEOUT_DO_DOWNLOAD_MS,
    });
  } catch {
    return { ok: false, motivo: 'download_falhou' };
  }

  if (resposta.status >= 300 && resposta.status < 400) {
    resposta.descartar();
    return { ok: false, motivo: 'redirect_recusado' };
  }
  if (resposta.status !== 200) {
    resposta.descartar();
    return { ok: false, motivo: 'status_nao_200' };
  }

  // O tipo declarado (sem parâmetros) tem de ser o da extensão: jpg→jpeg, png, webp.
  const tipo = (resposta.contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (tipo !== forma.mime) {
    resposta.descartar();
    return { ok: false, motivo: 'conteudo_nao_e_imagem' };
  }

  let lido: Awaited<ReturnType<typeof lerComTeto>>;
  try {
    lido = await lerComTeto(resposta.corpo, TETO_DE_BYTES_DA_IMAGEM, resposta.descartar);
  } catch {
    resposta.descartar();
    return { ok: false, motivo: 'download_falhou' };
  }
  if (!lido.ok) return lido;

  if (!bateComOTipo(lido.bytes, forma.mime as MimeDeImagem)) {
    return { ok: false, motivo: 'conteudo_nao_e_imagem' };
  }
  return { ok: true, bytes: lido.bytes, mime: forma.mime as MimeDeImagem };
}

/** O que `guardarImagemNaConversa` precisa do Storage: só o upload do bucket da conversa. */
export interface StorageDaConversa {
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        corpo: Buffer,
        opcoes: { contentType: string; upsert: boolean },
      ): Promise<{ error: { message: string; statusCode?: string } | null }>;
    };
  };
}

const BUCKET_DA_CONVERSA = 'whatsapp-media';
const EXTENSAO_DO_MIME: Record<MimeDeImagem, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Grava a imagem baixada na pasta da conversa. O nome sai do CONTEÚDO (hash), então
 * repetir a mesma imagem na mesma conversa reaproveita o arquivo: 409 é sucesso.
 * `tenantId` vem do turno, nunca do modelo. O caminho passa pela mesma regra de posse
 * que o handler de mensagens aplica.
 */
export async function guardarImagemNaConversa(
  admin: StorageDaConversa,
  entrada: { tenantId: string; conversationId: string; bytes: Buffer; mime: MimeDeImagem },
): Promise<{ ok: true; storagePath: string; mime: MimeDeImagem } | { ok: false; motivo: string }> {
  // Os dois ids vêm do turno, mas o caminho é montado por texto: um id com barra ou `..`
  // faria o arquivo cair em outra pasta, e a posse abaixo só confere o que vem DEPOIS do prefixo.
  const segmentoSimples = (s: string) => s !== '' && s !== '.' && s !== '..' && !/[\\/]/.test(s);
  if (!segmentoSimples(entrada.tenantId) || !segmentoSimples(entrada.conversationId)) {
    return { ok: false, motivo: 'caminho_invalido' };
  }
  const hash = createHash('sha256').update(entrada.bytes).digest('hex').slice(0, 16);
  const storagePath = `${entrada.tenantId}/${entrada.conversationId}/externa-${hash}.${EXTENSAO_DO_MIME[entrada.mime]}`;
  if (!isMediaPathOwnedBy(storagePath, entrada.tenantId, entrada.conversationId)) {
    return { ok: false, motivo: 'caminho_invalido' };
  }
  const { error } = await admin.storage
    .from(BUCKET_DA_CONVERSA)
    .upload(storagePath, entrada.bytes, { contentType: entrada.mime, upsert: false });
  if (error && !/already exists/i.test(error.message) && error.statusCode !== '409') {
    return { ok: false, motivo: 'storage_falhou' };
  }
  return { ok: true, storagePath, mime: entrada.mime };
}
