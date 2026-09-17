import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ProfileForm } from "@/app/app/settings/profile/_form";
import { TenantForm } from "@/app/app/settings/tenant/_form";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { IDIOMAS, IDIOMA_PADRAO, normalizarIdioma, parseAcceptLanguage } from "@/lib/i18n/idiomas";
import { REGISTRO_DE_IDIOMAS, type IdiomaRegistrado, type NivelDeIdioma } from "@/lib/i18n/registro";

/**
 * UM IDIOMA SÓ APARECE QUANDO O REGISTRO DIZ QUE PODE.
 *
 * ─── O defeito que estes casos impedem ─────────────────────────────────────
 *
 * O PR #773 (chinês) acrescentava o código à lista de idiomas, e a lista
 * alimentava ao mesmo tempo o seletor do topo, a validação e o normalizador.
 * Resultado: o chinês apareceria para todo mundo no mesmo commit em que
 * entrava o primeiro caractere traduzido — o que a decisão do dono proíbe
 * ("a opção só aparece quando as telas principais estiverem traduzidas").
 *
 * O registro (`lib/i18n/registro.ts`) dá um nível a cada idioma. Estes casos
 * prendem o COMPORTAMENTO do nível em cada porta por onde um idioma chega a
 * alguém: a lista servida, o valor salvo, o cabeçalho do navegador e as duas
 * telas de Configurações. Eles leem o registro inteiro em vez de citar o
 * chinês pelo nome, para continuarem valendo no dia em que ele for promovido.
 */

vi.mock("@/app/actions/settings/updateProfile", () => ({
  updateProfile: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/app/actions/settings/updateTenant", () => ({
  updateTenant: vi.fn(async () => ({ ok: true })),
}));

/**
 * O oráculo é escrito AQUI, e não importado do registro: se o teste perguntasse
 * a `nivelApareceParaQuemUsa` quem aparece, um filtro quebrado dentro dela
 * deixaria implementação e teste errados juntos — e verdes.
 */
const NIVEIS_QUE_APARECEM: ReadonlySet<NivelDeIdioma> = new Set(["telas_principais", "completo"]);
const aparece = (idioma: IdiomaRegistrado) => NIVEIS_QUE_APARECEM.has(idioma.nivel);
const VISIVEIS = REGISTRO_DE_IDIOMAS.filter(aparece);

describe("o registro de idiomas", () => {
  it("não repete código, tag nem subtag do navegador", () => {
    const codigos = REGISTRO_DE_IDIOMAS.map((idioma) => idioma.codigo);
    const tags = REGISTRO_DE_IDIOMAS.map((idioma) => idioma.tagBcp47);
    const subtags = REGISTRO_DE_IDIOMAS.flatMap((idioma) => [...idioma.subtagsDoNavegador]);
    expect(new Set(codigos).size).toBe(codigos.length);
    expect(new Set(tags).size).toBe(tags.length);
    // Duas línguas reivindicando `zh` fariam o `Accept-Language` escolher pela
    // ordem do arquivo, em silêncio.
    expect(new Set(subtags).size).toBe(subtags.length);
  });

  it("começa pelo padrão do produto", () => {
    expect(REGISTRO_DE_IDIOMAS[0]?.codigo).toBe(IDIOMA_PADRAO);
  });

  it("o português e o espanhol são `completo` — nada neles afrouxa", () => {
    // É a promessa que faz o gate do espanhol reprovar. Rebaixar o espanhol
    // aqui soltaria a trava de toda frase de tela sem ninguém mexer no gate.
    const nivel = (codigo: string) => REGISTRO_DE_IDIOMAS.find((i) => i.codigo === codigo)?.nivel;
    expect(nivel("pt-BR")).toBe("completo");
    expect(nivel("es")).toBe("completo");
  });

  it("nenhum idioma declara `telas_principais` enquanto a régua não existe", () => {
    // O nível promete aparecer com as telas principais traduzidas, e o que são
    // "telas principais" ainda não é medido (fatia 5 do PROG-022). Declará-lo
    // hoje seria promover um idioma sem prova — o nível viraria decorativo.
    const semRegua = REGISTRO_DE_IDIOMAS.filter(
      (idioma: IdiomaRegistrado) => idioma.nivel === "telas_principais",
    );
    expect(
      semRegua.map((idioma) => idioma.codigo),
      "`telas_principais` ainda não tem régua medida: use `em_construcao` até a fatia 5 do PROG-022",
    ).toEqual([]);
  });
});

