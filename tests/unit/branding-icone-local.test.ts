import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolverIconeLocal } from "@/lib/branding/icone-local";

describe("resolverIconeLocal", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "icone-local-"));
    writeFileSync(path.join(dir, "kora-icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lê o arquivo quando o caminho é raiz-relativo e existe em public/", () => {
    const resultado = resolverIconeLocal("/kora-icon.png", dir);
    expect(resultado).not.toBeNull();
    expect(resultado?.contentType).toBe("image/png");
    expect(resultado?.bytes.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
  });

  it("devolve null para URL externa — SSRF continua fechado", () => {
    expect(resolverIconeLocal("https://cdn.exemplo.com/logo.png", dir)).toBeNull();
    expect(resolverIconeLocal("http://169.254.169.254/latest/meta-data", dir)).toBeNull();
    expect(resolverIconeLocal("//host-qualquer/logo.png", dir)).toBeNull();
  });

  it("devolve null quando não há logo configurado", () => {
    expect(resolverIconeLocal(null, dir)).toBeNull();
    expect(resolverIconeLocal(undefined, dir)).toBeNull();
    expect(resolverIconeLocal("", dir)).toBeNull();
  });

  it("devolve null para travessia de diretório — a forma não permite segunda barra", () => {
    expect(resolverIconeLocal("/../secrets.png", dir)).toBeNull();
    expect(resolverIconeLocal("/sub/kora-icon.png", dir)).toBeNull();
  });

  it("devolve null para extensão fora da allowlist", () => {
    writeFileSync(path.join(dir, "kora-icon.svg"), "<svg></svg>");
    expect(resolverIconeLocal("/kora-icon.svg", dir)).toBeNull();
  });

  it("devolve null quando o arquivo não existe no disco", () => {
    expect(resolverIconeLocal("/nao-existe.png", dir)).toBeNull();
  });

  it("aceita .jpg, .jpeg e .ico com o content-type certo", () => {
    writeFileSync(path.join(dir, "a.jpg"), Buffer.from([1]));
    writeFileSync(path.join(dir, "b.jpeg"), Buffer.from([1]));
    writeFileSync(path.join(dir, "c.ico"), Buffer.from([1]));
    expect(resolverIconeLocal("/a.jpg", dir)?.contentType).toBe("image/jpeg");
    expect(resolverIconeLocal("/b.jpeg", dir)?.contentType).toBe("image/jpeg");
    expect(resolverIconeLocal("/c.ico", dir)?.contentType).toBe("image/x-icon");
  });
});
