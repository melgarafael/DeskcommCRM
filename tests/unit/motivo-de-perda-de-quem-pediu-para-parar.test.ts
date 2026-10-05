/**
 * O motivo com que a ingestão fecha o negócio de quem respondeu PARAR (#2049,
 * migration 0513) precisa existir nos DOIS lados: no vocabulário do código, que
 * a tela traduz, e no array canônico do trigger `fn_validate_lost_reason_required`
 * — sem ele o banco recusa a perda com 22023 `lost_reason_invalid` e o negócio
 * fica aberto, calado (o fechamento NUNCA lança, só loga).
 *
 * E ele CONTA como perda (decisão do dono, doc 85): ao contrário da
 * transferência (0266), nenhuma métrica o exclui.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_LOST_REASONS,
  categoriaPadraoDoMotivo,
  rotuloDoMotivoDePerda,
} from "@/lib/schemas/leads";
import { traduzir } from "@/lib/i18n/dicionario";

const MOTIVO = "opted_out_of_messages";
const raiz = path.resolve(__dirname, "../..");
const baseline = readFileSync(path.join(raiz, "supabase/baseline.sql"), "utf8");

/** O array canônico da ÚLTIMA definição do trigger — a que vale num banco instalado. */
function canonicosDoTrigger(sql: string): string[] {
  const corte = sql.lastIndexOf("create or replace function public.fn_validate_lost_reason_required()");
  expect(corte, "fn_validate_lost_reason_required não encontrada").toBeGreaterThan(-1);
  const declaracao = /v_canonical text\[\] := array\[([\s\S]*?)\];/.exec(sql.slice(corte));
  const lista = declaracao?.[1];
  expect(lista, "array v_canonical não encontrado").toBeDefined();
  return [...(lista ?? "").matchAll(/'([a-z_]+)'/g)].flatMap((m) => m[1] ?? []);
}

describe("motivo de perda de quem pediu para não receber mensagens", () => {
  it("é canônico no código, com rótulo próprio e tradução", () => {
    expect([...CANONICAL_LOST_REASONS]).toContain(MOTIVO);
    expect(rotuloDoMotivoDePerda(MOTIVO)).toBe("Pediu para não receber mensagens");
    expect(traduzir("Pediu para não receber mensagens", "es")).toBe("Pidió no recibir mensajes");
    expect(categoriaPadraoDoMotivo(MOTIVO)).toBe("Cliente");
  });

  it("o trigger do baseline aceita TODO motivo canônico do código", () => {
    expect(canonicosDoTrigger(baseline).sort()).toEqual([...CANONICAL_LOST_REASONS].sort());
  });

  it("a migration 0513 aceita o motivo e está no MANIFEST", () => {
    const dir = path.join(raiz, "supabase/migrations");
    const arquivo = readdirSync(dir).find((f) => f.includes("_0513_"));
    expect(arquivo, "migration 0513 ausente").toBeDefined();
    expect(canonicosDoTrigger(readFileSync(path.join(dir, arquivo!), "utf8"))).toContain(MOTIVO);
    expect(readFileSync(path.join(dir, "MANIFEST.md"), "utf8")).toContain("0513_motivo_de_perda_pediu_para_nao_receber");
  });

  it("conta como perda: nenhuma métrica do baseline o exclui", () => {
    expect(baseline).not.toMatch(/lost_reason[^\n]*<>\s*'opted_out_of_messages'/);
  });
});
