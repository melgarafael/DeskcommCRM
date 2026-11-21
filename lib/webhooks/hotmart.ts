/**
 * Normalizador dedicado do Hotmart (webhook 2.0.0) — irmão de
 * `lib/webhooks/elementor.ts`, `lib/webhooks/rdstation.ts` e
 * `lib/webhooks/respondi.ts`.
 *
 * ═══ O BUG ═══
 *
 * O aviso de compra do Hotmart chega com DOIS níveis de envelope:
 *
 *   { "id": "…", "event": "PURCHASE_APPROVED", "version": "2.0.0",
 *     "data": { "buyer": { "name": …, "email": …, "checkout_phone": … },
 *               "purchase": { "transaction": …, "status": … }, … } }
 *
 * `mapInboundPayload` (`inbound.ts`) só olha CHAVE DE TOPO — objeto aninhado é
 * descartado por desenho ("v1") —, então `name`/`phone`/`email` batiam `null`
 * para os TRÊS, a rota devolvia 400 `sem_campo_mapeavel` e a compra aprovada não
 * casava contato nenhum: o card aberto do comprador no funil ficava parado e a
 * etapa de ganho vazia.
 *
 * A solução é a mesma dos três irmãos: detecção ESTRITA da forma + normalizador
 * dedicado, chamado ANTES do genérico e SEM tocar nele. Qualquer outro envio
 * (flat, Zapier, n8n, o botão "Enviar lead de teste") segue `mapInboundPayload`
 * inalterado.
 *
 * ═══ CAMINHOS DECLARADOS, NUNCA VARREDURA ═══
 *
 * Os quatro caminhos de identidade são os da documentação do evento 2.0.0
 * (developers.hotmart.com/docs/en/2.0.0/webhook/purchase-webhook), listados em
 * `CAMINHOS_DO_HOTMART` e lidos UM A UM. Este módulo não procura "qualquer
 * chave parecida com telefone" em lugar nenhum: um caminho ausente devolve
 * `null`, nunca um valor inventado a partir de outro bloco.
 *
 * ═══ NOME: DOIS CAMINHOS, UM VENCEDOR DECLARADO ═══
 *
 * O comprador vem com o nome completo (`data.buyer.name`) E com as partes
 * (`first_name`, `last_name`). Quando os dois existem e discordam, vence o
 * caminho mais específico — o nome completo, que é o que o comprador digitou —,
 * e a escolha fica registrada em `source_metadata.hotmart_campo_ambiguo`. Sem
 * ambiguidade não há registro: o metadado é sinal, não ruído.
 *
 * O mesmo vale para o país do telefone: `data.buyer.address.country_iso` é o
 * endereço do comprador (mais específico) e vence `data.purchase.checkout_country.iso`
 * quando os dois discordam.
 *
 * ═══ TELEFONE ═══
 *
 * Comprador brasileiro manda o número SEM o DDD em `checkout_phone` e o DDD
 * separado em `checkout_phone_code` — é o DDD que é composto aqui, e só quando o
 * número ainda não traz o código do país. Comprador de fora já traz o código do
 * país junto do número; nesse caso o `+` é acrescentado para o
 * `normalizePhoneBR` reconhecer a forma internacional (a mesma regra que ele já
 * aplica a qualquer telefone com `+`).
 *
 * ═══ ESCOPO ═══
 *
 * Só a RECEPÇÃO do webhook. Não integra com a API do Hotmart, não cria
 * assinatura e não lê `data.buyer.address` além do país (endereço completo não é
 * dado de card). O que sobra do evento vai como metadado NOMEADO (`hotmart_*`):
 * transação, status, produto, oferta e preço — o suficiente para quem abre o
 * card saber de que compra se trata.
 */
import type { MappedLead } from "@/lib/webhooks/inbound";
import { normalizePhoneBR } from "@/lib/webhooks/inbound";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** String não-vazia (trim) ou null. */
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Os caminhos DECLARADOS do evento 2.0.0 — a lista fechada que este leitor lê.
 * Nomeá-los num lugar só é o que permite provar, no teste, que nenhum deles é
 * alcançado por varredura: quem não está aqui não é lido.
 */
