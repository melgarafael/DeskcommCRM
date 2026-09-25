import { afterEach, describe, expect, it } from "vitest";

import { fecharPool, fecharTodosOsPools, obterPool } from "./conexao";
import type { ConexaoExterna } from "./types";

function conexao(over: Partial<ConexaoExterna> = {}): ConexaoExterna {
  return {
    id: "conn-1",
    organizationId: "org-1",
    label: "X",
    host: "localhost",
    port: 5432,
    database: "db",
    username: "u",
    password: "p",
    sslMode: "disable",
    maxRows: 200,
    maxFilters: 20,
    maxResponseBytes: 30_000,
    versao: "2026-09-11T00:00:00.000Z",
    ...over,
  };
}

afterEach(async () => {
  await fecharTodosOsPools();
});

describe("obterPool — cache e invalidação", () => {
  it("reusa o MESMO pool para a mesma conexão", () => {
    expect(obterPool(conexao())).toBe(obterPool(conexao()));
  });

  it("recria o pool quando o updated_at muda (credencial editada)", () => {
    const antes = obterPool(conexao());
    const depois = obterPool(conexao({ versao: "2026-09-12T00:00:00.000Z" }));
    expect(depois).not.toBe(antes);
  });

  it("recria o pool quando o host muda na mesma conexão", () => {
    const antes = obterPool(conexao());
    const depois = obterPool(conexao({ host: "outro.exemplo.com" }));
    expect(depois).not.toBe(antes);
  });

  it("`fecharPool` descarta o cache — o próximo uso abre outro pool", async () => {
    const antes = obterPool(conexao());
    await fecharPool("conn-1");
    expect(obterPool(conexao())).not.toBe(antes);
  });

  it("conexões diferentes têm pools diferentes", () => {
    const a = obterPool(conexao({ id: "a" }));
    const b = obterPool(conexao({ id: "b" }));
    expect(a).not.toBe(b);
  });
});
