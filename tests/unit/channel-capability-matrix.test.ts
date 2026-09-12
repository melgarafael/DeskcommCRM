/**
 * Invariante da matriz capability × provider (`docs/doctrine/restricao-de-canal.md`).
 *
 * Mora em `tests/unit/` — e não em `tests/invariants/` como o plano dizia — por
 * medição, não por gosto: `vitest.config.ts` EXCLUI `tests/invariants/**` do
 * `test:unit`, essa pasta só roda via `pnpm test:db` (Docker + Postgres efêmero) e
 * `.github/workflows/ci.yml` roda apenas typecheck + lint + `pnpm test:unit`. Um
 * teste de constante TypeScript lá dentro exigiria um banco para rodar e **nunca
 * reprovaria o CI** — o oposto do que o invariante 2 da doutrina promete.
 */
import { describe, expect, it } from "vitest";
import {
  CHANNEL_CAPABILITIES,
  capabilitiesOf,
  transportaMensagem,
  type ChannelProvider,
  type ProviderDeMensagem,
} from "@/lib/channels/capabilities";

const PROVIDERS = ["waha", "meta_cloud", "zernio"] as const satisfies readonly ProviderDeMensagem[];

/**
 * Esquecer um provider aqui passa a ser erro de COMPILAÇÃO.
 *
 * A lista era literal e solta: um canal novo entrava em `ChannelProvider` e na
 * matriz sem nunca ser varrido por este arquivo, e o teste seguia verde
 * afirmando exaustividade que não tinha. O tipo abaixo é `never` enquanto
 * sobrar provider fora da lista, e `tsc` reprova — antes do teste rodar.
 */
type ProviderNaoVarrido = Exclude<ProviderDeMensagem, (typeof PROVIDERS)[number]>;
const _todoProviderEstaNaLista: ProviderNaoVarrido extends never ? true : never = true;
void _todoProviderEstaNaLista;
const CAPABILITIES = [
  "freeformOutsideWindow",
  "requiresTemplates",
  "canManageTemplates",
  "banRisk",
  "minIntervalMs",
  "voiceNote",
  "groups",
  "costPerMessage",
] as const;

describe("matriz capability × provider é exaustiva", () => {
  it("todo provider declara TODA capability", () => {
    for (const p of PROVIDERS) {
      for (const c of CAPABILITIES) {
        expect(CHANNEL_CAPABILITIES[p], `${p} não declara ${c}`).toHaveProperty(c);
      }
    }
  });

  it("nenhuma capability é declarada sem estar na lista (código morto)", () => {
    for (const p of PROVIDERS) {
      for (const key of Object.keys(CHANNEL_CAPABILITIES[p])) {
        expect(CAPABILITIES as readonly string[]).toContain(key);
      }
    }
  });

  it("resolução é fail-closed — provider desconhecido lança", () => {
    expect(() => capabilitiesOf("telegram" as ChannelProvider)).toThrow(/unknown_channel_provider/);
  });

  it("chamada de voz não responde a pergunta de canal de mensagem", () => {
    // `wacalls` É um provider válido de `channel_sessions` (o CHECK do banco o
    // aceita desde a migration 0232) e NÃO é canal de mensagem. Perguntar a ele
    // o que a matriz mede é erro de categoria, e a resposta certa é lançar —
    // não um objeto com tudo `false`, que faria a pergunta parecer legítima e
    // deixaria o chamador seguir adiante achando que tem um canal na mão.
    expect(() => capabilitiesOf("wacalls" as ChannelProvider)).toThrow(/unknown_channel_provider/);
    expect(transportaMensagem("wacalls")).toBe(false);
    for (const p of PROVIDERS) expect(transportaMensagem(p)).toBe(true);
    // Provider mais novo que este código (clone que atualizou o schema antes da
    // imagem) também não serve para mandar recado.
    expect(transportaMensagem("telegram")).toBe(false);
    expect(transportaMensagem(null)).toBe(false);
  });

  it("as duas famílias de restrição são mutuamente exclusivas por provider", () => {
    // auto-restrição (banRisk) e hetero-restrição (requiresTemplates) nunca coexistem:
    // é o que a doutrina restricao-de-canal.md afirma sobre a física dos canais.
    //
    // NÃO APAGUE ESTE CASO se ele ficar vermelho. Vermelho aqui significa que algum
    // canal passou a declarar as duas famílias — ou seja, que a tese central da
    // doutrina ("nenhuma é subconjunto da outra; elas convivem como regras irmãs")
    // encontrou um contraexemplo. O conserto é revisar a doutrina com o caso na mão
    // e decidir o que fazer quando as duas barram ao mesmo tempo (adiar? mudar a
    // forma da mensagem? escalar ao humano?), não silenciar o alarme que descobriu
    // a lacuna.
    for (const p of PROVIDERS) {
      const c = CHANNEL_CAPABILITIES[p];
      expect(c.banRisk && c.requiresTemplates, `${p} declara as duas famílias`).toBe(false);
    }
  });
});
