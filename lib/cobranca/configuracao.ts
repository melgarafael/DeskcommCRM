/**
 * A CONFIGURAÇÃO DA COBRANÇA NA INSTALAÇÃO (spec cobrança do revendedor §10).
 *
 * Todas as chaves moram em `platform_config` e são escritas SÓ pela tela de
 * Cobrança: a Conexão confere a chave com o provedor, registra o webhook e
 * recusa trocar o provedor de quem tem assinatura viva; a Régua valida o
 * intervalo. Por isso aqui vale só o que veio do BANCO (`fonte === "banco"`):
 * uma STRIPE_SECRET_KEY esquecida no `.env` não pode virar a chave de cobrança
 * sem passar por nada disso. Lido a cada uso, sem memo: trocar pela tela vale
 * no worker na hora (mesmo contrato de `lib/instalacao/config.ts`).
 */
import { PROVEDORES_DE_COBRANCA, type ProvedorDeCobranca } from "@/lib/cobranca/vocabulario";
import { valorDaInstalacao, type ValorDaInstalacao } from "@/lib/instalacao/config";

/** D-5: 7 dias por padrão, ajustável de 5 a 30. O piso mora aqui também (boleto + fim de semana). */
export const TOLERANCIA_PADRAO_DIAS = 7;
export const TOLERANCIA_MINIMA_DIAS = 5;
export const TOLERANCIA_MAXIMA_DIAS = 30;

function doBanco(v: ValorDaInstalacao): string | null {
  return v.fonte === "banco" ? v.valor : null;
}

export async function toleranciaDias(): Promise<number> {
  const bruto = doBanco(await valorDaInstalacao("COBRANCA_TOLERANCIA_DIAS"));
  const dias = bruto === null ? Number.NaN : Number(bruto);
  if (!Number.isInteger(dias)) return TOLERANCIA_PADRAO_DIAS;
  return Math.min(TOLERANCIA_MAXIMA_DIAS, Math.max(TOLERANCIA_MINIMA_DIAS, dias));
}

/** O provedor das assinaturas NOVAS (D-8). As antigas seguem no provedor da linha. */
export async function provedorDaInstalacao(): Promise<ProvedorDeCobranca | null> {
  const bruto = doBanco(await valorDaInstalacao("COBRANCA_PROVEDOR"));
  return PROVEDORES_DE_COBRANCA.find((p) => p === bruto) ?? null;
}

/** A chave de API do provedor. O Asaas entra na PR 3b. */
export async function chaveDoProvedor(id: ProvedorDeCobranca): Promise<string | null> {
  if (id === "stripe") return doBanco(await valorDaInstalacao("STRIPE_SECRET_KEY"));
  return null;
}

/** O segredo com que o webhook do provedor é conferido. O Asaas entra na PR 3b. */
export async function segredoDoWebhook(id: ProvedorDeCobranca): Promise<string | null> {
  if (id === "stripe") return doBanco(await valorDaInstalacao("STRIPE_WEBHOOK_SECRET"));
  return null;
}
