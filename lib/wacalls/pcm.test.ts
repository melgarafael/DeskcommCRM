import { describe, expect, it } from "vitest";
import { float32ToInt16LE, int16LEToFloat32 } from "./pcm";

describe("PCM 16-bit LE audio converters", () => {
  it("converte Float32Array para ArrayBuffer Int16LE e de volta para Float32Array", () => {
    const input = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const buffer = float32ToInt16LE(input);

    expect(buffer.byteLength).toBe(input.length * 2);

    const output = int16LEToFloat32(buffer);
    expect(output.length).toBe(input.length);

    // Precisão aproximada devido à quantização 16-bit
    for (let i = 0; i < input.length; i++) {
      expect(output[i]).toBeCloseTo(input[i]!, 2);
    }
  });

  it("limita amplitudes fora da faixa [-1, 1]", () => {
    const input = new Float32Array([1.5, -1.5, NaN]);
    const buffer = float32ToInt16LE(input);
    const output = int16LEToFloat32(buffer);

    expect(output[0]).toBeCloseTo(1, 2);
    expect(output[1]).toBeCloseTo(-1, 2);
    expect(output[2]).toBe(0);
  });
});
