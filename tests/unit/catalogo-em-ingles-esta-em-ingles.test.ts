import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { REGISTRO_DE_IDIOMAS } from "@/lib/i18n/registro";

/**
 * O CATÁLOGO EM INGLÊS ESTÁ EM INGLÊS.
 *
 * ─── A linha de corte, a mesma do resto da base de idiomas ─────────────────
 *
 * Nada aqui conta chave faltando: frase sem inglês cai no português (decisão
 * 18.2), e quem acrescenta texto em português não precisa saber inglês. Este
 * arquivo só lê `lib/i18n/traducoes/en.json`, então só fica vermelho para quem
 * mexeu no inglês.
 *
 * A forma (texto não vazio, placeholder preservado, padrão de data que formata)
 * já é cobrada para todo catálogo em `catalogo-de-idioma-tem-forma`. O que este
 * arquivo acrescenta é o defeito que só um idioma de alfabeto latino tem: a
 * tradução que ficou em português. Um catálogo chinês com português dentro se
 * vê de longe; um inglês com "Salvar alterações" no meio passa por revisão.
 *
 * ─── A régua, em duas partes ──────────────────────────────────────────────
 *
 * 1. Inglês não usa `ã õ ç á é í ó ú â ê ô à`. Uma palavra com essas letras só
 *    é legítima quando é nome próprio ("São Paulo", "Bogotá"), e esses nomes
 *    estão escritos abaixo, um por um. A régua não tenta adivinhar nome próprio
 *    pela maiúscula nem pela chave: "Configurações saved" começa com maiúscula,
 *    e "Save alterações" copia a palavra da própria chave.
 * 2. Português sem acento ("Salvar assinatura") escapa da primeira parte —
 *    medido por sabotagem. Por isso há também uma lista curta de palavras que o
 *    português usa a toda hora e o inglês nunca: medida no catálogo inteiro ao
 *    escrever, nenhuma delas aparece numa tradução.
 *
 * O que fica de fora, e é revisão humana: tradução errada, e português que não
 * tem acento nem está na lista.
 *
 *     pnpm vitest run tests/unit/catalogo-em-ingles-esta-em-ingles.test.ts
 */

const CAMINHO = join(__dirname, "..", "..", "lib", "i18n", "traducoes", "en.json");
const CATALOGO = JSON.parse(readFileSync(CAMINHO, "utf8")) as Record<string, string>;

const LETRA_DO_PORTUGUES = /[ãõçáéíóúâêôà]/i;
const palavras = (texto: string) => texto.split(/[^\p{L}]+/u).filter(Boolean);

/**
 * Nomes próprios que o inglês escreve com acento. Entra aqui só nome de lugar
 * ou de pessoa que a tela mostra como é, nunca palavra comum.
 */
const NOMES_PROPRIOS_COM_ACENTO = new Set([
  "São", // São Paulo
  "Belém",
  "Pará",
  "Cuiabá",
  "Brasília",
  "Bogotá",
  "Asunción", // capital do Paraguai: o inglês usa a grafia espanhola
  "María", // nome de exemplo num placeholder
]);

/**
 * Palavras sem acento que o português usa a toda hora e o inglês não usa.
 * Sem "sem" (SEM, de anúncio) nem "como" (cidade): só palavra que nunca é inglês.
 */
const PALAVRAS_DO_PORTUGUES = new Set(
  (
    "para uma pelo pela seu sua seus suas isso este esta quando ainda agora aqui quem pode mais muito " +
    "nenhum nenhuma salvar enviar editar excluir mensagem mensagens contato contatos conversa conversas " +
    "cliente clientes equipe empresa empresas tela funil etapa"
  ).split(" "),
);

/**
 * Dado que o banco grava em português e a tela cita como é: o nome que a
 * anonimização dá ao contato (`fn_lgpd_cascade_redact_contact`, no baseline).
 */
const DADO_GRAVADO_EM_PORTUGUES = ["Cliente Anonimizado #N"];

/** As palavras em português que a tradução carrega sem serem nome próprio nem dado citado. */
function sobraDePortugues(valor: string): string[] {
  const semDado = DADO_GRAVADO_EM_PORTUGUES.reduce((texto, dado) => texto.split(dado).join(" "), valor);
  return palavras(semDado).filter(
    (palavra) =>
      (LETRA_DO_PORTUGUES.test(palavra) && !NOMES_PROPRIOS_COM_ACENTO.has(palavra)) ||
      PALAVRAS_DO_PORTUGUES.has(palavra.toLowerCase()),
  );
}

describe("o catálogo em inglês", () => {
  it("é de um idioma registrado", () => {
    expect(REGISTRO_DE_IDIOMAS.map((idioma) => idioma.codigo)).toContain("en");
  });

  it("a régua enxerga — o verde abaixo não é vacuidade", () => {
    expect(Object.keys(CATALOGO).length).toBeGreaterThan(0);
    // Palavra portuguesa esquecida no meio da frase, mesmo copiada da chave.
    expect(sobraDePortugues("Save alterações")).toEqual(["alterações"]);
    // Frase colada sem tradução, começando por maiúscula.
    expect(sobraDePortugues("Configurações da organização")).toEqual(["Configurações", "organização"]);
    // Português sem acento.
    expect(sobraDePortugues("Salvar assinatura")).toEqual(["Salvar"]);
    // Nome próprio e dado citado passam.
    expect(sobraDePortugues("São Paulo (Brazil)")).toEqual([]);
    expect(sobraDePortugues('The name becomes "Cliente Anonimizado #N".')).toEqual([]);
  });

  it("nenhuma tradução carrega palavra em português", () => {
    const sobras = Object.entries(CATALOGO)
      .map(([chave, valor]) => ({ chave, sobra: sobraDePortugues(valor) }))
      .filter(({ sobra }) => sobra.length > 0)
      .map(({ chave, sobra }) => `${JSON.stringify(chave)} → ${sobra.join(", ")}`);
    expect(
      sobras,
      `${sobras.length} tradução(ões) com palavra em português. Traduza; se for nome próprio, ` +
        "acrescente-o a NOMES_PROPRIOS_COM_ACENTO neste arquivo.",
    ).toEqual([]);
  });

  it("'há {tempo}' põe o marcador depois da duração, como o inglês pede", () => {
    // É a razão de a frase ter virado uma chave com lacuna: "3 days ago", nunca "ago 3 days".
    expect(CATALOGO["há {tempo}"]?.replace("{tempo}", "3 days")).toBe("3 days ago");
  });
});
