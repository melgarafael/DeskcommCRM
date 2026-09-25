/**
 * A JUNÇÃO DE FICHAS LEVA O `social_identity` DO CONTATO QUE SAI (issue #1455).
 *
 * `fn_mesclar_contatos` herdava `name`, `display_name`, `birthdate`, `email`,
 * `phone_number` e a origem do `waha_lid` da ficha perdedora — a identidade
 * social ficou de fora. Com o #1444 o `upsertSocialContact` passou a filtrar
 * `is_merged_into is null` (o mesmo que `fn_upsert_wa_contact` já faz no
 * WhatsApp), então depois de fundir uma ficha que veio do Instagram (ou de
 * outra rede conectada) a próxima DM daquela pessoa não encontrava ficha viva
 * com aquela identidade e abria uma nova: refazia a duplicata que a fusão
 * acabou de desfazer.
 *
 * O teste é ESTÁTICO e lê os DOIS artefatos — a cadeia em
 * `supabase/migrations/` (o que o Supabase CLI aplica) e o `supabase/baseline.sql`
 * (o que o `install.sh`/`update.sh` do self-host aplica). Cobrir só um deixaria
 * metade do público sem controle, pela mesma razão dos irmãos
 * `apendice-do-baseline-nao-diverge-da-cadeia` e
 * `indice-de-contato-ignora-ficha-mesclada`. Não há Postgres nesta VPS, então o
 * que se mede aqui é o CORPO das funções; quem executa a fusão contra Postgres
 * real é `tests/invariants/juntar-contatos-duplicados.test.ts`, no CI.
 *
 * Comando:
 *     npx vitest run tests/unit/fusao-de-contato-herda-a-identidade-social.test.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = join(process.cwd(), "supabase");
const BASELINE = readFileSync(join(RAIZ, "baseline.sql"), "utf8");

const CADEIA = readdirSync(join(RAIZ, "migrations"))
  .filter((a) => a.endsWith(".sql"))
  .sort() // nome de arquivo = ordem de aplicação (timestamp no prefixo)
  .map((a) => readFileSync(join(RAIZ, "migrations", a), "utf8"))
  .join("\n");

/**
 * O corpo da ÚLTIMA `fn_mesclar_contatos` de um texto SQL — é ela que vence
 * (`create or replace` na ordem do arquivo). A marca do delimitador é lida do
 * próprio texto, como no irmão `apendice-do-baseline-nao-diverge-da-cadeia`:
 * o baseline usa `$function$` onde algumas migrations usam `$$`, e fixar `$$;`
 * faria o corpo ser lido além do fim.
 */
function ultimoCorpo(texto: string): string {
  const re = /create or replace function public\.fn_mesclar_contatos\s*\(/gi;
  let ultimo: string | null = null;
  for (let m = re.exec(texto); m !== null; m = re.exec(texto)) {
    const abertura = /\$([a-z_]*)\$/i.exec(texto.slice(m.index, m.index + 600));
    if (!abertura) continue;
    const marca = abertura[0];
    const fim = texto.indexOf(marca, m.index + abertura.index + marca.length);
    ultimo = texto.slice(m.index, fim + marca.length);
  }
  if (ultimo === null) {
    throw new Error("fn_mesclar_contatos não encontrada no artefato");
  }
  return ultimo;
}

const CORPO_BASELINE = ultimoCorpo(BASELINE);
const CORPO_CADEIA = ultimoCorpo(CADEIA);

describe("a fusão de fichas e a identidade social", () => {
  it("a fusão HERDA o social_identity do contato que sai, nos DOIS artefatos", () => {
    for (const [nome, corpo] of [
      ["baseline", CORPO_BASELINE],
      ["cadeia de migrations", CORPO_CADEIA],
    ] as const) {
      expect(
        corpo,
        `${nome}: o select que lê a identidade social dos perdedores não está no corpo`,
      ).toContain("c.social_identity into v_social");
      expect(
        corpo,
        `${nome}: o update não escreve a identidade herdada no vencedor`,
      ).toContain("social_identity = coalesce(social_identity, v_social)");
    }
  });

  it("a herança tem guarda de unicidade contra um TERCEIRO contato vivo", () => {
    // O índice `contacts_org_social_identity_unique` é parcial em
    // `is_merged_into is null`: a lápide já tirou os perdedores da disputa, então
    // o único conflito possível é com outra ficha VIVA da mesma organização — e
    // nesse caso o vencedor simplesmente não herda, como nos outros campos.
    expect(CORPO_BASELINE).toMatch(
      /if v_social is not null and exists \(\s*select 1 from public\.contacts o\s*where o\.organization_id = p_organization_id and o\.is_merged_into is null\s*and o\.id <> p_contato_principal and o\.social_identity = v_social\s*\) then v_social := null; end if;/,
    );
    expect(CORPO_CADEIA).toMatch(
      /if v_social is not null and exists \([\s\S]*?o\.social_identity = v_social[\s\S]*?\) then v_social := null; end if;/,
    );
  });

  it("o vencedor que JÁ tem identidade social não é sobrescrito", () => {
    // `coalesce` do campo para o campo: a identidade vigente do vencedor manda.
    // A régua olha SÓ o bloco do `update` — fora dele, a comparação
    // `o.social_identity = v_social` da guarda de unicidade é exatamente o
    // contrário (provar o conflito) e um regex solto acusaria ela também.
    const update = /update public\.contacts set([\s\S]*?)where id = p_contato_principal/.exec(
      CORPO_BASELINE,
    );
    expect(update, "o update do vencedor não foi encontrado no corpo").not.toBeNull();
    expect(update?.[1]).toContain("social_identity = coalesce(social_identity, v_social)");
    expect(update?.[1]).not.toMatch(/social_identity\s*=\s*v_social\b/);
  });

  it("controle: a herança do waha_lid continua no lugar (corte vermelho/verde)", () => {
    // Caso que NÃO depende do conserto: se ele acusar, o instrumento (extração
    // do corpo) é que quebrou, não a mudança.
    expect(CORPO_BASELINE).toContain("source_metadata->>'waha_lid' into v_lid");
    expect(CORPO_CADEIA).toContain("source_metadata->>'waha_lid' into v_lid");
  });
});
