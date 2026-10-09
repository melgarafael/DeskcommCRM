/**
 * AS FRASES DA RÉGUA (spec da cobrança do revendedor §7d). Uma frase por aviso,
 * no idioma da EMPRESA e com a data no FUSO dela. A mesma frase vai para a
 * Central (gravada como veio: a tela não passa título de aviso por t()) e para
 * o e-mail. Sem jargão: quem lê é o dono de uma loja, não um contador.
 */
import type { OrigemDaDivida } from "@/lib/cobranca/regua";
import type { AvisoDaRegua } from "@/lib/cobranca/vocabulario";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

export type AssuntoDoAviso = AvisoDaRegua | "liberada";

export interface TextoDoAviso {
  readonly titulo: string;
  readonly corpo: string;
  readonly severidade: "info" | "warn" | "critical";
}

const FUSO_PADRAO = "America/Sao_Paulo";

/** "05/10" no fuso da empresa. Fuso ilegível gravado na org cai no padrão (RangeError do Intl). */
export function diaEMes(data: Date, idioma: Idioma, fuso: string | null): string {
  // O es do Intl ignora o "2-digit" do dia ("5/10"); o zero à esquerda é nosso.
  const formatar = (tz: string) => {
    const partes = new Intl.DateTimeFormat(idioma, { day: "2-digit", month: "2-digit", timeZone: tz }).formatToParts(data);
    const de = (tipo: string) => (partes.find((p) => p.type === tipo)?.value ?? "").padStart(2, "0");
    return `${de("day")}/${de("month")}`;
  };
  try {
    return formatar(fuso ?? FUSO_PADRAO);
  } catch {
    // ponytail: fuso inválido na coluna da org; o dia no fuso padrão é melhor que nenhum aviso.
    return formatar(FUSO_PADRAO);
  }
}

export function textoDoAviso(
  assunto: AssuntoDoAviso,
  o: { data: Date | null; origem: OrigemDaDivida; idioma: Idioma; fuso: string | null },
): TextoDoAviso {
  const t = (texto: string) => traduzir(texto, o.idioma);
  const comData = (texto: string) => t(texto).replace("{data}", o.data === null ? "" : diaEMes(o.data, o.idioma, o.fuso));
  switch (assunto) {
    case "trial_acabando":
      return {
        titulo: comData("Seu teste grátis termina em {data}"),
        corpo: t("Assine em Plano e cobrança para continuar usando sem interrupção."),
        severidade: "info",
      };
    case "venceu":
      return o.origem === "teste"
        ? {
            titulo: comData("Seu teste grátis acabou em {data}"),
            corpo: t("Assine em Plano e cobrança para continuar usando. Sem a assinatura, a conta é suspensa em alguns dias."),
            severidade: "warn",
          }
        : {
            titulo: comData("Não identificamos o pagamento de {data}"),
            corpo: t("Se você pagou por boleto, aguarde a compensação (até 1 dia útil). Se ainda não pagou, use o link de pagamento."),
            severidade: "warn",
          };
    case "suspende_em_breve":
      return {
        titulo: comData("Sua conta será suspensa em {data}"),
        corpo: t(
          o.origem === "cancelamento"
            ? "Você cancelou a assinatura. Assine de novo em Plano e cobrança para continuar usando."
            : "A suspensão acontece se o pagamento não for confirmado até lá. Pague pelo link para evitar.",
        ),
        severidade: "critical",
      };
    case "suspensa":
      return {
        titulo: t("Conta suspensa por falta de pagamento"),
        corpo: t("A empresa volta a funcionar sozinha, na hora, assim que o pagamento for confirmado."),
        severidade: "critical",
      };
    case "liberada":
      return {
        titulo: t("Sua conta foi liberada"),
        corpo: t("Recebemos o pagamento e tudo voltou a funcionar. As conversas que chegaram durante a suspensão estão na Central, para revisão."),
        severidade: "info",
      };
  }
}
