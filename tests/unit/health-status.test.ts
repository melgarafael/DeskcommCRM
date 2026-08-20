import { describe, expect, it } from "vitest";

import { isOptionalEndpointUnconfigured, overallHealth } from "@/lib/health/status";

describe("health status", () => {
  it("trata placeholders e endpoints locais como integrações opcionais não configuradas", () => {
    expect(isOptionalEndpointUnconfigured(undefined)).toBe(true);
    expect(isOptionalEndpointUnconfigured("https://placeholder.upstash.io")).toBe(true);
    expect(isOptionalEndpointUnconfigured("http://localhost:3000")).toBe(true);
    expect(isOptionalEndpointUnconfigured("http://127.0.0.1:3030")).toBe(true);
    expect(isOptionalEndpointUnconfigured("https://redis.example.com")).toBe(false);
  });

  it("não transforma Redis/WAHA degradados em 503", () => {
    expect(
      overallHealth([{ status: "ok" }, { status: "degraded" }, { status: "degraded" }]),
    ).toEqual({ status: "degraded", httpStatus: 200 });
  });

  it("mantém 503 quando um serviço configurado está realmente indisponível", () => {
    expect(overallHealth([{ status: "ok" }, { status: "down" }, { status: "ok" }])).toEqual({
      status: "unhealthy",
      httpStatus: 503,
    });
  });
});
