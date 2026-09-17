import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";

const RAIZ = process.cwd();

const CAMINHOS_DE_CRIACAO = [
  "app/api/v1/channels/official/route.ts",
  "lib/channels/connect.ts",
] as const;

describe("todo canal criado pela interface nasce em pré-go-live", () => {
  it.each(CAMINHOS_DE_CRIACAO)("%s usa a configuração inicial compartilhada", (arquivo) => {
    const fonte = readFileSync(resolve(RAIZ, arquivo), "utf8");
    expect(fonte).toMatch(/import \{ metadataInicialDoCanal \}/);
    expect(fonte).toMatch(/metadata:\s*metadataInicialDoCanal\(\)/);
  });

  it.each([
    "app/api/v1/channel-sessions/route.ts",
    "app/api/v1/onboarding/whatsapp/session/route.ts",
  ])("%s cria via reserva transacional com pré-go-live no schema", (arquivo) => {
    const fonte = readFileSync(resolve(RAIZ, arquivo), "utf8");
    expect(fonte).toMatch(/await connectWahaChannel\(/);
    expect(fonte).not.toMatch(/\.insert\(/);
    const helper = readFileSync(resolve(RAIZ, "lib/channels/connect-waha.ts"), "utf8");
    expect(helper).toContain('authDb.rpc("fn_reserve_channel_connection"');
    const baseline = readFileSync(resolve(RAIZ, "supabase/baseline.sql"), "utf8");
    const fn = baseline.slice(baseline.lastIndexOf("create or replace function public.fn_reserve_channel_connection(")).split("\n$$;")[0]!;
    const initial = fn.match(/'(\{"ai_gate"[^']+\})'::jsonb/);
    expect(initial).not.toBeNull();
    expect(JSON.parse(initial![1]!)).toEqual(metadataInicialDoCanal());
    expect(fn).toContain("case when p_onboarding then '{\"onboarding\":true}'::jsonb");
    // 0232: o formato da 0228/0230 (dois uuid sem hífen) tem 69 caracteres, e o
    // WAHA recusa `name` acima de 54 com HTTP 400 — nenhum canal novo era criado.
    // O prefixo da org encolhe para 8 (`org_<8>_<32>` = 45). O gerador do banco é
    // a outra metade do mesmo defeito que `lib/channels/nome-da-sessao.ts` cobre
    // do lado do código; sem esta linha, só o `test:db` o vigiaria.
    expect(fn).toContain("left(replace(p_org::text,'-',''),8)");
  });

  it("reconectar canal parceiro preserva a configuração que já existia", () => {
    const fonte = readFileSync(resolve(RAIZ, "lib/channels/connect.ts"), "utf8");
    const update = fonte.slice(
      fonte.indexOf('? await admin.from("channel_sessions").update(linha)'),
      fonte.indexOf(": await admin", fonte.indexOf('? await admin.from("channel_sessions").update(linha)')),
    );
    expect(update).not.toContain("metadataInicialDoCanal");
  });
});
