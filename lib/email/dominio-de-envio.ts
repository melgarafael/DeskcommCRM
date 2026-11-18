/** Diagnóstico dos registros oficiais da conta; DNS conferido não é garantia de entrega. */
import type { DominioOficialDaContaResend } from "./resend-da-organizacao";

export type TipoDeRegistro = "spf" | "dkim" | "mx" | "dmarc";
export type TipoDns = "TXT" | "MX" | "CNAME";
export type EstadoDoRegistro = "ok" | "atencao" | "ausente" | "conflitante" | "indisponivel";
export interface RegistroEsperado {
  readonly tipo: TipoDeRegistro;
  readonly nome: string;
  readonly tipoDns: TipoDns;
  readonly valor: string;
  readonly estadoNaResend: string | null;
  readonly consultavel: boolean;
}
export interface ConsultaDns {
  readonly registro: RegistroEsperado;
  readonly valores: readonly string[];
  readonly indisponivel: boolean;
}
export interface RegistroDoDominio {
  readonly tipo: TipoDeRegistro;
  readonly nome: string;
  readonly tipoDns: TipoDns;
  readonly encontrado: string | null;
  readonly esperado: string;
  readonly estado: EstadoDoRegistro;
  readonly estadoNaResend: string | null;
  readonly problema: string | null;
}
export interface RespostasDns {
  readonly consultas: readonly ConsultaDns[];
  readonly dmarcTxt: readonly (readonly string[])[];
  readonly dmarcIndisponivel: boolean;
}
export interface DiagnosticoDoDominioDeEnvio {
  readonly dominio: string;
  readonly registros: readonly RegistroDoDominio[];
  readonly bloqueios: readonly { readonly nome: string; readonly mensagem: string }[];
  readonly avisos: readonly string[];
  readonly estadoNaResend: DominioOficialDaContaResend["status"];
  readonly envioHabilitado: boolean;
  readonly conferidoEm: string;
}
export interface PoliticaDmarc {
  readonly politica: "none" | "quarantine" | "reject" | null;
  readonly pct: number | null;
  readonly temRelatorio: boolean;
  readonly alinhamentoEstrito: boolean;
}

const ROTULO = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export function dominioDeEndereco(entrada: string | null | undefined): string | null {
  const cru = (entrada ?? "").trim().toLowerCase();
  if (!cru) return null;
  const partes = cru.split("@");
  if (partes.length > 2 || (partes.length === 2 && !partes[0])) return null;
  const dominio = (partes.at(-1) ?? "").replace(/\.$/, "");
  const rotulos = dominio.split(".");
  const tld = rotulos.at(-1) ?? "";
  if (dominio.length > 253 || rotulos.length < 2 || !rotulos.every((r) => ROTULO.test(r)))
    return null;
  if (tld.length < 2 || /^\d+$/.test(tld)) return null;
  return dominio;
}

/** Junta pedaços do MESMO TXT, sem juntar registros diferentes. */
export function textosDosRegistros(
  consultas: readonly (readonly string[])[] | undefined,
): string[] {
  if (!Array.isArray(consultas)) return [];
  return consultas
    .map((partes) =>
      Array.isArray(partes)
        ? partes
            .filter((p) => typeof p === "string")
            .join("")
            .trim()
        : "",
    )
    .filter(Boolean);
}

export const nomeDoDmarc = (dominio: string): string => `_dmarc.${dominio}`;

/** A API admite nomes relativos ou completos. Só consultamos nomes do domínio da conta. */
function nomeCompleto(nome: string, dominio: string): string | null {
  const n = nome.trim().toLowerCase().replace(/\.$/, "");
  const completo =
    n === "@" || n === ""
      ? dominio
      : n === dominio || n.endsWith(`.${dominio}`)
        ? n
        : `${n}.${dominio}`;
  const rotuloDns = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;
  return completo.length <= 253 && completo.split(".").every((r) => rotuloDns.test(r))
    ? completo
    : null;
}

/** Os nomes/valores vêm de domains.get(), incluindo Return-Path personalizado e CNAME. */
export function registrosOficiaisDeEnvio(conta: DominioOficialDaContaResend): RegistroEsperado[] {
  const dominio = dominioDeEndereco(conta.name);
  if (!dominio) return [];
  return conta.records.flatMap((r) => {
    if ((r.record !== "SPF" && r.record !== "DKIM") || !["TXT", "MX", "CNAME"].includes(r.type))
      return [];
    const nome = nomeCompleto(r.name, dominio);
    return [
      {
        tipo:
          r.record === "DKIM"
            ? ("dkim" as const)
            : r.type === "MX"
              ? ("mx" as const)
              : ("spf" as const),
        nome: nome ?? r.name,
        tipoDns: r.type as TipoDns,
        valor: r.type === "MX" ? `${r.priority ?? ""} ${r.value}`.trim() : r.value,
        estadoNaResend: r.status,
        consultavel: nome !== null && (r.type !== "MX" || Number.isInteger(r.priority)),
      },
    ];
  });
}

export function lerPoliticaDmarc(registro: string): PoliticaDmarc {
  const tags = new Map<string, string>();
  for (const parte of registro.split(";")) {
    const corte = parte.indexOf("=");
    if (corte <= 0) continue;
    const chave = parte.slice(0, corte).trim().toLowerCase();
    const valor = parte
      .slice(corte + 1)
      .trim()
      .toLowerCase();
    if (chave && !tags.has(chave)) tags.set(chave, valor);
  }
  const p = tags.get("p");
  const pct = tags.get("pct");
  const numero = pct && /^\d{1,3}$/.test(pct) ? Number(pct) : null;
  return {
    politica: p === "none" || p === "quarantine" || p === "reject" ? p : null,
    pct: numero !== null && numero >= 0 && numero <= 100 ? numero : null,
    temRelatorio: (tags.get("rua") ?? "").length > 0,
    alinhamentoEstrito: tags.get("adkim") === "s" || tags.get("aspf") === "s",
  };
}

