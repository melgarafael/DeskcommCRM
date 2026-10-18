/**
 * A FOTO DO ITEM VAI JUNTO — a foto de um item achado por RECEITA do banco
 * externo (Spec 25, R4). Irmão de `fotos-do-produto.ts`, que cuida da foto do
 * catálogo interno (`produto_codigo`); aqui a imagem mora num servidor de
 * terceiros (o site do cliente) e a URL vem de dado gravado por outro sistema.
 *
 * SEGURANÇA, em ordem — cada degrau existe porque o de baixo não basta:
 *  1. A URL só vale se foi DEVOLVIDA por `crm_consultar_receita` NESTE turno
 *     (`ImagensDaReceitaNoTurno`). Sem isto um lead mandaria o agente buscar
 *     uma URL qualquer ("manda a foto de http://...").
 *  2. `assertUrlDeMidiaSegura` ANTES de qualquer fetch (anti-SSRF: esquema,
 *     host privado, IP literal e DNS que resolve para IP interno).
 *  3. `redirect: 'manual'`: cada salto passa DE NOVO pela guarda (um servidor
 *     público pode redirecionar para 169.254.169.254).
 *  4. Teto de tempo (um relógio só para a corrente inteira) e de bytes (contagem
 *     do corpo lido, não só o `content-length`, que o servidor pode omitir).
 *  5. Só jpeg/png/webp, pelo `content-type` E pelos bytes iniciais.
 *
 * FALHA DE MÍDIA NUNCA DERRUBA O TEXTO: tudo aqui devolve `{ ok: false }` em vez
 * de lançar; quem chama manda só o texto e conta o motivo ao modelo.
 *
 * Os números abaixo são a PROPOSTA do C3 da Spec 25 e AINDA NÃO FORAM MEDIDOS
 * no canal de WhatsApp real (limite de tamanho aceito, tempo de envio de imagem remota).
 */
import { createHash } from 'node:crypto';

import { assertUrlDeMidiaSegura } from '@/lib/messaging/media/url-de-midia-externa';
import { createAdminClient } from '@/lib/supabase/admin';

import type { FotoParaEnvio } from './fotos-do-produto';

/** C3 (proposta, não medida no canal de WhatsApp real): tempo total para baixar a imagem. */
export const FOTO_DA_RECEITA_TIMEOUT_MS = 8_000;
/** C3 (proposta, não medida no canal de WhatsApp real): teto de bytes do corpo da imagem. */
export const FOTO_DA_RECEITA_MAX_BYTES = 5 * 1024 * 1024;
/** C3 (proposta, não medida no canal de WhatsApp real): redirecionamentos seguidos (cada um é reconferido). */
export const FOTO_DA_RECEITA_MAX_SALTOS = 2;

const BUCKET_DA_CONVERSA = 'whatsapp-media';

const MIMES_ACEITOS = new Set(['image/jpeg', 'image/png', 'image/webp']);
const EXTENSAO: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** As `imagem_url` que as consultas de receita devolveram NESTE turno. */
export class ImagensDaReceitaNoTurno {
  private readonly urls = new Set<string>();

  /** Lê o resultado de `crm_consultar_receita` e guarda as `imagem_url` das linhas. */
  registrar(resultado: unknown): void {
    if (resultado === null || typeof resultado !== 'object') return;
    const r = resultado as { erro?: unknown; error?: unknown; linhas?: unknown };
    if (r.erro || r.error || !Array.isArray(r.linhas)) return;
    for (const linha of r.linhas) {
      if (linha === null || typeof linha !== 'object') continue;
      const url = (linha as { imagem_url?: unknown }).imagem_url;
      if (typeof url === 'string' && url.trim() !== '') this.urls.add(url.trim());
    }
  }

  tem(url: string): boolean {
    return this.urls.has(url.trim());
  }
}

