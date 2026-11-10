/** Casos puros do diagnóstico; estado do provedor não equivale a entrega. */
import { describe, expect, it } from "vitest";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  diagnosticarDominioDeEnvio,
  dominioDeEndereco,
  lerPoliticaDmarc,
  registrosOficiaisDeEnvio,
  textosDosRegistros,
  type RespostasDns,
} from "./dominio-de-envio";
import {
  DOMINIO,
  SPF,
  DKIM,
  dominioOficial,
  respostasBoas,
} from "@/tests/fixtures/email-dominio-oficial";
const AGORA = "2026-10-26T12:00:00.000Z";
function linha(tipo: "spf" | "dkim" | "mx" | "dmarc", valores?: readonly string[]) {
  const respostas = respostasBoas();
  const alteradas = valores
    ? {
        ...respostas,
        consultas: respostas.consultas.map((c) =>
          c.registro.tipo === tipo ? { ...c, valores } : c,
        ),
      }
    : respostas;
  const r = diagnosticarDominioDeEnvio(dominioOficial(), alteradas, AGORA)?.registros.find(
    (r) => r.tipo === tipo,
  );
  if (!r) throw new Error("linha ausente");
  return r;
}
describe("dominioDeEndereco", () => {
  it("aceita o domínio e o endereço de remetente, normalizados", () => {
    expect(dominioDeEndereco("lojadaana.com")).toBe("lojadaana.com");
    expect(dominioDeEndereco("  LOJA DA ANA ")).toBeNull(); // espaço é recusa
    expect(dominioDeEndereco("  LojaDaAna.COM  ")).toBe("lojadaana.com");
    expect(dominioDeEndereco("lojadaana.com.")).toBe("lojadaana.com");
    expect(dominioDeEndereco("contato@lojadaana.com")).toBe("lojadaana.com");
    expect(dominioDeEndereco("  Contato@LojaDaAna.COM ")).toBe("lojadaana.com");
    expect(dominioDeEndereco("no-reply@send.lojadaana.com")).toBe("send.lojadaana.com");
  });

  it("recusa o que não é nome de máquina", () => {
    for (const entrada of [
      "",
      "   ",
      null,
      undefined,
      "localhost",
      "send",
      "https://lojadaana.com",
      "lojadaana.com/path",
      "loj a.com",
      "-lojadaana.com",
      "lojadaana-.com",
      "loja_da_ana.com",
      "lojadaana..com",
      "192.168.0.1",
      "lojadaana.c",
      "a@b@lojadaana.com",
      "@lojadaana.com",
      "contato@",
      "lojadaana.com:8080",
    ]) {
      expect(dominioDeEndereco(entrada), String(entrada)).toBeNull();
    }
  });
});

describe("textosDosRegistros", () => {
  it("cola os pedaços do MESMO registro e descarta vazios", () => {
    expect(
      textosDosRegistros([
        ["v=DKIM1; k=rsa; ", "p=MIGfMA0GCSqGSIb3", "DQEBAQUAA4GNADCBiQKBgQC7"],
        ["   "],
        ["v=DMARC1; p=none"],
      ]),
    ).toEqual(["v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC7", "v=DMARC1; p=none"]);
  });

  it("respostas vazias ou tortas não lançam", () => {
    expect(textosDosRegistros(undefined)).toEqual([]);
    expect(textosDosRegistros([])).toEqual([]);
    expect(textosDosRegistros([[], ["  "]] as string[][])).toEqual([]);
  });
});

describe("lerPoliticaDmarc", () => {
  it("lê política, pct, relatório e alinhamento", () => {
    expect(lerPoliticaDmarc("v=DMARC1; p=reject; pct=50; rua=mailto:a@b.com; adkim=s")).toEqual({
      politica: "reject",
      pct: 50,
      temRelatorio: true,
      alinhamentoEstrito: true,
    });
  });

  it("política desconhecida e pct fora da faixa viram ausência de valor, sem lançar", () => {
    expect(lerPoliticaDmarc("v=DMARC1; p=banana; pct=999")).toEqual({
      politica: null,
      pct: null,
      temRelatorio: false,
      alinhamentoEstrito: false,
    });
  });
});

