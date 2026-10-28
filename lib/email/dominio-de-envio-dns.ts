/** DNS dos nomes devolvidos pela conta Resend; não presume send.*, região ou seletor. */
import { resolveCname, resolveMx, resolveTxt } from "node:dns/promises";
import type { DominioOficialDaContaResend } from "./resend-da-organizacao";
import {
  diagnosticarDominioDeEnvio,
  dominioDeEndereco,
  nomeDoDmarc,
  registrosOficiaisDeEnvio,
  textosDosRegistros,
  type ConsultaDns,
  type DiagnosticoDoDominioDeEnvio,
  type RespostasDns,
} from "./dominio-de-envio";

export interface ResolvedorDns {
  readonly txt: (nome: string) => Promise<readonly (readonly string[])[]>;
  readonly mx: (
    nome: string,
  ) => Promise<readonly { readonly exchange: string; readonly priority: number }[]>;
  readonly cname: (nome: string) => Promise<readonly string[]>;
}
export const RESOLVEDOR_DO_SISTEMA: ResolvedorDns = {
  txt: (nome) => resolveTxt(nome),
  mx: (nome) => resolveMx(nome),
  cname: (nome) => resolveCname(nome),
};

/** Ausência é resposta DNS; timeout, SERVFAIL e permissão são consulta inconclusiva. */
async function consultar<T>(
  pergunta: () => Promise<T>,
  vazio: T,
): Promise<{ dados: T; indisponivel: boolean }> {
  try {
    return { dados: await pergunta(), indisponivel: false };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
    return { dados: vazio, indisponivel: code !== "ENOTFOUND" && code !== "ENODATA" };
  }
}

export async function respostasDnsDoDominio(
  conta: DominioOficialDaContaResend,
  resolvedor: ResolvedorDns = RESOLVEDOR_DO_SISTEMA,
): Promise<RespostasDns | null> {
  const dominio = dominioDeEndereco(conta.name);
  if (!dominio) return null;
  const consultas = await Promise.all(
    registrosOficiaisDeEnvio(conta).map(async (registro): Promise<ConsultaDns> => {
      if (!registro.consultavel) return { registro, valores: [], indisponivel: true };
      const resposta = await consultar(async () => {
        if (registro.tipoDns === "TXT")
          return textosDosRegistros(await resolvedor.txt(registro.nome));
        if (registro.tipoDns === "CNAME") return [...(await resolvedor.cname(registro.nome))];
        return (await resolvedor.mx(registro.nome)).map(
          (r) =>
            // '.' é o null MX. Não o transforme em string vazia ao tirar o ponto final.
            `${r.priority} ${r.exchange === "." ? "." : r.exchange.trim().replace(/\.$/, "")}`,
        );
      }, [] as string[]);
      return { registro, valores: resposta.dados, indisponivel: resposta.indisponivel };
    }),
  );
  const dmarc = await consultar(
    () => resolvedor.txt(nomeDoDmarc(dominio)),
    [] as readonly (readonly string[])[],
  );
  return { consultas, dmarcTxt: dmarc.dados, dmarcIndisponivel: dmarc.indisponivel };
}

export type ConferenciaDoDominioDeEnvio =
  | { readonly ok: true; readonly diagnostico: DiagnosticoDoDominioDeEnvio }
  | {
      readonly ok: false;
      readonly motivo: "dominio_invalido";
      readonly bloqueios: readonly string[];
    };

export async function conferirDominioDeEnvio(
  conta: DominioOficialDaContaResend,
  opcoes: { readonly resolvedor?: ResolvedorDns; readonly agora?: () => Date } = {},
): Promise<ConferenciaDoDominioDeEnvio> {
  const respostas = await respostasDnsDoDominio(conta, opcoes.resolvedor ?? RESOLVEDOR_DO_SISTEMA);
  const diagnostico =
    respostas &&
    diagnosticarDominioDeEnvio(
      conta,
      respostas,
      (opcoes.agora ?? (() => new Date()))().toISOString(),
    );
  return diagnostico
    ? { ok: true, diagnostico }
    : {
        ok: false,
        motivo: "dominio_invalido",
        bloqueios: ["O domínio informado pela conta não pôde ser conferido."],
      };
}