export const CAMINHOS_DO_HOTMART = {
  evento: "event",
  nome: "data.buyer.name",
  primeiroNome: "data.buyer.first_name",
  sobrenome: "data.buyer.last_name",
  email: "data.buyer.email",
  telefone: "data.buyer.checkout_phone",
  ddd: "data.buyer.checkout_phone_code",
  paisDoComprador: "data.buyer.address.country_iso",
  paisDoCheckout: "data.purchase.checkout_country.iso",
  transacao: "data.purchase.transaction",
  status: "data.purchase.status",
  produto: "data.product.name",
  oferta: "data.purchase.offer.code",
  preco: "data.purchase.price.value",
  moeda: "data.purchase.price.currency_value",
} as const;

/** O valor do caminho declarado, ou `null` quando qualquer degrau falta. */
function noCaminho(payload: unknown, caminho: string): unknown {
  let atual: unknown = payload;
  for (const degrau of caminho.split(".")) {
    if (!isRecord(atual)) return null;
    atual = atual[degrau];
  }
  return atual;
}

export interface HotmartPayload {
  event: string;
  data: Record<string, unknown>;
}

/**
 * True só quando o payload tem a forma inconfundível do webhook de compra do
 * Hotmart: o `event` é da família `PURCHASE_*` (a lista fechada da
 * documentação) e existe o bloco `data` com pelo menos um dos blocos do evento
 * (`buyer`, `purchase` ou `product`).
 *
 * Deliberadamente estrita, como os irmãos: um payload de outra origem que por
 * acaso tenha `data` não é capturado por engano.
 */
export function isHotmartPayload(payload: unknown): payload is HotmartPayload {
  if (!isRecord(payload)) return false;
  const evento = str(payload.event);
  if (!evento || !/^PURCHASE_[A-Z_]+$/.test(evento)) return false;
  const data = payload.data;
  if (!isRecord(data)) return false;
  return isRecord(data.buyer) || isRecord(data.purchase) || isRecord(data.product);
}

export interface HotmartMapped extends MappedLead {
  externalId: string | null;
}

/** Nome do comprador: o completo vence; sem ele, as partes declaradas. */
function nomeDoComprador(payload: unknown): { nome: string | null; ambiguo: boolean } {
  const completo = str(noCaminho(payload, CAMINHOS_DO_HOTMART.nome));
  const primeiro = str(noCaminho(payload, CAMINHOS_DO_HOTMART.primeiroNome));
  const sobrenome = str(noCaminho(payload, CAMINHOS_DO_HOTMART.sobrenome));
  const partes = [primeiro, sobrenome].filter((p): p is string => p !== null).join(" ").trim() || null;
  if (!completo) return { nome: partes, ambiguo: false };
  // Dois caminhos com valores DIFERENTES: o completo é o mais específico e vence.
  return { nome: completo, ambiguo: partes !== null && partes !== completo };
}

/** O país declarado: o endereço do comprador vence o país do checkout. */
function paisDoComprador(payload: unknown): { pais: string | null; ambiguo: boolean } {
  const doComprador = str(noCaminho(payload, CAMINHOS_DO_HOTMART.paisDoComprador));
  const doCheckout = str(noCaminho(payload, CAMINHOS_DO_HOTMART.paisDoCheckout));
  const normal = (p: string | null) => (p ? p.trim().toUpperCase() : null);
  const a = normal(doComprador);
  const b = normal(doCheckout);
  if (!a && !b) return { pais: null, ambiguo: false };
  return { pais: a ?? b, ambiguo: a !== null && b !== null && a !== b };
}

/**
 * O telefone do comprador, a partir dos dois caminhos declarados.
 *
 * Regras, na ordem:
 * 1. o número declarado, como veio;
 * 2. número brasileiro SEM o código do país e com `checkout_phone_code`
 *    presente: o DDD é composto (`31` + `999999999`);
 * 3. comprador de país que não é o Brasil, número sem `+` e ainda sem código de
 *    país: o `+` é acrescentado — é a forma que o Hotmart documenta ("o código
 *    de área do comprador vai junto do número") e a única que o
 *    `normalizePhoneBR` reconhece como internacional.
 */