describe("os registros da conta são a referência", () => {
  it("mantém nomes completos, nomes relativos, tipo, prioridade e estado oficiais", () => {
    const registros = registrosOficiaisDeEnvio(dominioOficial());
    expect(registros.map((r) => [r.tipo, r.nome, r.tipoDns])).toEqual([
      ["spf", "send.lojadaana.com", "TXT"],
      ["dkim", "resend._domainkey.lojadaana.com", "TXT"],
      ["mx", "send.lojadaana.com", "MX"],
    ]);
    expect(registros[2]).toMatchObject({
      valor: "10 feedback-smtp.us-east-1.amazonses.com",
      estadoNaResend: "verified",
    });
    expect(
      registrosOficiaisDeEnvio(
        dominioOficial({
          records: [
            {
              record: "SPF",
              name: "outbound.lojadaana.com.",
              type: "CNAME",
              value: "envio.provedor.example",
              status: "pending",
              ttl: "Auto",
            },
          ],
        }),
      )[0],
    ).toMatchObject({
      nome: "outbound.lojadaana.com",
      tipoDns: "CNAME",
      estadoNaResend: "pending",
    });
  });

  it.each([
    "v=spf1 -all",
    "v=spf1 include:outro.example ~all",
    "v=spf1 include:amazonses.com",
    "v=spf1 include:amazonses.com ?all",
  ])("SPF %s não confirma o registro esperado da conta", (spf) => {
    expect(linha("spf", [spf])).toMatchObject({
      estado: "conflitante",
      encontrado: spf,
      esperado: SPF,
    });
  });
  it("SPF com -all e include pode coincidir se for o valor efetivamente pedido pela conta", () => {
    const r = respostasBoas();
    const valor = "v=spf1 include:amazonses.com -all";
    const consultas = r.consultas.map((c) =>
      c.registro.tipo === "spf"
        ? { ...c, registro: { ...c.registro, valor }, valores: [valor] }
        : c,
    );
    expect(
      diagnosticarDominioDeEnvio(dominioOficial(), { ...r, consultas }, AGORA)?.registros[0]
        ?.estado,
    ).toBe("ok");
  });
  it("dois SPF não passam mesmo quando um coincide", () => {
    expect(linha("spf", [SPF, "v=spf1 include:outro.example ~all"]).estado).toBe("conflitante");
  });
  it("ausência aponta só o nome oficial consultado, sem inventar reserva na raiz", () => {
    expect(linha("spf", [])).toMatchObject({
      estado: "ausente",
      nome: "send.lojadaana.com",
      esperado: SPF,
    });
  });
  it.each(["v=DKIM1; k=rsa; p=", "v=DKIM1; k=rsa", "p=abc"])(
    "DKIM %s difere da chave oficial",
    (dkim) => {
      expect(linha("dkim", [dkim])).toMatchObject({ estado: "conflitante", esperado: DKIM });
    },
  );
  it("DKIM e MX publicados conforme a conta conferem; ausentes não conferem", () => {
    for (const tipo of ["dkim", "mx"] as const) {
      expect(linha(tipo).estado).toBe("ok");
      expect(linha(tipo, []).estado).toBe("ausente");
    }
  });
  it.each(["0 .", "10 mx.outro.example"])("MX %s não confirma o retorno da conta", (mx) => {
    expect(linha("mx", [mx]).estado).toBe("conflitante");
  });
  it("domínio oficial inválido não produz diagnóstico", () => {
    expect(
      diagnosticarDominioDeEnvio(dominioOficial({ name: "localhost" }), respostasBoas(), AGORA),
    ).toBeNull();
  });
});