/** Só o host, para log e mensagens: a URL inteira pode carregar token. */
export function hostDaUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'url_invalida';
  }
}

/** O tipo pelos primeiros bytes, ou `null` quando não é jpeg/png/webp. */
export function mimePelosBytes(b: Uint8Array): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

export type DownloadDeImagem =
  | { ok: true; bytes: Uint8Array; mime: string }
  | { ok: false; motivo: string };

export interface DepsDoDownload {
  fetch: typeof fetch;
  /** A guarda anti-SSRF; injetável só para teste — o padrão é a canônica. */
  assertUrl?: (url: string) => Promise<void>;
  timeoutMs?: number;
  maxBytes?: number;
}

async function lerCorpoComTeto(resp: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!resp.body) {
    const tudo = new Uint8Array(await resp.arrayBuffer());
    return tudo.length > maxBytes ? null : tudo;
  }
  const leitor = resp.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await leitor.cancel().catch(() => undefined);
      return null;
    }
    partes.push(value);
  }
  const saida = new Uint8Array(total);
  let ponta = 0;
  for (const p of partes) {
    saida.set(p, ponta);
    ponta += p.length;
  }
  return saida;
}

/** Baixa a imagem com a guarda a cada salto. NUNCA lança: o motivo vai no retorno. */
export async function baixarImagemDaReceita(
  urlInicial: string,
  deps: DepsDoDownload,
): Promise<DownloadDeImagem> {
  const assertUrl = deps.assertUrl ?? assertUrlDeMidiaSegura;
  const maxBytes = deps.maxBytes ?? FOTO_DA_RECEITA_MAX_BYTES;
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), deps.timeoutMs ?? FOTO_DA_RECEITA_TIMEOUT_MS);
  try {
    let atual = urlInicial;
    for (let salto = 0; ; salto += 1) {
      // A guarda vem ANTES de qualquer fetch — inclusive o de cada salto.
      // LIMITAÇÃO CONHECIDA (DNS rebinding): a guarda resolve o nome e o `fetch` resolve de
      // novo, então um DNS com TTL zero pode responder público aqui e privado ao conectar.
      // Fechar de vez pede fixar o IP resolvido na conexão (dispatcher do undici com `lookup`
      // validado), e a casa não tem esse dispatcher em lugar nenhum nem o `undici` como
      // dependência (a mesma janela está declarada em `lib/automation/outbound-ip.ts` e em
      // `destinos-internos-autorizados.ts`). Fica para o egress inteiro, não só para a foto.
      // Mitigam: a URL vem de uma coluna do banco do próprio cliente, redirect manual com a
      // guarda a cada salto, teto de bytes e só imagem (jpeg/png/webp, conferida pelos bytes) é aceita.
      try {
        await assertUrl(atual);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unsafe_url';
        return { ok: false, motivo: msg.startsWith('unsafe_url') ? msg : 'unsafe_url:erro' };
      }
      const resp = await deps.fetch(atual, {
        redirect: 'manual',
        signal: controle.signal,
        headers: { accept: 'image/jpeg,image/png,image/webp' },
      });
      if (resp.status >= 300 && resp.status < 400) {
        const destino = resp.headers.get('location');
        await resp.body?.cancel().catch(() => undefined);
        if (!destino) return { ok: false, motivo: 'redirecionamento_sem_destino' };
        if (salto >= FOTO_DA_RECEITA_MAX_SALTOS) return { ok: false, motivo: 'redirecionamentos_demais' };
        try {
          atual = new URL(destino, atual).toString();
        } catch {
          return { ok: false, motivo: 'redirecionamento_invalido' };
        }
        continue;
      }
      if (!resp.ok) {
        await resp.body?.cancel().catch(() => undefined);
        return { ok: false, motivo: `http_${resp.status}` };
      }
      const tipo = (resp.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (!MIMES_ACEITOS.has(tipo)) {
        await resp.body?.cancel().catch(() => undefined);
        return { ok: false, motivo: 'tipo_nao_aceito' };
      }
      const declarado = Number(resp.headers.get('content-length'));
      if (Number.isFinite(declarado) && declarado > maxBytes) {
        await resp.body?.cancel().catch(() => undefined);
        return { ok: false, motivo: 'grande_demais' };
      }
      const bytes = await lerCorpoComTeto(resp, maxBytes);
      if (!bytes) return { ok: false, motivo: 'grande_demais' };
      const mime = mimePelosBytes(bytes);
      if (!mime) return { ok: false, motivo: 'tipo_nao_aceito' };
      return { ok: true, bytes, mime };
    }
  } catch {
    if (controle.signal.aborted) return { ok: false, motivo: 'tempo_esgotado' };
    return { ok: false, motivo: 'falha_de_rede' };
  } finally {
    clearTimeout(relogio);
  }
}

