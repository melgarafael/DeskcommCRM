/**
 * Monta o payload EMV Pix (BR Code) estático — copia-e-cola e QR.
 * Sem PSP: a confirmação do pagamento fica no banco do recebedor.
 *
 * Spec Bacen: Payload Format Indicator + Merchant Account Information
 * (GUI BR.GOV.BCB.PIX + chave) + MCC + moeda 986 + valor opcional + BR +
 * nome + cidade + Additional Data (txid) + CRC16-CCITT.
 */

export interface EmvPixInput {
  /** Chave já normalizada (CPF/CNPJ só dígitos; e-mail; telefone +55…; UUID). */
  chave: string;
  /** Nome do recebedor (máx. 25 no EMV). */
  nome: string;
  /** Cidade (máx. 15). Default SAO PAULO se vazio. */
  cidade?: string;
  /** Valor em reais (ex.: 10.5). Omitir = chave sem valor. */
  valor?: number;
  /** Identificador da transação (máx. 25). Default *** (estático). */
  txid?: string;
}

function tlv(id: string, valor: string): string {
  const len = valor.length.toString().padStart(2, "0");
  return `${id}${len}${valor}`;
}

/** CRC16-CCITT-FALSE (poly 0x1021, init 0xFFFF) — obrigatório no campo 63. */
export function crc16Ccitt(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function sanitizarNome(nome: string, max: number): string {
  const limpo = nome
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  return (limpo || "RECEBEDOR").slice(0, max);
}

/**
 * Gera o BR Code completo (string copia-e-cola).
 */
export function montarEmvPix(input: EmvPixInput): string {
  const chave = input.chave.trim();
  if (!chave) throw new Error("Chave Pix vazia.");

  const nome = sanitizarNome(input.nome, 25);
  const cidade = sanitizarNome(input.cidade ?? "SAO PAULO", 15);
  const txid = (input.txid ?? "***").replace(/[^A-Za-z0-9]/g, "").slice(0, 25) || "***";

  const merchantAccount =
    tlv("00", "BR.GOV.BCB.PIX") + tlv("01", chave);

  let payload =
    tlv("00", "01") +
    tlv("26", merchantAccount) +
    tlv("52", "0000") +
    tlv("53", "986");

  if (input.valor !== undefined && input.valor > 0) {
    const valorStr = input.valor.toFixed(2);
    payload += tlv("54", valorStr);
  }

  payload +=
    tlv("58", "BR") +
    tlv("59", nome) +
    tlv("60", cidade) +
    tlv("62", tlv("05", txid));

  // Campo 63: CRC — inclui o próprio ID+len sem o valor ainda.
  const comCrcVazio = payload + "6304";
  return comCrcVazio + crc16Ccitt(comCrcVazio);
}

/** Texto amigável para enviar a chave sem cobrança. */
export function formatarMensagemChave(opts: {
  nome: string;
  keyType: string;
  keyValue: string;
}): string {
  const tipoLabel: Record<string, string> = {
    cpf: "CPF",
    cnpj: "CNPJ",
    email: "E-mail",
    random: "Chave aleatória",
    phone: "Celular",
  };
  const tipo = tipoLabel[opts.keyType] ?? opts.keyType;
  return [
    `*Pix — ${opts.nome}*`,
    `Tipo: ${tipo}`,
    `Chave: ${opts.keyValue}`,
  ].join("\n");
}

/** Legenda da cobrança (vai junto do QR). */
export function formatarMensagemCobranca(opts: {
  nome: string;
  valorReais: number;
  emv: string;
  description?: string;
}): string {
  const valor = opts.valorReais.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
  const linhas = [`*Cobrança Pix — ${opts.nome}*`, `Valor: ${valor}`];
  if (opts.description?.trim()) linhas.push(opts.description.trim());
  linhas.push("", "Copia e cola:", opts.emv);
  return linhas.join("\n");
}