describe("DMARC e estado oficial permanecem separados", () => {
  it("a explicação derivada do DNS possui tradução, sem usar o domínio como chave", () => {
    const r = linha("mx", []);
    expect(r.problema).toBeTruthy();
    expect(traduzir(r.problema!, "es")).not.toBe(r.problema);
  });
  function diagnostico(dmarcTxt: RespostasDns["dmarcTxt"]) {
    return diagnosticarDominioDeEnvio(dominioOficial(), respostasBoas({ dmarcTxt }), AGORA)!;
  }
  it("preserva os avisos de pct, relatório e alinhamento sem prever entrega", () => {
    const pct = diagnostico([["v=DMARC1; p=reject; pct=25; rua=mailto:d@lojadaana.com"]]);
    expect(pct.registros.at(-1)?.estado).toBe("atencao");
    expect(pct.avisos.some((a) => a.includes("pct abaixo de 100"))).toBe(true);
    expect(pct.registros.at(-1)?.encontrado).toContain("pct=25");
    const semRelatorio = diagnostico([["v=DMARC1; p=reject; adkim=s"]]);
    expect(semRelatorio.avisos.some((a) => a.includes("rua="))).toBe(true);
    expect(semRelatorio.avisos.some((a) => a.includes("estrito"))).toBe(true);
  });
  it.each([
    "v=DMARC1; p=quarantine; rua=mailto:dmarc@lojadaana.com",
    "V=DMARC1; P=REJECT; RUA=mailto:dmarc@lojadaana.com",
  ])("política %s publicada é lida", (valor) => {
    expect(diagnostico([[valor]]).registros.at(-1)).toMatchObject({
      estado: "ok",
      encontrado: valor,
    });
  });
  it("p=none fica como atenção, sem afirmar entrega", () => {
    const d = diagnostico([["v=DMARC1; p=none; rua=mailto:d@lojadaana.com"]]);
    expect(d.registros.at(-1)?.estado).toBe("atencao");
    expect(d.avisos).toHaveLength(1);
    expect(d).not.toHaveProperty("prontoParaEnviar");
  });
  it.each([
    { registros: [] },
    { registros: [["v=DMARC1; rua=mailto:d@lojadaana.com"]] },
    { registros: [["v=DMARC1; p=none"], ["v=DMARC1; p=reject"]] },
  ])("ausência/política inválida não recebe selo de envio", ({ registros }) => {
    expect(diagnostico(registros).bloqueios).toHaveLength(1);
  });
  it("estado verified e envio habilitado vêm da Resend, mesmo se o DNS divergir", () => {
    const r = respostasBoas();
    const d = diagnosticarDominioDeEnvio(
      dominioOficial(),
      { ...r, consultas: r.consultas.map((c) => ({ ...c, valores: [] })) },
      AGORA,
    )!;
    expect(d.estadoNaResend).toBe("verified");
    expect(d.envioHabilitado).toBe(true);
    expect(d.bloqueios).toHaveLength(3);
    expect(d).not.toHaveProperty("prontoParaEnviar");
    expect(d.conferidoEm).toBe(AGORA);
    expect(d.dominio).toBe(DOMINIO);
  });
  it("consulta inconclusiva e DNS vazio não se tornam sucesso", () => {
    const r = respostasBoas();
    const d = diagnosticarDominioDeEnvio(
      dominioOficial({
        status: "pending",
        capabilities: { sending: "disabled", receiving: "enabled" },
      }),
      {
        ...r,
        consultas: r.consultas.map((c) => ({ ...c, valores: [], indisponivel: true })),
        dmarcTxt: [],
        dmarcIndisponivel: true,
      },
      AGORA,
    )!;
    expect(d.registros.every((r) => r.estado === "indisponivel")).toBe(true);
    expect(d.bloqueios).toHaveLength(4);
    expect(d.estadoNaResend).toBe("pending");
    expect(d.envioHabilitado).toBe(false);
  });
});
