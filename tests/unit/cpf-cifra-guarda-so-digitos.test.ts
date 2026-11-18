/**
 * A CIFRA DO CPF GUARDA SÓ OS DÍGITOS — e a máscara é coisa da tela.
 *
 * Antes, `camposCpfParaGravar` cifrava o texto como chegou e o schema só
 * validava, sem transformar: o cadastro pela tela cifrava `000.000.000-00` como
 * foi digitado, enquanto a importação já mandava os 11 dígitos. O hash não
 * sentia (ele normaliza), mas o export saía com formatos misturados e a ficha
 * herdaria a mistura.
 *
 * CPF fictício (gerado pelo dígito verificador), nunca de pessoa real.
 */
import { describe, expect, it } from "vitest";

import { camposCpfParaGravar, hashCpf } from "@/lib/contacts/cpf";
import { formatarCpf } from "@/lib/contacts/formatar-cpf";

/** Falso supabase que anota o que foi mandado para a RPC `encrypt_cpf`. */
function supabaseQueAnota() {
  const enviados: unknown[] = [];
  const cliente = {
    rpc: async (nome: string, args: Record<string, unknown>) => {
      if (nome === "encrypt_cpf") enviados.push(args.p_plaintext);
      return { data: new Uint8Array([1, 2, 3]), error: null };
    },
  } as never;
  return { cliente, enviados };
}

describe("camposCpfParaGravar cifra só os dígitos", () => {
  it("CPF com máscara chega à RPC sem pontos nem traço", async () => {
    const { cliente, enviados } = supabaseQueAnota();
    await camposCpfParaGravar(cliente, "529.982.247-25");
    expect(enviados).toEqual(["52998224725"]);
  });

  it("CPF já em dígitos chega igual — o mesmo texto que a importação cifrava", async () => {
    const { cliente, enviados } = supabaseQueAnota();
    await camposCpfParaGravar(cliente, " 52998224725 ");
    expect(enviados).toEqual(["52998224725"]);
  });

  it("o hash continua o mesmo com ou sem máscara", async () => {
    const { cliente } = supabaseQueAnota();
    const comMascara = await camposCpfParaGravar(cliente, "529.982.247-25");
    const semMascara = await camposCpfParaGravar(cliente, "52998224725");
    expect(comMascara.cpf_hash).toBe(semMascara.cpf_hash);
    expect(comMascara.cpf_hash).toBe(hashCpf("52998224725"));
  });
});

describe("formatarCpf", () => {
  it("põe a máscara em 11 dígitos", () => {
    expect(formatarCpf("52998224725")).toBe("529.982.247-25");
  });

  it("aceita o valor que já veio com máscara (fichas gravadas antes)", () => {
    expect(formatarCpf("529.982.247-25")).toBe("529.982.247-25");
  });

  it("não inventa CPF: o que não tem 11 dígitos volta como veio", () => {
    expect(formatarCpf("123456789")).toBe("123456789");
    expect(formatarCpf(" 1234 ")).toBe("1234");
  });
});
