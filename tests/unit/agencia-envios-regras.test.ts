import { describe, expect, it } from "vitest";

import {
  caminhoDoEnvio,
  caminhoEhDoCliente,
  nomeNoDrive,
  PEDACO_DA_COPIA,
  problemaNoArquivo,
  proximoPedaco,
  subpastaDoEnvio,
  TAMANHO_MAXIMO_DO_VIDEO,
} from "@/lib/agencia/envios/regras";
import { ehAviso, textoDoPedidoDeAprovacao } from "@/lib/agencia/aprovacoes/vocabulario";

const CLIENTE = "8a49b809-3320-40d0-8e18-c3be9b53f0c8";
const UUID = "11111111-2222-4333-8444-555555555555";

describe("envios — arquivo aceito (E2)", () => {
  it("vídeo até 2 GB, só mp4/mov/webm", () => {
    expect(problemaNoArquivo("video", "video/mp4", TAMANHO_MAXIMO_DO_VIDEO)).toBeNull();
    expect(problemaNoArquivo("video", "video/mp4", TAMANHO_MAXIMO_DO_VIDEO + 1)).toMatch(/2 GB/);
    expect(problemaNoArquivo("video", "image/png", 10)).toMatch(/Vídeo precisa/);
    expect(problemaNoArquivo("video", "video/mp4", 0)).toMatch(/vazio/);
  });

  it("arte só imagem, até 50 MB; aviso e roteiro não levam arquivo", () => {
    expect(problemaNoArquivo("arte", "image/webp", 5_000_000)).toBeNull();
    expect(problemaNoArquivo("arte", "video/mp4", 10)).toMatch(/Arte precisa/);
    expect(problemaNoArquivo("arte", "image/png", 60 * 1024 * 1024)).toMatch(/50 MB/);
    expect(problemaNoArquivo("aviso", "image/png", 10)).toMatch(/não leva arquivo/);
    expect(problemaNoArquivo("roteiro", "application/pdf", 10)).toMatch(/não leva arquivo/);
    expect(problemaNoArquivo("estrategia", "application/pdf", 10)).toBeNull();
    expect(problemaNoArquivo("estrategia", "application/zip", 10)).toMatch(/Formato não aceito/);
  });
});

describe("envios — caminho no bucket (E3)", () => {
  it("nasce na pasta do cliente, com a extensão do tipo", () => {
    const c = caminhoDoEnvio(CLIENTE, UUID, "video/quicktime");
    expect(c).toBe(`${CLIENTE}/${UUID}.mov`);
    expect(caminhoEhDoCliente(c, CLIENTE)).toBe(true);
  });

  it("recusa caminho de outro cliente ou que tenta sair da pasta", () => {
    expect(caminhoEhDoCliente(`${UUID}/${UUID}.mp4`, CLIENTE)).toBe(false);
    expect(caminhoEhDoCliente(`${CLIENTE}/../${UUID}.mp4`, CLIENTE)).toBe(false);
    expect(caminhoEhDoCliente(`${CLIENTE}/meu video.mp4`, CLIENTE)).toBe(false);
  });
});

describe("envios — cópia para o Drive (E6)", () => {
  it("subpasta por tipo; aviso não vai para o Drive", () => {
    expect(subpastaDoEnvio("video")).toBe("06 Edições");
    expect(subpastaDoEnvio("arte")).toBe("07 Artes");
    expect(subpastaDoEnvio("roteiro")).toBe("03 Planejamento");
    expect(subpastaDoEnvio("aviso")).toBeNull();
  });

  it("pedaços múltiplos de 256 KB, o último menor, e para no fim", () => {
    expect(PEDACO_DA_COPIA % (256 * 1024)).toBe(0);
    const total = PEDACO_DA_COPIA * 2 + 100;
    expect(proximoPedaco(0, total)).toEqual({ inicio: 0, fim: PEDACO_DA_COPIA - 1, ultimo: false });
    expect(proximoPedaco(PEDACO_DA_COPIA * 2, total)).toEqual({ inicio: PEDACO_DA_COPIA * 2, fim: total - 1, ultimo: true });
    expect(proximoPedaco(total, total)).toBeNull();
  });

  it("nome no Drive com data, título limpo e versão", () => {
    expect(nomeNoDrive({ titulo: "Reels: vitrine/Natal", versao: 2, dia: "2026-12-01", extensao: "mp4" })).toBe("2026-12-01 Reels- vitrine-Natal (v2).mp4");
  });
});

describe("envios — aviso (E5, E10)", () => {
  it("o aviso pede ciência, com texto de WhatsApp próprio", () => {
    expect(ehAviso("aviso")).toBe(true);
    expect(ehAviso("roteiro")).toBe(false);
    const t = textoDoPedidoDeAprovacao({ tipo: "aviso", titulo: "Gravação remarcada", url: "https://x/app/aprovacoes", agencia: "Agência", versao: 1 });
    expect(t).toMatch(/Aviso da agência: Gravação remarcada/);
    expect(t).toMatch(/ciente/);
  });
});
