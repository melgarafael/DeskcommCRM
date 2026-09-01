/**
 * `fallback_at` É ALCANÇÁVEL — só não pela tela.
 *
 * ## A frase que este arquivo desmente
 *
 * Três documentos afirmavam, com as mesmas palavras, que `fallback_at` "só
 * aparece para quem edita o banco à mão ou vem de um clone com valor legado"
 * (`HANDOFF-marca-propria.md`, dívida D7; `docs/testing/user-journey-map.md`,
 * caso M7). **As duas saídas dessa enumeração estão erradas, e a que funciona
 * ficou de fora:**
 *
 *   - *editar o banco à mão* — barrado. `platform_branding.accent_hex` nasceu com
 *     `check (accent_hex is null or accent_hex ~ '^#[0-9a-f]{6}$')` na própria
 *     `create table` da migration 0155. O CHECK que a frase cita como razão é o
 *     que torna esse caminho impossível, não o que o deixa raro;
 *   - *clone com valor legado* — impossível pelo mesmo motivo: a coluna nunca
 *     existiu sem a constraint, então não há janela em que um valor torto tenha
 *     entrado;
 *   - **o `.env`, que é o caminho que funciona**, não estava escrito em lugar
 *     nenhum. `lib/env.ts:201` é `z.string().optional().default("")` — sem
 *     formato, de propósito (uma var de COR não pode derrubar o boot; a razão
 *     está no docblock de lá). Qualquer string entra, desce por
 *     `camadaDoAmbiente` → `resolverMarca` → `motivoDoFallback`, e acende o
 *     alarme.
 *
 * Medido em `214f47f0`: `grep -c APP_ACCENT_HEX self-host-kit/install.sh` →
 * **0** — o instalador não perguntava a cor, e o único jeito de a chave existir
 * no `.env` era alguém escrevê-la à mão. Desde então o `install.sh` **pergunta e
 * grava**, com o validador `v_hex` (só `#` + 6 dígitos), e esse caminho ficou
 * coberto.
 *
 * **O que isto NÃO fecha, e é por isso que os casos abaixo continuam vivos:**
 * quem valida a forma é o instalador, não `lib/env.ts`. Um `.env` editado depois
 * da instalação, um clone que já tinha a chave torta, ou qualquer automação que
 * escreva o arquivo direto entram sem passar por `v_hex` — e `lib/env.ts:201`
 * aceita a string inteira. A entrevista estreitou a porta; não a fechou. Um dia
 * em que este arquivo pareça redundante, a pergunta a fazer é se `lib/env.ts`
 * passou a validar formato (não passou, e o caso (a2) abaixo é quem vigia isso).
 *
 * ## Por que isto é teste e não nota de rodapé
 *
 * `fallback_at` é o laço de retorno da marca (invariante 7 do Sistema Vivo): é o
 * que distingue "o produto ficou com a cor dele" de "a feature nunca foi
 * instalada". Um laço de retorno declarado inalcançável é um laço que ninguém
 * exercita — e ninguém nota quando ele para de fechar.
 *
 * ## Os códigos de recusa que NÃO têm gatilho hoje
 *
 * `CODIGOS_DE_RECUSA` (`lib/branding/instalacao.ts:106`) tem 8 códigos. A
 * classificação mora aqui, e não lá, porque esta onda não altera
 * `lib/branding/instalacao.ts` — quem for mexer naquele arquivo, leia isto antes:
 *
 *   - **com gatilho hoje:** `semente_invalida` (coberto abaixo),
 *     `papel_desconhecido` e `derivacao_falhou` (`resolve.ts:271` e `:298`),
 *     `nome_de_token_invalido` / `valor_fora_da_allowlist` / `saida_suspeita`
 *     (`css.ts:282`, `:290`, `:306`);
 *   - **rede de rollback, sem gatilho alcançável:** `envelope_malformado` e
 *     `formato_desconhecido`. Nada persiste um envelope: as três camadas
 *     (`camadaDaInstalacao`, `camadaDoAmbiente`, `camadaDaOrganizacao`) o montam
 *     em processo por `envelopeDeSemente`, que carimba `FORMATO_ATUAL` e
 *     `ALGORITMO_ATUAL` (`lib/branding/schema.ts:102-117`). Eles existem para o
 *     dia em que o formato mudar e um binário velho ler um envelope novo.
 *
 * **Não há teste para esses dois de propósito.** Um caso montando o envelope à
 * mão provaria que o `if` funciona, não que o laço fecha — e um teste que não
 * pode vermelhecer por um defeito real é decoração.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { cssDaMarca } from "@/lib/branding/css";
import { motivoDoFallback, registrarEstadoDaMarca } from "@/lib/branding/instalacao";
import { REGUA_DO_PRODUTO } from "@/lib/branding/regua-do-produto";
import { camadaDoAmbiente, resolverMarca } from "@/lib/branding/resolve";
import { platformBrandingSchema } from "@/lib/schemas/settings";

/**
 * A cadeia REAL do `app/layout.tsx:167`, sem o I/O.
 *
 * Repete a montagem de lá — resolução + `cssDaMarca`, os dois somados — em vez
 * de chamar só `resolverMarca`: metade das recusas (`nome_de_token_invalido`,
 * `valor_fora_da_allowlist`, `saida_suspeita`) nasce na serialização, e um
 * helper que ignorasse essa metade mediria um caminho que a produção não tem.
 */
