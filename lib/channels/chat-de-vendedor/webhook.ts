/**
 * A entrada do canal do chat de vendedor (issue #2927) — o que a rota genérica
 * de webhook precisa perguntar antes de entregar o corpo ao seam.
 *
 * ─── A OLX não assina o webhook (medido na doc pública) ─────────────────────
 *
 * Dos três canais que já recebem por `/api/v1/webhooks/channel/<token>`, este
 * é o primeiro cujo provedor não tem esquema de assinatura: a documentação da
 * OLX (`developers.olx.com.br/chat/receive_message.html`) descreve o POST, os
 * campos e as respostas, e o único reforço que oferece é o IP de saída
 * `54.162.151.93` — filtro que seria ilusório aplicar aqui, porque quem entrega
 * passa antes pelo proxy da instalação (Caddy), que enxerga o IP do proxy e não
 * o da OLX.
 *
 * Então o autenticador desta entrega é o PRÓPRIO token do path: aleatório,
 * gerado por nós (24 bytes em hex), por SESSÃO, registrado na conta do vendedor
 * no momento da conexão e conferido pela rota ANTES de qualquer leitura — a
 * mesma arquitetura do webhook de captação de leads (`/api/v1/webhooks/in/<token>`),
 * que também vive só do segredo do caminho.
 *
 * ─── E por que ainda passa por aqui ─────────────────────────────────────────
 *
 * Porque há uma segunda pergunta que o token do path não responde: o canal
 * está LIGADO nesta instalação? Sem este corte, um `OLX_ENABLED` desligado
 * continuaria aceitando entrega em todo self-hoster que já tivesse uma sessão
 * gravada — que é exatamente o vazamento que a opção desligada por padrão
 * existe para impedir (critério de sucesso A).
 *
 * Se a OLX publicar assinatura, o HMAC entra neste módulo e passa a ser
 * exigido aqui — o lugar em que os outros dois canais conferem o deles.
 */
import { canalChatDeVendedorLigado } from "./credentials";

/**
 * A entrega pode ser processada? `secret` não entra: a coluna
 * `webhook_secret_encrypted` desta canal guarda um provisório que nunca confere
 * (é NOT NULL no schema), e quem autentica é o token do path, já conferido
 * pela rota. A resposta depende do interruptor da instalação.
 */
export function entradaChatDeVendedorAceitavel(): boolean {
  return canalChatDeVendedorLigado();
}