describe("em construção não chega a ninguém", () => {
  it("a lista servida é exatamente a dos níveis que aparecem, na ordem do registro", () => {
    expect([...IDIOMAS]).toEqual(VISIVEIS.map((idioma) => idioma.codigo));
  });

  it("um valor salvo em idioma que não aparece é servido como o padrão", () => {
    // `user_metadata.locale` e `organizations.locale` não têm CHECK: um valor
    // pode chegar pelo banco. Servi-lo mostraria uma tradução pela metade.
    for (const idioma of REGISTRO_DE_IDIOMAS) {
      const esperado = aparece(idioma) ? idioma.codigo : IDIOMA_PADRAO;
      expect(normalizarIdioma(idioma.codigo), idioma.codigo).toBe(esperado);
    }
  });

  it("o navegador não escolhe um idioma que não aparece", () => {
    // Quem nunca escolheu não pode cair numa tradução em construção: o login
    // sairia misturado, com o que falta em português.
    for (const idioma of REGISTRO_DE_IDIOMAS) {
      for (const subtag of idioma.subtagsDoNavegador) {
        const esperado = aparece(idioma) ? idioma.codigo : null;
        expect(parseAcceptLanguage(`${subtag}-XX,${subtag};q=0.9`), subtag).toBe(esperado);
      }
    }
  });
});

describe("as telas de Configurações oferecem o que o registro deixa aparecer", () => {
  /**
   * O Radix Select espelha as opções num `<select>` nativo oculto; é ali que se
   * lê a lista sem abrir o menu. Os valores são os CÓDIGOS, e os rótulos são o
   * nome de cada língua nela própria.
   */
  function opcoesDoIdioma(): { valor: string; rotulo: string }[] {
    const gatilho = screen.getByRole("combobox", { name: "Idioma" });
    const nativo = gatilho.parentElement?.querySelector("select");
    expect(nativo, "o <select> nativo do campo Idioma não foi achado").toBeTruthy();
    return [...(nativo?.querySelectorAll("option") ?? [])]
      .filter((opcao) => opcao.value !== "")
      .map((opcao) => ({ valor: opcao.value, rotulo: opcao.textContent ?? "" }));
  }

  const esperadas = VISIVEIS.map((idioma) => ({ valor: idioma.codigo, rotulo: idioma.nomeNativo }));

  it("perfil: 'seguir a empresa' mais os idiomas visíveis, e nada além", () => {
    render(
      <IdiomaProvider locale="pt-BR">
        <ProfileForm
          email="dona@empresa.com"
          initialFullName="Dona da Empresa"
          initialAvatarUrl={null}
          initialLocale="pt-BR"
          initialTimezone="America/Sao_Paulo"
        />
      </IdiomaProvider>,
    );
    expect(opcoesDoIdioma().filter((opcao) => opcao.valor !== "auto")).toEqual(esperadas);
  });

  it("organização: os idiomas visíveis, e nada além", () => {
    render(
      <IdiomaProvider locale="pt-BR">
        <TenantForm
          initial={{
            display_name: "Empresa",
            legal_name: "Empresa Ltda",
            cnpj: null,
            timezone: "America/Sao_Paulo",
            locale: "pt-BR",
            currency: "BRL",
            media_retention_days: 365,
            dpo_email: null,
            privacy_policy_url: null,
            lost_reasons_extra: [],
          }}
        />
      </IdiomaProvider>,
    );
    expect(opcoesDoIdioma()).toEqual(esperadas);
  });
});