function normalizar(valor: string, tipo: TipoDns): string {
  const v = valor
    .trim()
    .replace(/^"(.*)"$/s, "$1")
    .replace(/\s+/g, " ");
  return tipo === "TXT" ? v : v.toLowerCase().replace(/\.$/, "");
}

function conferirRegistro(consulta: ConsultaDns): RegistroDoDominio {
  const r = consulta.registro;
  const base = {
    tipo: r.tipo,
    nome: r.nome,
    tipoDns: r.tipoDns,
    esperado: r.valor,
    estadoNaResend: r.estadoNaResend,
    encontrado: consulta.valores.join(" | ") || null,
  };
  if (consulta.indisponivel || !r.consultavel)
    return {
      ...base,
      estado: "indisponivel",
      problema: "Não foi possível consultar este registro. Tente de novo antes de alterar o DNS.",
    };
  if (consulta.valores.length === 0)
    return { ...base, estado: "ausente", problema: "Nenhum registro encontrado neste nome." };
  const valores = consulta.valores.map((v) => normalizar(v, r.tipoDns));
  // Um null MX não confirma o retorno; não perca o ponto ao formatar a prioridade.
  const nullMx = r.tipoDns === "MX" && consulta.valores.some((v) => /^\s*0\s+\.\s*$/.test(v));
  const spfs =
    r.tipo === "spf" && r.tipoDns === "TXT"
      ? valores.filter((v) => /^v=spf1(?:\s|$)/i.test(v))
      : [];
  const igual = valores.includes(normalizar(r.valor, r.tipoDns)) && !nullMx && spfs.length <= 1;
  return igual
    ? { ...base, estado: "ok", problema: null }
    : {
        ...base,
        estado: "conflitante",
        problema:
          "O valor publicado difere do informado pela Resend. Confira no painel antes de alterar.",
      };
}

function registroDmarc(dominio: string, respostas: RespostasDns): RegistroDoDominio {
  const nome = nomeDoDmarc(dominio);
  const registros = textosDosRegistros(respostas.dmarcTxt).filter((v) =>
    /^v=dmarc1(?:\s|;|$)/i.test(v),
  );
  const base = {
    tipo: "dmarc" as const,
    nome,
    tipoDns: "TXT" as const,
    esperado: "Política DMARC definida por quem administra o domínio",
    estadoNaResend: null,
    encontrado: registros.join(" | ") || null,
  };
  if (respostas.dmarcIndisponivel)
    return {
      ...base,
      estado: "indisponivel",
      problema: "Não foi possível consultar este registro. Tente de novo antes de alterar o DNS.",
    };
  if (registros.length === 0)
    return {
      ...base,
      estado: "ausente",
      problema:
        "Nenhum DMARC encontrado neste nome. Confira também a política do domínio principal.",
    };
  if (registros.length > 1)
    return { ...base, estado: "conflitante", problema: "Há mais de um registro DMARC neste nome." };
  const politica = lerPoliticaDmarc(registros[0] ?? "");
  if (!politica.politica)
    return {
      ...base,
      estado: "conflitante",
      problema: "O registro DMARC não tem p=none, p=quarantine ou p=reject válido.",
    };
  if (politica.pct !== null && politica.pct < 100)
    return {
      ...base,
      estado: "atencao",
      problema: "O DMARC consultado declara pct abaixo de 100. Confira o valor publicado.",
    };
  return politica.politica === "none"
    ? {
        ...base,
        estado: "atencao",
        problema: "O DMARC publicado usa p=none: monitora, sem pedir rejeição das mensagens.",
      }
    : { ...base, estado: "ok", problema: null };
}

/** Estado oficial e observação DNS separados; nenhum dos dois promete entrega na caixa. */
export function diagnosticarDominioDeEnvio(
  conta: DominioOficialDaContaResend,
  respostas: RespostasDns,
  conferidoEm: string,
): DiagnosticoDoDominioDeEnvio | null {
  const dominio = dominioDeEndereco(conta.name);
  if (!dominio) return null;
  const registros = [
    ...respostas.consultas.map(conferirRegistro),
    registroDmarc(dominio, respostas),
  ];
  const avisos = registros.filter((r) => r.estado === "atencao").map((r) => r.problema ?? "");
  const dmarc = registros.at(-1);
  if (dmarc?.encontrado && !dmarc.encontrado.includes(" | ")) {
    const politica = lerPoliticaDmarc(dmarc.encontrado);
    if (!politica.temRelatorio) avisos.push("O DMARC consultado não informa rua= para relatórios.");
    if (politica.alinhamentoEstrito)
      avisos.push("O DMARC consultado declara alinhamento estrito (adkim=s ou aspf=s).");
  }
  if (respostas.consultas.length === 0)
    avisos.push(
      "A Resend não informou registros de envio para este domínio. Confira o painel da conta.",
    );
  return {
    dominio,
    registros,
    bloqueios: registros
      .filter((r) => ["ausente", "conflitante", "indisponivel"].includes(r.estado))
      .map((r) => ({ nome: r.nome, mensagem: r.problema ?? "" })),
    avisos,
    estadoNaResend: conta.status,
    envioHabilitado: conta.capabilities.sending === "enabled",
    conferidoEm,
  };
}
