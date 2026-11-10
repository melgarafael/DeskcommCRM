/** Coletor com DNS sintético injetado: nada consulta a rede. */
import { describe, expect, it, vi } from "vitest";
import {
  conferirDominioDeEnvio,
  respostasDnsDoDominio,
  type ResolvedorDns,
} from "./dominio-de-envio-dns";
import { diagnosticarDominioDeEnvio } from "./dominio-de-envio";
import { DOMINIO, DKIM, SPF, MX, dominioOficial } from "@/tests/fixtures/email-dominio-oficial";
const AGORA = () => new Date("2026-10-26T12:00:00.000Z");

function resolvedorFake(mapa: {
  txt?: Record<string, string[][]>;
  mx?: Record<string, { exchange: string; priority: number }[]>;
  cname?: Record<string, string[]>;
  erro?: string;
}): ResolvedorDns & {
  txt: ReturnType<typeof vi.fn>;
  mx: ReturnType<typeof vi.fn>;
  cname: ReturnType<typeof vi.fn>;
} {
  const falta = () =>
    Object.assign(new Error("falha DNS sintética"), { code: mapa.erro ?? "ENODATA" });
  return {
    txt: vi.fn(async (n: string) => {
      if (!mapa.txt?.[n]) throw falta();
      return mapa.txt[n]!;
    }),
    mx: vi.fn(async (n: string) => {
      if (!mapa.mx?.[n]) throw falta();
      return mapa.mx[n]!;
    }),
    cname: vi.fn(async (n: string) => {
      if (!mapa.cname?.[n]) throw falta();
      return mapa.cname[n]!;
    }),
  };
}
const MAPA = {
  txt: {
    [`send.${DOMINIO}`]: [[SPF]],
    [`resend._domainkey.${DOMINIO}`]: [[DKIM.slice(0, 20), DKIM.slice(20)]],
    [`_dmarc.${DOMINIO}`]: [["v=DMARC1; p=reject; rua=mailto:dmarc@lojadaana.com"]],
  },
  mx: { [`send.${DOMINIO}`]: [{ priority: 10, exchange: MX + "." }] },
};

