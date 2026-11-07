// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ImageResponse } from "next/og";
import { simboloGianna } from "@/lib/branding/simbolo-gianna";
import { lerPng } from "../helpers/png-sintetico";

describe("ícone Gianna", () => {
  it("renderiza o símbolo original em PNG", async () => {
    const resposta = new ImageResponse(simboloGianna(64), { width: 64, height: 64 });
    const png = Buffer.from(await resposta.arrayBuffer());
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.readUInt32BE(16)).toBe(64);
    expect(png.readUInt32BE(20)).toBe(64);
    const { rgba } = lerPng(png);
    expect(rgba.some((valor, indice) => indice % 4 === 3 && valor > 0)).toBe(true);
  });
});
