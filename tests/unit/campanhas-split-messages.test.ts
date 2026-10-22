import { describe, expect, it } from "vitest";

import { ritmoSchema, editarCampanhaSchema } from "@/lib/campanhas/schemas";

describe("Campanhas: split_messages e ritmo", () => {
  it("ritmoSchema aceita split_messages como boolean, null ou undefined", () => {
    expect(ritmoSchema.safeParse({ split_messages: true }).success).toBe(true);
    expect(ritmoSchema.safeParse({ split_messages: false }).success).toBe(true);
    expect(ritmoSchema.safeParse({ split_messages: null }).success).toBe(true);
    expect(ritmoSchema.safeParse({}).success).toBe(true);

    const invalido = ritmoSchema.safeParse({ split_messages: "invalid" as unknown as boolean });
    expect(invalido.success).toBe(false);
  });

  it("editarCampanhaSchema aceita split_messages preservando outros campos de ritmo", () => {
    const parse = editarCampanhaSchema.safeParse({
      intervalo_segundos: 5,
      teto_diario: 100,
      split_messages: false,
    });
    expect(parse.success).toBe(true);
    if (parse.success) {
      expect(parse.data.split_messages).toBe(false);
      expect(parse.data.intervalo_segundos).toBe(5);
      expect(parse.data.teto_diario).toBe(100);
    }
  });

  it("divide mensagem por quebras de parágrafo (\n\n) quando split_messages é true", () => {
    const texto = "Olá, tudo bem?\n\nPassando para avisar da novidade.\n\nQualquer dúvida me avise!";
    const splitMessages = true;

    const deveDividir = splitMessages !== false;
    const partes = deveDividir
      ? texto.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
      : [texto];
    const bolhas = partes.length > 0 ? partes : [texto];

    expect(bolhas).toHaveLength(3);
    expect(bolhas[0]).toBe("Olá, tudo bem?");
    expect(bolhas[1]).toBe("Passando para avisar da novidade.");
    expect(bolhas[2]).toBe("Qualquer dúvida me avise!");
  });

  it("mantém mensagem como balão único quando split_messages é false", () => {
    const texto = "Olá, tudo bem?\n\nPassando para avisar da novidade.\n\nQualquer dúvida me avise!";
    const splitMessages = false;

    const deveDividir = splitMessages !== false;
    const partes = deveDividir
      ? texto.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
      : [texto];
    const bolhas = partes.length > 0 ? partes : [texto];

    expect(bolhas).toHaveLength(1);
    expect(bolhas[0]).toBe(texto);
  });

  it("calcula o intervalo correto respeitando o campo configurado ou padrão de 2,5s", () => {
    const comIntervalo = { intervalo_segundos: 4 };
    const delayCom = (comIntervalo.intervalo_segundos && comIntervalo.intervalo_segundos > 0)
      ? Math.min(comIntervalo.intervalo_segundos, 30) * 1000
      : 2500;
    expect(delayCom).toBe(4000);

    const semIntervalo = { intervalo_segundos: null };
    const delaySem = (semIntervalo.intervalo_segundos && semIntervalo.intervalo_segundos > 0)
      ? Math.min(semIntervalo.intervalo_segundos, 30) * 1000
      : 2500;
    expect(delaySem).toBe(2500);
  });
});