/** Sobe os bytes para `whatsapp-media`. `true` = o arquivo está no destino. */
export type SubirImagem = (caminho: string, bytes: Uint8Array, mime: string) => Promise<boolean>;

export function subirImagemNoStorage(): SubirImagem {
  return async (caminho, bytes, mime) => {
    const { error } = await createAdminClient()
      .storage.from(BUCKET_DA_CONVERSA)
      .upload(caminho, bytes, { contentType: mime, upsert: true });
    return !error;
  };
}

export type FotoDaReceitaPreparada =
  | { ok: true; foto: FotoParaEnvio }
  // Erro de ENSINO: nada deve sair; o modelo corrige e tenta de novo.
  | { ok: false; code: 'imagem_fora_da_receita'; message: string }
  // Falha de mídia: o texto sai sozinho e o motivo vai ao modelo.
  | { ok: false; code: 'imagem_indisponivel'; message: string; motivo: string };

export const MENSAGEM_IMAGEM_FORA_DA_RECEITA =
  'essa imagem_url não veio de uma consulta de receita neste turno. Use a `imagem_url` que ' +
  'crm_consultar_receita devolveu para o item, ou envie sem imagem_url.';

export async function prepararFotoDaReceita(
  input: { url: string; conversationId: string; tenantId: string },
  imagens: ImagensDaReceitaNoTurno,
  deps: DepsDoDownload & {
    subir: SubirImagem;
    log?: { warn(msg: string, fields?: Record<string, unknown>): void };
  },
): Promise<FotoDaReceitaPreparada> {
  if (!imagens.tem(input.url)) {
    return { ok: false, code: 'imagem_fora_da_receita', message: MENSAGEM_IMAGEM_FORA_DA_RECEITA };
  }
  const indisponivel = (motivo: string): FotoDaReceitaPreparada => {
    // Só o host no log: a URL inteira pode carregar token do site do cliente.
    deps.log?.warn('foto da receita não enviada; o texto sai sozinho', {
      host: hostDaUrl(input.url),
      motivo,
    });
    return {
      ok: false,
      code: 'imagem_indisponivel',
      motivo,
      message:
        `a foto do item não pôde ser enviada (${motivo}); o texto foi. ` +
        'Não diga ao cliente que mandou a foto.',
    };
  };
  try {
    const baixada = await baixarImagemDaReceita(input.url, deps);
    if (!baixada.ok) return indisponivel(baixada.motivo);
    // Destino determinístico: reenviar o mesmo item na mesma conversa reaproveita o arquivo.
    const hash = createHash('sha256').update(input.url).digest('hex').slice(0, 16);
    const caminho = `${input.tenantId}/${input.conversationId}/receita-${hash}.${EXTENSAO[baixada.mime]}`;
    if (!(await deps.subir(caminho, baixada.bytes, baixada.mime))) return indisponivel('upload_falhou');
    return { ok: true, foto: { storagePath: caminho, mime: baixada.mime } };
  } catch {
    return indisponivel('erro_inesperado');
  }
}