function telefoneDoComprador(payload: unknown, pais: string | null): string | null {
  const bruto = str(noCaminho(payload, CAMINHOS_DO_HOTMART.telefone));
  if (!bruto) return null;
  const digitos = bruto.replace(/\D/g, "");
  if (!digitos) return null;

  const ddd = str(noCaminho(payload, CAMINHOS_DO_HOTMART.ddd));
  const dddDigitos = ddd ? ddd.replace(/\D/g, "") : "";
  // O `checkout_phone` do comprador brasileiro vem SEM o DDD (o do fixture,
  // documentado, tem 9 dígitos) e o DDD vem separado. Número que já traz o DDD
  // (10–11 dígitos) ou o código do país (12–13 começando em 55) não é composto
  // de novo.
  const semDDD = digitos.length === 8 || digitos.length === 9;
  if (bruto.startsWith("+")) return bruto;
  if (dddDigitos && semDDD) return `+55${dddDigitos}${digitos}`;
  // Fora do Brasil, o código do país vem junto e SEM o `+`.
  if (pais && pais !== "BR" && digitos.length >= 8 && digitos.length <= 15) return `+${digitos}`;
  return bruto;
}

/** Extrai identidade + metadados do evento de compra. Puro, sem I/O. */
export function mapHotmartPayload(payload: unknown): HotmartMapped {
  const { nome, ambiguo: nomeAmbiguo } = nomeDoComprador(payload);
  const { pais, ambiguo: paisAmbiguo } = paisDoComprador(payload);
  const email = str(noCaminho(payload, CAMINHOS_DO_HOTMART.email));
  const telefoneBruto = telefoneDoComprador(payload, pais);
  const phone = normalizePhoneBR(telefoneBruto);

  const transacao = str(noCaminho(payload, CAMINHOS_DO_HOTMART.transacao));
  const custom_fields: Record<string, string> = {};
  const setCf = (chave: string, valor: string | null): void => {
    if (valor !== null) custom_fields[chave] = valor;
  };
  setCf("hotmart_event", str(noCaminho(payload, CAMINHOS_DO_HOTMART.evento)));
  setCf("hotmart_transaction", transacao);
  setCf("hotmart_status", str(noCaminho(payload, CAMINHOS_DO_HOTMART.status)));
  setCf("hotmart_produto", str(noCaminho(payload, CAMINHOS_DO_HOTMART.produto)));
  setCf("hotmart_oferta", str(noCaminho(payload, CAMINHOS_DO_HOTMART.oferta)));
  const preco = noCaminho(payload, CAMINHOS_DO_HOTMART.preco);
  setCf(
    "hotmart_preco",
    typeof preco === "number" ? String(preco) : str(preco),
  );
  setCf("hotmart_moeda", str(noCaminho(payload, CAMINHOS_DO_HOTMART.moeda)));

  const source_metadata: Record<string, string> = {};
  // A escolha entre dois caminhos com valores diferentes fica registrada; sem
  // ambiguidade, nada é gravado.
  if (nomeAmbiguo) source_metadata.hotmart_campo_ambiguo = `nome:${CAMINHOS_DO_HOTMART.nome}`;
  if (paisAmbiguo) source_metadata.hotmart_campo_ambiguo = `pais:${CAMINHOS_DO_HOTMART.paisDoComprador}`;
  // Telefone digitado que não normaliza não some: fica como rastro, igual ao genérico.
  if (!phone && telefoneBruto) source_metadata.raw_phone = telefoneBruto;

  return {
    name: nome,
    phone,
    email,
    custom_fields,
    source_metadata,
    // A transação é o identificador da COMPRA: `PURCHASE_APPROVED` e depois
    // `PURCHASE_COMPLETE` da mesma compra caem no MESMO card (#2316), e o
    // retry do Hotmart não abre um segundo. Sem transação não há identidade de
    // integração — e aí o reuso do card aberto (#3101) é quem decide.
    externalId: transacao ? `hotmart:${transacao}` : null,
  };
}
