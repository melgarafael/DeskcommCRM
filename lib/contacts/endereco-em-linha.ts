/**
 * ENDEREÇO EM UMA LINHA — uma decisão, um lugar.
 *
 * O endereço do contato mora em colunas estruturadas (`logradouro`,
 * `numero_end`, `complemento`, `bairro`, `cidade`, `uf`, `cep`), mas três
 * lugares precisam da mesma cadeia pronta: `endereco_entrega` do pedido
 * (romaneio, impressão, mapa), o prefill do editor e o backfill histórico.
 * Cada um montava do seu jeito — "Rua X, 123" aqui, "Rua X 123 - bairro" ali
 * — e o romaneio mostrava "Endereço não informado" para cliente COM endereço.
 *
 * A regra: rua + número + complemento, depois bairro + cidade/UF + CEP, só
 * com o que existir. Vazio de verdade devolve "" — quem decide o literal de
 * ausência ("Endereço não informado") é a tela, não o formatador.
 */

/** O que qualquer endereço estruturado precisa ter para virar linha. */
export interface EnderecoEstruturado {
  logradouro?: string | null;
  numero_end?: string | null;
  complemento?: string | null;
  bairro?: string | null;
  cidade?: string | null;
  uf?: string | null;
  cep?: string | null;
}

function limpo(v: string | null | undefined): string {
  return (v ?? "").trim().replace(/\s+/g, " ");
}

/**
 * "Rua Antônio Liller, 585 — Centro, Canoinhas/SC, 89460-000".
 * CEP sai como está no banco (só dígitos ou com hífen, sem inventar formato).
 */
export function enderecoEmLinha(e: EnderecoEstruturado | null | undefined): string {
  if (!e) return "";
  const numero = limpo(e.numero_end);
  // O WP importava "rua + número" colados no logradouro E o número separado
  // ("RUA X, 65" + numero_end "65" → "65, 65"). O sufixo repetido sai.
  let rua = limpo(e.logradouro);
  if (rua && numero) {
    const esc = numero.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    rua = rua.replace(new RegExp(`[\\s,\\-]+${esc}$`, "i"), "").trim();
  }
  const compl = limpo(e.complemento);
  const bairro = limpo(e.bairro);
  const cidade = limpo(e.cidade);
  const uf = limpo(e.uf).toUpperCase();
  const cep = limpo(e.cep);

  const primeira = [rua + (numero ? `, ${numero}` : ""), compl].filter(Boolean).join(" — ");
  const municipio = [cidade, uf].filter(Boolean).join("/");
  const segunda = [bairro, municipio, cep].filter(Boolean).join(", ");
  return [primeira, segunda].filter(Boolean).join(" — ");
}
