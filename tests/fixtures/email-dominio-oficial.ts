import type { DominioOficialDaContaResend } from "@/lib/email/resend-da-organizacao";
import type { RespostasDns } from "@/lib/email/dominio-de-envio";

export const DOMINIO = "lojadaana.com";
export const SPF = "v=spf1 include:amazonses.com ~all";
export const DKIM = "v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC7";
export const MX = "feedback-smtp.us-east-1.amazonses.com";
export function dominioOficial(
  overrides: Partial<DominioOficialDaContaResend> = {},
): DominioOficialDaContaResend {
  return {
    name: DOMINIO,
    status: "verified",
    capabilities: { sending: "enabled", receiving: "disabled" },
    records: [
      { record: "SPF", name: "send", type: "TXT", value: SPF, status: "verified", ttl: "Auto" },
      {
        record: "DKIM",
        name: "resend._domainkey",
        type: "TXT",
        value: DKIM,
        status: "verified",
        ttl: "Auto",
      },
      {
        record: "SPF",
        name: "send",
        type: "MX",
        value: MX,
        priority: 10,
        status: "verified",
        ttl: "Auto",
      },
    ],
    ...overrides,
  };
}

/** Respostas explicitamente semeadas; não derivadas da função sob teste. */
export function respostasBoas(overrides: Partial<RespostasDns> = {}): RespostasDns {
  return {
    consultas: [
      {
        registro: {
          tipo: "spf",
          nome: "send.lojadaana.com",
          tipoDns: "TXT",
          valor: SPF,
          estadoNaResend: "verified",
          consultavel: true,
        },
        valores: [SPF],
        indisponivel: false,
      },
      {
        registro: {
          tipo: "dkim",
          nome: "resend._domainkey.lojadaana.com",
          tipoDns: "TXT",
          valor: DKIM,
          estadoNaResend: "verified",
          consultavel: true,
        },
        valores: [DKIM],
        indisponivel: false,
      },
      {
        registro: {
          tipo: "mx",
          nome: "send.lojadaana.com",
          tipoDns: "MX",
          valor: `10 ${MX}`,
          estadoNaResend: "verified",
          consultavel: true,
        },
        valores: [`10 ${MX}`],
        indisponivel: false,
      },
    ],
    dmarcTxt: [["v=DMARC1; p=quarantine; rua=mailto:dmarc@lojadaana.com"]],
    dmarcIndisponivel: false,
    ...overrides,
  };
}
