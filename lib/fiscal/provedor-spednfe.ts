/**
 * O PROVEDOR SPED-NFE — cliente HTTP do sidecar (`fiscal/sidecar/`).
 *
 * Fala com o serviço na rede privada (FISCAL_SIDECAR_URL + secret). Erro de
 * rede, timeout ou resposta fora do contrato vira `erro` — nunca exceção
 * estourada na rota, e nunca "autorizada" presumida.
 */

import type { ResultadoDeEmissao } from "./provedor";
import { montarPayloadSped, type EmitenteSped, type ItemSped } from "./sped-payload";

export interface EntradaSpedNfe {
  emitente: EmitenteSped;
  senhaCertificado: string;
  pedido: { numero: number; nome: string; documento: string | null; frete_cents: number };
  itens: ItemSped[];
}

export async function emitirViaSpedNfe(entrada: EntradaSpedNfe): Promise<ResultadoDeEmissao> {
  const montado = montarPayloadSped(entrada.emitente, entrada.senhaCertificado, entrada.pedido, entrada.itens);
  if (!montado.ok) {
    return { status: "erro", erro: `Falta ${montado.falta}.`, numero: null, chave_acesso: null, xml: null };
  }

  const base = process.env.FISCAL_SIDECAR_URL?.trim();
  const segredo = process.env.FISCAL_SIDECAR_SECRET?.trim();
  if (!base || !segredo) {
    return {
      status: "erro",
      erro: "Sidecar fiscal fora do ar (FISCAL_SIDECAR_URL/SECRET ausentes).",
      numero: null,
      chave_acesso: null,
      xml: null,
    };
  }

  const controle = new AbortController();
  const limite = setTimeout(() => controle.abort(), 120000);
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/emitir`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Fiscal-Secret": segredo },
      body: JSON.stringify(montado.payload),
      signal: controle.signal,
    });
    const corpo = (await res.json().catch(() => null)) as {
      ok: boolean;
      chave?: string;
      protocolo?: string;
      numero?: number;
      serie?: string;
      xml?: string;
      cstat?: string;
      xmotivo?: string;
      codigo?: string;
      mensagem?: string;
    } | null;
    if (!corpo) {
      return { status: "erro", erro: "Sidecar respondeu fora do contrato (não-JSON).", numero: null, chave_acesso: null, xml: null };
    }
    if (corpo.ok) {
      return {
        status: "autorizada",
        erro: null,
        numero: corpo.numero ?? null,
        chave_acesso: corpo.chave ?? null,
        xml: corpo.xml ?? null,
        protocolo: corpo.protocolo ?? null,
        sefaz_cstat: corpo.cstat ?? null,
        sefaz_xmotivo: corpo.xmotivo ?? null,
      };
    }
    return {
      status: "erro",
      erro: `SEFAZ/sidecar [${corpo.codigo ?? "?"}]: ${corpo.mensagem ?? "sem motivo"}`,
      numero: null,
      chave_acesso: null,
      xml: null,
      sefaz_cstat: corpo.codigo ?? null,
      sefaz_xmotivo: corpo.mensagem ?? null,
    };
  } catch (e) {
    const msg = e instanceof Error && e.name === "AbortError" ? "tempo esgotado (120s)" : "inalcançável";
    return { status: "erro", erro: `Sidecar fiscal ${msg}.`, numero: null, chave_acesso: null, xml: null };
  } finally {
    clearTimeout(limite);
  }
}
