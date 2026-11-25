/**
 * O teto de respostas do TikTok mora em DOIS lugares por necessidade: o TypeScript
 * (`LIMITES_POR_REDE_SOCIAL`, que decide por autor) e o trigger do banco
 * (`fn_limite_da_rede_na_insercao`, que barra a corrida). Este teste prende os dois
 * juntos e prende a régua única da contagem: ninguém conta mensagem da janela por
 * conta própria.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LIMITES_POR_REDE_SOCIAL } from "./limites-da-rede";

const raiz = process.cwd();
const migrations = join(raiz, "supabase", "migrations");
const arquivo = readdirSync(migrations).find((f) => f.endsWith("_limite_da_rede_na_insercao.sql"));
const sql = arquivo ? readFileSync(join(migrations, arquivo), "utf8") : "";
const baseline = readFileSync(join(raiz, "supabase", "baseline.sql"), "utf8");

describe("o teto da rede no banco", () => {
  it("a migration existe e o teto do trigger é o mesmo do TypeScript", () => {
    expect(arquivo).toBeDefined();
    const teto = LIMITES_POR_REDE_SOCIAL.tiktok!.maxRespostas;
    expect(sql).toMatch(new RegExp(`v_total >= ${teto}\\b`));
    expect(sql).toMatch(new RegExp(`teto=${teto}\\b`));
  });

  it("o trigger pega o lock da conversa ANTES de contar", () => {
    const lock = sql.indexOf("pg_advisory_xact_lock");
    const conta = sql.indexOf("v_total := public.fn_respostas_na_janela");
    expect(lock).toBeGreaterThan(-1);
    expect(conta).toBeGreaterThan(lock);
  });

  it("o baseline traz a função e o trigger, com revoke, e eles entram antes da VARREDURA anon", () => {
    const ultimo = (trecho: string) => baseline.lastIndexOf(trecho);
    expect(ultimo("create or replace function public.fn_respostas_na_janela")).toBeGreaterThan(-1);
    expect(ultimo("create trigger trg_limite_da_rede_na_insercao")).toBeGreaterThan(-1);
    expect(baseline).toMatch(/revoke execute on function public\.fn_respostas_na_janela/);
    expect(baseline).toMatch(/revoke execute on function public\.fn_limite_da_rede_na_insercao/);
  });

  it("a contagem tem UMA régua: ninguém no código repete o predicado de `messages`", () => {
    const leitores = [
      "lib/channels/social/respostas-na-janela.ts",
      "lib/agent-engine/agent/limite-da-rede.ts",
    ].map((f) => readFileSync(join(raiz, f), "utf8"));
    for (const fonte of leitores) {
      expect(fonte).toMatch(/fn_respostas_na_janela/);
      expect(fonte).not.toMatch(/from\("messages"\)|from messages m|\.gte\("sent_at"/);
    }
  });
});