function fallbackDoAmbiente(APP_ACCENT_HEX: string): string | null {
  const marca = resolverMarca([camadaDoAmbiente({ APP_ACCENT_HEX })], REGUA_DO_PRODUTO);
  const { motivos } = cssDaMarca(marca.cor);
  return motivoDoFallback([...marca.motivos, ...motivos]);
}

describe("`fallback_at` pelo `.env` — o caminho que existe", () => {
  it("(a) hex torto no `.env` acende o alarme com o motivo certo", () => {
    // As quatro formas que uma pessoa de fato digita: nome de cor, dígito fora
    // do alfabeto hex, sintaxe de CSS, e um dígito a menos.
    for (const valor of ["verde", "#GG0000", "rgb(0,255,0)", "#12345"]) {
      expect(fallbackDoAmbiente(valor), `APP_ACCENT_HEX=${valor}`).toBe("semente_invalida");
    }
  });

  it("(b) cor boa NÃO acende — o alarme apaga, que é a outra metade do laço", () => {
    // `#0b3d2e` não é neutro: ele produz motivos (`accent_deslocado` e
    // `redundancia_nao_cromatica_necessaria`, medidos). É o caso que separa
    // `CODIGOS_DE_RECUSA` de "qualquer motivo" — uma implementação ingênua
    // deixaria `fallback_at` aceso em quase toda marca, e alarme sempre aceso é
    // alarme que ninguém lê.
    const marca = resolverMarca(
      [camadaDoAmbiente({ APP_ACCENT_HEX: "#0b3d2e" })],
      REGUA_DO_PRODUTO,
    );
    expect(marca.motivos.length).toBeGreaterThan(0);
    expect(fallbackDoAmbiente("#0b3d2e")).toBeNull();

    // Chave declarada e vazia é o estado de fábrica do `install.sh`, não defeito.
    expect(fallbackDoAmbiente("")).toBeNull();
    expect(fallbackDoAmbiente("   ")).toBeNull();
  });

  it("(c) hex sem cerquilha pinta e não acende — tolerância deliberada", () => {
    // `ehHexValido` aceita `0ea5e9` (`rampa.ts:50`, `/^#?…/`) e a normalização
    // devolve `#0ea5e9`, que satisfaz o CHECK do banco. Recusar aqui faria o
    // operador que digitou a cor certa sem `#` ver a cor do produto e concluir
    // que o campo não funciona.
    const marca = resolverMarca(
      [camadaDoAmbiente({ APP_ACCENT_HEX: "0ea5e9" })],
      REGUA_DO_PRODUTO,
    );
    expect(marca.cor?.semente).toBe("#0ea5e9");
    expect(marca.origens.cor).toBe("env");
    expect(fallbackDoAmbiente("0ea5e9")).toBeNull();
  });
});

