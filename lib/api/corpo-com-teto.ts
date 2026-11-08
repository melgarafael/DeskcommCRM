/**
 * Lê o corpo de um upload sem nunca guardar mais que `teto` bytes na memória.
 *
 * As rotas de upload conferiam o `content-length` DECLARADO e depois chamavam
 * `req.formData()` / `req.text()`. Só que um envio em partes (chunked) não
 * declara tamanho nenhum: `Number(null ?? 0)` vira 0, passa pela conferência, e
 * o corpo inteiro era materializado antes de o `file.size` ser olhado. Aqui:
 *
 *   - sem `content-length`, ou com valor que não é inteiro → 411;
 *   - declarado acima do teto → 413, sem ler um byte;
 *   - o stream é lido contando bytes e abortado no primeiro byte além do
 *     DECLARADO (que já é ≤ teto) → 413. O declarado vira teto porque um corpo
 *     maior que o próprio cabeçalho é malformado, e é o que impede o cabeçalho
 *     de mentir para baixo.
 *
 * Devolve um `Response` com os bytes e o `content-type` original: no runtime
 * Node do Next 16 o `Response` é o do undici, e `.formData()` (multipart
 * inclusive) e `.text()` funcionam nele como funcionariam na Request. Clientes
 * reais (navegador, `curl -F`, Playwright) sempre declaram o tamanho de um
 * multipart, então o 411 só alcança quem envia em partes de propósito.
 */
import { fail } from "@/lib/api/wrappers";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO, type Idioma } from "@/lib/i18n/idiomas";

interface Opcoes {
  requestId: string;
  idioma?: Idioma;
  headers?: HeadersInit;
  /** A recusa por tamanho no vocabulário da rota, JÁ traduzida. */
  acimaDoTeto?: string;
  /** Código de erro do 413 quando a rota já tinha contrato próprio. */
  codigo?: string;
}

export type CorpoComTeto = { ok: true; corpo: Response } | { ok: false; response: Response };

export async function lerCorpoComTeto(
  req: Request,
  teto: number,
  opcoes: Opcoes,
): Promise<CorpoComTeto> {
  const { requestId, headers } = opcoes;
  const t = (texto: string) => traduzir(texto, opcoes.idioma ?? IDIOMA_PADRAO);
  const recusa = (response: Response): CorpoComTeto => ({ ok: false, response });
  const grande = () =>
    recusa(
      fail(
        opcoes.codigo ?? "payload_too_large",
        opcoes.acimaDoTeto ?? t("O envio passa do tamanho máximo aceito."),
        413,
        { requestId, headers },
      ),
    );

  const bruto = req.headers.get("content-length")?.trim() ?? "";
  if (!/^\d+$/.test(bruto)) {
    return recusa(
      fail(
        "length_required",
        t("O envio precisa declarar o tamanho (cabeçalho Content-Length)."),
        411,
        { requestId, headers },
      ),
    );
  }
  const declarado = Number(bruto);
  if (declarado > teto) return grande();

  const partes: Uint8Array[] = [];
  let lidos = 0;
  if (req.body) {
    const leitor = req.body.getReader();
    try {
      while (true) {
        const { done, value } = await leitor.read();
        if (done) break;
        lidos += value.byteLength;
        if (lidos > declarado) {
          await leitor.cancel().catch(() => undefined);
          return grande();
        }
        partes.push(value);
      }
    } catch {
      return recusa(
        fail("invalid_request", t("Falha ao ler o arquivo enviado."), 400, { requestId, headers }),
      );
    }
  }

  const bytes = new Uint8Array(lidos);
  let posicao = 0;
  for (const parte of partes) {
    bytes.set(parte, posicao);
    posicao += parte.byteLength;
  }
  const tipo = req.headers.get("content-type");
  return {
    ok: true,
    corpo: new Response(bytes, {
      headers: tipo ? { "content-type": tipo } : undefined,
    }),
  };
}
