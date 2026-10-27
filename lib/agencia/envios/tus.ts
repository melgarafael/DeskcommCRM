/**
 * Envio em partes (protocolo TUS) direto do navegador ao Storage da VPS
 * (SPEC-envios, E3). Sem dependência nova: o protocolo é pequeno. Cada parte tem
 * 6 MB (exigência do Storage do Supabase); se a rede cair, pergunta ao servidor
 * em que byte parou (HEAD) e continua dali.
 */

export interface PermissaoDoEnvio {
  endpoint: string;
  assinatura: string;
  chavePublica: string;
  bucket: string;
  caminho: string;
  parte: number;
}

const TENTATIVAS_POR_PARTE = 6;

function base64(texto: string): string {
  return btoa(unescape(encodeURIComponent(texto)));
}

/** O endereço da sessão, na MESMA origem do endpoint (atrás de proxy, o Storage pode devolver o host interno). */
function enderecoDaSessao(location: string, endpoint: string): string {
  const u = new URL(location, endpoint);
  const e = new URL(endpoint);
  return u.origin === e.origin ? u.toString() : `${e.origin}${u.pathname}`;
}

function enviarParte(url: string, cabecalhos: Record<string, string>, corpo: Blob, aoAndar: (bytes: number) => void, sinal?: AbortSignal): Promise<number> {
  return new Promise((ok, falha) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PATCH", url);
    for (const [k, v] of Object.entries(cabecalhos)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && aoAndar(e.loaded);
    xhr.onload = () => (xhr.status === 204 ? ok(Number(xhr.getResponseHeader("Upload-Offset") ?? "NaN")) : falha(new Error(`Storage respondeu ${xhr.status}`)));
    xhr.onerror = () => falha(new Error("Conexão caiu"));
    xhr.onabort = () => falha(new DOMException("Cancelado", "AbortError"));
    sinal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(corpo);
  });
}

export async function enviarEmPartes(arquivo: File, p: PermissaoDoEnvio, aoProgredir: (fracao: number) => void, sinal?: AbortSignal): Promise<void> {
  const comuns = { "Tus-Resumable": "1.0.0", "x-signature": p.assinatura, apikey: p.chavePublica };
  const criar = await fetch(p.endpoint, {
    method: "POST",
    headers: {
      ...comuns,
      "Upload-Length": String(arquivo.size),
      "Upload-Metadata": [
        `bucketName ${base64(p.bucket)}`,
        `objectName ${base64(p.caminho)}`,
        `contentType ${base64(arquivo.type || "application/octet-stream")}`,
        `cacheControl ${base64("3600")}`,
      ].join(","),
    },
    signal: sinal,
  });
  const location = criar.headers.get("Location");
  if (criar.status !== 201 || !location) throw new Error(`O armazenamento não abriu o envio (${criar.status}).`);
  const sessao = enderecoDaSessao(location, p.endpoint);

  let offset = 0;
  let tentativas = 0;
  while (offset < arquivo.size) {
    const fim = Math.min(offset + p.parte, arquivo.size);
    try {
      // Sem o cabeçalho (CORS que não o expõe), a parte inteira entrou: o servidor respondeu 204.
      const devolvido = await enviarParte(
        sessao,
        { ...comuns, "Upload-Offset": String(offset), "Content-Type": "application/offset+octet-stream" },
        arquivo.slice(offset, fim),
        (n) => aoProgredir(Math.min(1, (offset + n) / arquivo.size)),
        sinal,
      );
      offset = Number.isFinite(devolvido) ? devolvido : fim;
      tentativas = 0;
      aoProgredir(offset / arquivo.size);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      if (++tentativas > TENTATIVAS_POR_PARTE) throw new Error("A conexão caiu várias vezes. Tente de novo.");
      await new Promise((r) => setTimeout(r, 1000 * tentativas));
      // Retomada: em que byte o servidor parou?
      const h = await fetch(sessao, { method: "HEAD", headers: comuns, signal: sinal }).catch(() => null);
      const o = Number(h?.headers.get("Upload-Offset") ?? "NaN");
      if (Number.isFinite(o)) offset = o;
    }
  }
  aoProgredir(1);
}