describe("a porta de entrada — `lib/env.ts` não valida a forma da cor", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("(a2) o schema do ambiente aceita o hex torto, e é isso que torna (a) alcançável", async () => {
    // Sem este caso, (a) prova a resolução e nada mais: ele passa um literal
    // para `camadaDoAmbiente` e não toca no schema que decide se esse literal
    // chega lá. Alguém que "consertasse" `lib/env.ts` acrescentando um
    // `.refine(ehHexValido)` fecharia a porta com (a) verde — e a frase do
    // HANDOFF viraria falsa outra vez, por baixo de um gate satisfeito.
    //
    // Reimporta o módulo REAL com o ambiente adulterado, em vez de reconstruir
    // o schema: um schema copiado aqui provaria que a cópia aceita.
    vi.resetModules();
    vi.stubEnv("APP_ACCENT_HEX", "verde");
    const { env } = await import("@/lib/env");
    expect(env.APP_ACCENT_HEX).toBe("verde");

    // A ponta a ponta: o valor que o schema deixou passar é o mesmo que
    // `app/layout.tsx:58` entrega a `camadaDoAmbiente(env)`.
    expect(fallbackDoAmbiente(env.APP_ACCENT_HEX)).toBe("semente_invalida");
  });
});

describe("`fallback_at` pela tela — o caminho que não existe", () => {
  it("(d) a Server Action recusa o hex torto antes de qualquer escrita", () => {
    // O CHECK do banco é a terceira guarda, não a única — e é a que este teste
    // não alcança sem Postgres. As outras duas são código: o botão Salvar
    // desabilitado (`app/admin/(protected)/marca/_form.tsx:313`, `!hexValido`) e
    // este schema, que `updateBranding.ts:9` aplica no servidor. Sem medir esta,
    // "inalcançável pela UI" seria afirmação sobre o banco valendo por afirmação
    // sobre a tela.
    for (const valor of ["verde", "#GG0000", "rgb(0,255,0)", "#12345"]) {
      const lido = platformBrandingSchema.safeParse({
        app_name: "Revenda XPTO",
        logo_url: null,
        accent_hex: valor,
        show_powered_by: true,
      });
      expect(lido.success, `accent_hex=${valor} deveria ser recusado`).toBe(false);
    }
    // Controle positivo: o schema não recusa tudo.
    expect(
      platformBrandingSchema.safeParse({
        app_name: "Revenda XPTO",
        logo_url: null,
        accent_hex: "#0b3d2e",
        show_powered_by: true,
      }).success,
    ).toBe(true);
  });
});

// Sem linha não há onde gravar, e `registrarEstadoDaMarca` sai antes de abrir
// cliente nenhum. O mock existe para transformar "não gravou" em ASSERÇÃO: sem
// ele, o caso passaria igual se a função tivesse chamado o Supabase e a chamada
// tivesse falhado calada.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("createAdminClient não devia ser chamado sem linha");
  },
}));

describe("gravar o estado sem linha", () => {
  it("(e) `registrarEstadoDaMarca(null, motivo)` volta sem gravar e sem lançar", async () => {
    // `instalacao.ts:369`. Decisão coerente que não estava escrita em lugar
    // nenhum: criar a linha singleton só para registrar um fallback inventaria
    // configuração que ninguém pediu — e o `.env` continua pintando.
    await expect(registrarEstadoDaMarca(null, "semente_invalida")).resolves.toBeUndefined();
    await expect(registrarEstadoDaMarca(null, null)).resolves.toBeUndefined();
  });
});
