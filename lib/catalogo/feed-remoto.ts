import "server-only";

import { assertUrlDeMidiaSegura } from "@/lib/messaging/media/url-de-midia-externa";

/**
 * BUSCAR O FEED DA REVENDA — de dentro da rede, com a URL escolhida por alguém.
 *
 * ─── A URL é entrada de fora e o `fetch` é de DENTRO ────────────────────────
 *
 * Quem cadastra a fonte é o dono da loja, e o servidor vai buscar esse endereço
 * a cada rodada. Sem guarda, "https://minha-loja.example/estoque.json" pode ser
 * `http://169.254.169.254/latest/meta-data/iam/security-credentials/` — o
 * endereço de metadados da instância, que entrega credencial de nuvem a quem
 * pedir. `assertUrlDeMidiaSegura` é a MESMA guarda da foto por URL da fatia 1
 * (esquema, host literal privado e o IP RESOLVIDO, porque um hostname público
 * pode apontar para dentro): uma segunda guarda aqui divergiria da primeira na
 * primeira correção de segurança.
 *
 * Redirecionamento é seguido À MÃO, uma casa por vez, com a guarda rodando de
 * novo em cada `Location` — `redirect: "follow"` deixaria o salto para o
 * endereço interno acontecer DEPOIS da conferência.
 *
 * ─── O teto de bytes não é decoração ────────────────────────────────────────
 *
 * `content-length` é opcional: uma origem em `chunked` mandaria o que quisesse
 * durante todo o prazo, e o processo que serve o CRM é o mesmo que atende as
 * conversas. A leitura para no teto e o feed é recusado — catálogo grande
 * demais é erro de configuração, não motivo para derrubar a instância.
 */

/** O teto do feed: 8 MB é folgado para 100 mil itens de loja de bairro. */
export const TETO_DO_FEED_BYTES = 8 * 1024 * 1024;

/** O prazo de UMA busca. Um feed lento não pode prender a rota nem o cron. */
const PRAZO_MS = 20_000;

/** Quantos saltos ainda são "o mesmo link" (http→https, CDN da revenda). */
const MAXIMO_DE_SALTOS = 3;

export type LeituraDoFeedRemoto = { ok: true; texto: string } | { ok: false; motivo: string };

/**
 * Lê aos poucos e PARA ao passar do teto — `null` quando passou.
 * Mesmo desenho de `lerAteOTeto` (lib/catalogo/fotos-por-url.ts).
 */
async function lerAteOTeto(resposta: Response): Promise<string | null> {
  const leitor = resposta.body?.getReader();
  if (!leitor) return "";
  const decodificador = new TextDecoder();
  let recebido = 0;
  let texto = "";
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    recebido += value.byteLength;
    if (recebido > TETO_DO_FEED_BYTES) {
      await leitor.cancel().catch(() => undefined);
      return null;
    }
    texto += decodificador.decode(value, { stream: true });
  }
  return texto + decodificador.decode();
}

/**
 * O texto do feed, ou o motivo da recusa. Nunca lança: quem chama decide o que
 * fazer com a falha (a rota responde 422; o cron registra e vai para a próxima
 * fonte).
 */
export async function buscarFeedDaUrl(url: string): Promise<LeituraDoFeedRemoto> {
  let destino = url;
  for (let salto = 0; salto <= MAXIMO_DE_SALTOS; salto += 1) {
    try {
      await assertUrlDeMidiaSegura(destino);
    } catch {
      return {
        ok: false,
        motivo: "o endereço do feed não é permitido — use uma URL http(s) pública",
      };
    }

    let resposta: Response;
    try {
      resposta = await fetch(destino, {
        redirect: "manual",
        signal: AbortSignal.timeout(PRAZO_MS),
        headers: { accept: "application/json, text/csv;q=0.9, */*;q=0.5" },
      });
    } catch (erro) {
      const detalhe = erro instanceof Error ? erro.message : String(erro);
      return { ok: false, motivo: `não foi possível buscar o feed (${detalhe.slice(0, 200)})` };
    }

    // O salto é conferido no PRÓXIMO giro do laço, com a guarda rodando antes
    // de qualquer requisição ao endereço novo.
    if (resposta.status >= 300 && resposta.status < 400) {
      const local = resposta.headers.get("location");
      if (!local) return { ok: false, motivo: `a origem respondeu ${resposta.status} sem destino` };
      destino = new URL(local, destino).toString();
      continue;
    }

    if (!resposta.ok) {
      return { ok: false, motivo: `a origem respondeu ${resposta.status}` };
    }

    const texto = await lerAteOTeto(resposta);
    if (texto === null) {
      return {
        ok: false,
        motivo: `o feed passa de ${Math.round(TETO_DO_FEED_BYTES / 1024 / 1024)} MB`,
      };
    }
    // Página de erro em HTML responderia 200 e um JSON inválido depois: recusar
    // aqui dá a mensagem certa em vez de "feed vazio" — e "feed vazio" DESATIVA
    // o catálogo inteiro.
    if (/^\s*</.test(texto)) {
      return { ok: false, motivo: "a origem respondeu uma página HTML, não um feed" };
    }
    if (texto.trim() === "") return { ok: false, motivo: "a origem respondeu um feed vazio" };
    return { ok: true, texto };
  }
  return { ok: false, motivo: "o feed redirecionou vezes demais" };
}