describe("respostasDnsDoDominio", () => {
  it("consulta apenas os nomes oficiais e DMARC; junta TXT do mesmo registro", async () => {
    const dns = resolvedorFake(MAPA);
    const r = await respostasDnsDoDominio(dominioOficial(), dns);
    expect(dns.txt.mock.calls.map((c) => c[0])).toEqual([
      `send.${DOMINIO}`,
      `resend._domainkey.${DOMINIO}`,
      `_dmarc.${DOMINIO}`,
    ]);
    expect(dns.mx.mock.calls.map((c) => c[0])).toEqual([`send.${DOMINIO}`]);
    expect(dns.cname).not.toHaveBeenCalled();
    expect(r?.consultas[1]?.valores).toEqual([DKIM]);
  });
  it("preserva a prioridade e remove só o ponto final do hostname MX", async () => {
    const dns = resolvedorFake({
      ...MAPA,
      mx: {
        [`send.${DOMINIO}`]: [
          { priority: 20, exchange: MX + "." },
          { priority: 10, exchange: "retorno.example." },
        ],
      },
    });
    const r = await respostasDnsDoDominio(dominioOficial(), dns);
    expect(r?.consultas[2]?.valores).toEqual([`20 ${MX}`, "10 retorno.example"]);
  });
  it("null MX atravessa o coletor com o ponto e não confere com o registro da conta", async () => {
    const dns = resolvedorFake({
      ...MAPA,
      mx: { [`send.${DOMINIO}`]: [{ priority: 0, exchange: "." }] },
    });
    const r = await respostasDnsDoDominio(dominioOficial(), dns);
    expect(r?.consultas[2]?.valores).toEqual(["0 ."]);
    const d = diagnosticarDominioDeEnvio(dominioOficial(), r!, AGORA().toISOString())!;
    expect(d.registros.find((r) => r.tipo === "mx")?.estado).toBe("conflitante");
    expect(d).not.toHaveProperty("prontoParaEnviar");
  });
  it("SPF -all e MX de outro provedor não confirmam os registros esperados", async () => {
    const dns = resolvedorFake({
      txt: { ...MAPA.txt, [`send.${DOMINIO}`]: [["v=spf1 -all"]] },
      mx: { [`send.${DOMINIO}`]: [{ priority: 10, exchange: "outro.example" }] },
    });
    const r = await conferirDominioDeEnvio(dominioOficial(), { resolvedor: dns, agora: AGORA });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      r.diagnostico.registros.filter((r) => ["spf", "mx"].includes(r.tipo)).map((r) => r.estado),
    ).toEqual(["conflitante", "conflitante"]);
  });
  it.each(["ENODATA", "ENOTFOUND", "ETIMEOUT", "ESERVFAIL", "EACCES"])(
    "%s distingue ausência de consulta inconclusiva",
    async (erro) => {
      const r = await conferirDominioDeEnvio(dominioOficial(), {
        resolvedor: resolvedorFake({ erro }),
        agora: AGORA,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const esperado = erro === "ENODATA" || erro === "ENOTFOUND" ? "ausente" : "indisponivel";
      expect(r.diagnostico.registros.every((r) => r.estado === esperado)).toBe(true);
      expect(r.diagnostico.bloqueios).toHaveLength(4);
    },
  );
  it("Return-Path personalizado e dois CNAME SPF usam seus nomes reais", async () => {
    const conta = dominioOficial({
      records: [
        {
          record: "SPF",
          type: "CNAME",
          name: "outbound",
          value: "spf1.provedor.example",
          status: "verified",
          ttl: "Auto",
        },
        {
          record: "SPF",
          type: "CNAME",
          name: "routbound",
          value: "spf2.provedor.example",
          status: "verified",
          ttl: "Auto",
        },
        {
          record: "DKIM",
          type: "CNAME",
          name: "seletor._domainkey",
          value: "dkim.provedor.example",
          status: "verified",
          ttl: "Auto",
        },
      ],
    });
    const dns = resolvedorFake({
      txt: { [`_dmarc.${DOMINIO}`]: MAPA.txt[`_dmarc.${DOMINIO}`] },
      cname: {
        [`outbound.${DOMINIO}`]: ["spf1.provedor.example."],
        [`routbound.${DOMINIO}`]: ["spf2.provedor.example."],
        [`seletor._domainkey.${DOMINIO}`]: ["dkim.provedor.example."],
      },
    });
    const r = await conferirDominioDeEnvio(conta, { resolvedor: dns, agora: AGORA });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(dns.cname.mock.calls.map((c) => c[0])).toEqual([
      `outbound.${DOMINIO}`,
      `routbound.${DOMINIO}`,
      `seletor._domainkey.${DOMINIO}`,
    ]);
    expect(dns.mx).not.toHaveBeenCalled();
    expect(dns.txt).toHaveBeenCalledTimes(1);
    expect(r.diagnostico.registros.every((r) => r.estado === "ok")).toBe(true);
    expect(r.diagnostico.conferidoEm).toBe(AGORA().toISOString());
  });
  it("registro de recebimento não impõe MX raiz à verificação de envio", async () => {
    const conta = dominioOficial();
    conta.records.push({
      record: "Receiving",
      type: "MX",
      name: "@",
      value: "inbound.example",
      priority: 10,
      status: "verified",
      ttl: "Auto",
    });
    const dns = resolvedorFake(MAPA);
    await respostasDnsDoDominio(conta, dns);
    expect(dns.mx.mock.calls.map((c) => c[0])).toEqual([`send.${DOMINIO}`]);
  });
  it("nome de registro inválido não vira consulta arbitrária", async () => {
    const conta = dominioOficial({
      records: [
        {
          record: "SPF",
          type: "TXT",
          name: "https://interno.local",
          value: SPF,
          status: "verified",
          ttl: "Auto",
        },
      ],
    });
    const dns = resolvedorFake(MAPA);
    const r = await conferirDominioDeEnvio(conta, { resolvedor: dns, agora: AGORA });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.diagnostico.registros[0]?.estado).toBe("indisponivel");
    expect(dns.txt.mock.calls.map((c) => c[0])).toEqual([`_dmarc.${DOMINIO}`]);
  });
  it("domínio inválido não consulta nada", async () => {
    const dns = resolvedorFake(MAPA);
    expect(await respostasDnsDoDominio(dominioOficial({ name: "localhost" }), dns)).toBeNull();
    expect(dns.txt).not.toHaveBeenCalled();
    expect(dns.mx).not.toHaveBeenCalled();
    expect(dns.cname).not.toHaveBeenCalled();
  });
});
