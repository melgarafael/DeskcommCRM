import { describe, expect, it } from "vitest";

import {
  aplicarDiagnostico,
  autoriaDoAgente,
  autoriaDoUsuario,
  CHAVES_DO_DIAGNOSTICO,
  cnpjInvalido,
  diagnosticoDoContatoNovo,
  diagnosticoVazio,
  escritoPelaIA,
  gravacaoDaAba,
  gravacaoDoAgente,
  lerDiagnostico,
  podeEditarDiagnostico,
  segmentoDoContatoNovo,
  textosDoDiagnostico,
  type TextosDoDiagnostico,
} from "./diagnostico-do-contato";

const AGENTE = "11111111-1111-4111-8111-111111111111";
const USUARIO = "22222222-2222-4222-8222-222222222222";
const AGENTE_ANTERIOR = "55555555-5555-4555-8555-555555555555";
/** CNPJ numérico de exemplo com DV válido. */
const CNPJ = "11222333000181";
const AGORA = new Date("2026-11-14T15:00:00.000Z");

const VAZIO: TextosDoDiagnostico = {
  segmento: "",
  cnpj: "",
  resumo: "",
  oferta: "",
  observacoes: "",
};

describe("as chaves moram em custom_fields, com os nomes combinados", () => {
  it("congela os nomes: a ferramenta do agente e a 1ª mensagem leem os mesmos", () => {
    expect(CHAVES_DO_DIAGNOSTICO).toEqual({
      segmento: "segmento",
      cnpj: "documento_cnpj",
      resumo: "diag_resumo",
      oferta: "diag_oferta",
      observacoes: "diag_observacoes",
      por: "diag_por",
      em: "diag_em",
    });
  });
});

describe("lerDiagnostico — leitura tolerante", () => {
  it("lê os textos, a autoria e a data", () => {
    const lido = lerDiagnostico({
      segmento: "  Clínica odontológica ",
      documento_cnpj: CNPJ,
      diag_resumo: "Agenda cheia de buracos.",
      diag_oferta: "Lembrete de consulta.",
      diag_observacoes: "Falar com a Bia.",
      diag_por: autoriaDoAgente(AGENTE),
      diag_em: AGORA.toISOString(),
    });
    expect(lido).toEqual({
      segmento: "Clínica odontológica",
      cnpj: CNPJ,
      resumo: "Agenda cheia de buracos.",
      oferta: "Lembrete de consulta.",
      observacoes: "Falar com a Bia.",
      por: `agente:${AGENTE}`,
      em: AGORA.toISOString(),
    });
  });

  it("⭐ valor fora do formato não aparece e não derruba a leitura", () => {
    // `segmento` e `documento_cnpj` podem ser campos próprios da organização,
    // com outro tipo. O resto do diagnóstico continua legível.
    const lido = lerDiagnostico({
      segmento: ["varejo", "atacado"],
      documento_cnpj: "11.222.333/0001-00",
      diag_resumo: 42,
      diag_oferta: "   ",
      diag_observacoes: "Ok.",
      diag_por: "robô",
      diag_em: "ontem",
    });
    expect(lido).toEqual({ observacoes: "Ok." });
  });

  it("aceita custom_fields ausente", () => {
    expect(lerDiagnostico(null)).toEqual({});
    expect(diagnosticoVazio(lerDiagnostico(undefined))).toBe(true);
  });

  it("CNPJ com máscara e o alfanumérico são aceitos; guardado sem máscara", () => {
    expect(lerDiagnostico({ documento_cnpj: "11.222.333/0001-81" }).cnpj).toBe(CNPJ);
    expect(lerDiagnostico({ documento_cnpj: "12.ABC.345/01DE-35" }).cnpj).toBe("12ABC34501DE35");
    expect(textosDoDiagnostico({ cnpj: CNPJ }).cnpj).toBe("11.222.333/0001-81");
  });

  it("cnpjInvalido: vazio não é erro, DV errado é", () => {
    expect(cnpjInvalido("")).toBe(false);
    expect(cnpjInvalido("11.222.333/0001-81")).toBe(false);
    expect(cnpjInvalido("11.222.333/0001-00")).toBe(true);
    expect(cnpjInvalido("CNPJ: 11.222.333/0001-81")).toBe(true);
  });
});

describe("o selo Escrito pela IA", () => {
  it("⭐ só quando diag_por é de um agente", () => {
    expect(escritoPelaIA(lerDiagnostico({ diag_por: autoriaDoAgente(AGENTE) }))).toBe(true);
    expect(escritoPelaIA(lerDiagnostico({ diag_por: autoriaDoUsuario(USUARIO) }))).toBe(false);
    expect(escritoPelaIA(lerDiagnostico({}))).toBe(false);
    // "agente" sem id válido não é autoria: sem selo.
    expect(escritoPelaIA(lerDiagnostico({ diag_por: "agente:qualquer" }))).toBe(false);
  });
});

describe("aplicarDiagnostico — o objeto completo que o PATCH vai trocar", () => {
  it("⭐ preserva os link_* e os campos da organização", () => {
    const antes = {
      link_instagram: "instagram.com/loja",
      link_bio: "paginadelinks.exemplo.com/loja",
      convenio: "Unimed",
      numero_de_filiais: 3,
    };
    const novo = aplicarDiagnostico(
      antes,
      VAZIO,
      { ...VAZIO, segmento: "Padaria", resumo: "Sem cardápio online." },
      autoriaDoUsuario(USUARIO),
      AGORA,
    );
    expect(novo).toEqual({
      ...antes,
      segmento: "Padaria",
      diag_resumo: "Sem cardápio online.",
      diag_por: `usuario:${USUARIO}`,
      diag_em: AGORA.toISOString(),
    });
  });

  it("⭐ só a chave que MUDOU é tocada — o campo homônimo ilegível da organização fica", () => {
    const antes = { segmento: ["varejo"], diag_observacoes: "antiga" };
    const inicial = textosDoDiagnostico(lerDiagnostico(antes));
    expect(inicial.segmento).toBe("");
    const novo = aplicarDiagnostico(
      antes,
      inicial,
      { ...inicial, observacoes: "nova" },
      autoriaDoUsuario(USUARIO),
      AGORA,
    );
    expect(novo).toEqual({ segmento: ["varejo"], diag_observacoes: "nova" });
  });

  it("vazio apaga a chave; sem diagnóstico nem oferta, autoria e data saem junto", () => {
    const antes = {
      diag_resumo: "x",
      diag_por: autoriaDoAgente(AGENTE),
      diag_em: AGORA.toISOString(),
      link_site: "exemplo.com.br",
    };
    const inicial = textosDoDiagnostico(lerDiagnostico(antes));
    const novo = aplicarDiagnostico(antes, inicial, { ...inicial, resumo: "  " }, autoriaDoUsuario(USUARIO));
    expect(novo).toEqual({ link_site: "exemplo.com.br" });
  });

  it("editar o texto da IA tira o selo; anotar só a observação não tira", () => {
    const antes = { diag_resumo: "da IA", diag_por: autoriaDoAgente(AGENTE), diag_em: "2026-11-01T10:00:00.000Z" };
    const inicial = textosDoDiagnostico(lerDiagnostico(antes));

    const soObservacao = aplicarDiagnostico(antes, inicial, { ...inicial, observacoes: "ligar terça" }, autoriaDoUsuario(USUARIO), AGORA);
    expect(soObservacao.diag_por).toBe(`agente:${AGENTE}`);
    expect(soObservacao.diag_em).toBe("2026-11-01T10:00:00.000Z");

    const editado = aplicarDiagnostico(antes, inicial, { ...inicial, resumo: "revisado" }, autoriaDoUsuario(USUARIO), AGORA);
    expect(editado.diag_por).toBe(`usuario:${USUARIO}`);
    expect(escritoPelaIA(lerDiagnostico(editado))).toBe(false);
  });

  it("CNPJ válido é guardado sem máscara; inválido não é gravado", () => {
    const valido = aplicarDiagnostico({}, VAZIO, { ...VAZIO, cnpj: "11.222.333/0001-81" }, autoriaDoUsuario(USUARIO));
    expect(valido).toEqual({ documento_cnpj: CNPJ });
    const invalido = aplicarDiagnostico(
      { documento_cnpj: CNPJ },
      textosDoDiagnostico({ cnpj: CNPJ }),
      { ...VAZIO, cnpj: "11.222.333/0001-00" },
      autoriaDoUsuario(USUARIO),
    );
    expect(invalido).toEqual({ documento_cnpj: CNPJ });
  });

  it("nada mudou: devolve o mesmo conteúdo", () => {
    const antes = { diag_resumo: "x", link_site: "exemplo.com.br" };
    const inicial = textosDoDiagnostico(lerDiagnostico(antes));
    expect(aplicarDiagnostico(antes, inicial, inicial, autoriaDoUsuario(USUARIO))).toEqual(antes);
  });
});

describe("segmentoDoContatoNovo — a categoria da prospecção vira segmento", () => {
  it("copia a categoria, sem espaços nas pontas", () => {
    expect(segmentoDoContatoNovo(" Dentista ")).toEqual({ segmento: "Dentista" });
  });

  it("sem categoria, nada", () => {
    expect(segmentoDoContatoNovo(null)).toEqual({});
    expect(segmentoDoContatoNovo("   ")).toEqual({});
  });

  it("categoria longa é cortada no teto, não descartada", () => {
    expect(segmentoDoContatoNovo("a".repeat(500)).segmento).toHaveLength(120);
  });
});

describe("segmentoDoContatoNovo — o campo próprio da organização manda", () => {
  it("⭐ a organização tem campo de contato `segmento`: a categoria do Maps não entra", () => {
    expect(segmentoDoContatoNovo("Dentista", ["convenio", "segmento"])).toEqual({});
  });

  it("campos de outros nomes não mudam nada", () => {
    expect(segmentoDoContatoNovo("Dentista", ["convenio", "segmento_antigo"])).toEqual({
      segmento: "Dentista",
    });
  });
});

describe("podeEditarDiagnostico — quem edita a aba", () => {
  const vivo = { is_anonymized: false };
  const comum = { support: null };

  it("⭐ atendente e acima editam", () => {
    expect(podeEditarDiagnostico(vivo, comum, "agent")).toBe(true);
    expect(podeEditarDiagnostico(vivo, comum, "manager")).toBe(true);
    expect(podeEditarDiagnostico(vivo, comum, "admin")).toBe(true);
  });

  it("⭐ quem só lê (viewer), sem papel ou com papel desconhecido, não edita", () => {
    expect(podeEditarDiagnostico(vivo, comum, "viewer")).toBe(false);
    expect(podeEditarDiagnostico(vivo, comum, undefined)).toBe(false);
    expect(podeEditarDiagnostico(vivo, comum, "dono")).toBe(false);
  });

  it("⭐ contato anonimizado não é editável, nem por quem administra", () => {
    expect(podeEditarDiagnostico({ is_anonymized: true }, comum, "admin")).toBe(false);
  });

  it("⭐ suporte só-leitura não edita, mesmo com papel de administrador", () => {
    expect(
      podeEditarDiagnostico(vivo, { support: { access_mode: "support_readonly" } }, "admin"),
    ).toBe(false);
  });
});

describe("gravacaoDaAba — a diferença aplicada sobre a ficha RELIDA", () => {
  const inicial = { ...VAZIO };

  it("⭐ o que outro caminho gravou depois da leitura sobrevive", () => {
    // A aba abriu sem site e sem diagnóstico. Enquanto a pessoa escrevia, o
    // "Completar fichas" gravou link_site e a IA gravou o diagnóstico.
    const relido = {
      link_site: "exemplo.com.br",
      diag_resumo: "Texto da IA.",
      diag_por: autoriaDoAgente(AGENTE),
      convenio: "Unimed",
    };
    const novo = gravacaoDaAba(relido, {
      inicial,
      editado: { ...inicial, observacoes: "Ligar depois das 14h." },
      linksIniciais: {},
      linksEditados: {},
      autor: autoriaDoUsuario(USUARIO),
      agora: AGORA,
    });
    expect(novo).toEqual({ ...relido, diag_observacoes: "Ligar depois das 14h." });
  });

  it("⭐ editar um link não apaga o link_* ilegível que já estava lá", () => {
    const relido = { link_site: 42, convenio: "Unimed" };
    const novo = gravacaoDaAba(relido, {
      inicial,
      editado: inicial,
      linksIniciais: {},
      linksEditados: { bio: "paginadelinks.exemplo.com/loja" },
      autor: autoriaDoUsuario(USUARIO),
      agora: AGORA,
    });
    expect(novo).toEqual({ ...relido, link_bio: "paginadelinks.exemplo.com/loja" });
  });

  it("na mesma chave vale a gravação desta pessoa", () => {
    const novo = gravacaoDaAba(
      { diag_resumo: "Texto da IA.", diag_por: autoriaDoAgente(AGENTE) },
      {
        inicial,
        editado: { ...inicial, resumo: "Texto da equipe." },
        linksIniciais: {},
        linksEditados: {},
        autor: autoriaDoUsuario(USUARIO),
        agora: AGORA,
      },
    );
    expect(novo).toEqual({
      diag_resumo: "Texto da equipe.",
      diag_por: autoriaDoUsuario(USUARIO),
      diag_em: AGORA.toISOString(),
    });
  });
});

describe("diagnosticoDoContatoNovo — o que a equipe escreveu na planilha vira a aba", () => {
  const EM = "2026-11-12T12:00:00.000Z";
  const autor = autoriaDoUsuario(USUARIO);

  it("os três textos e a autoria de quem importou", () => {
    expect(
      diagnosticoDoContatoNovo({ resumo: "Sem site.", oferta: "Site.", observacoes: "Indicação.", autor, em: EM }),
    ).toEqual({
      [CHAVES_DO_DIAGNOSTICO.resumo]: "Sem site.",
      [CHAVES_DO_DIAGNOSTICO.oferta]: "Site.",
      [CHAVES_DO_DIAGNOSTICO.observacoes]: "Indicação.",
      [CHAVES_DO_DIAGNOSTICO.por]: autor,
      [CHAVES_DO_DIAGNOSTICO.em]: EM,
    });
  });

  it("só observação: entra SEM autoria (é recado, não diagnóstico)", () => {
    expect(diagnosticoDoContatoNovo({ observacoes: "Cliente antigo.", autor, em: EM })).toEqual({
      [CHAVES_DO_DIAGNOSTICO.observacoes]: "Cliente antigo.",
    });
  });

  it("autoria fora do formato ou data ilegível: os textos entram, a autoria não", () => {
    for (const [a, e] of [
      ["usuario:nao-e-uuid", EM],
      ["qualquer coisa", EM],
      [autor, "ontem"],
      [null, null],
    ] as const)
      expect(diagnosticoDoContatoNovo({ resumo: "Sem site.", autor: a, em: e })).toEqual({
        [CHAVES_DO_DIAGNOSTICO.resumo]: "Sem site.",
      });
  });

  it("chave que a organização tem como campo próprio fica de fora — e a autoria sem texto também", () => {
    expect(
      diagnosticoDoContatoNovo(
        { resumo: "Sem site.", observacoes: "Obs.", autor, em: EM },
        [CHAVES_DO_DIAGNOSTICO.resumo],
      ),
    ).toEqual({ [CHAVES_DO_DIAGNOSTICO.observacoes]: "Obs." });
  });

  it("sem equipe, ou só com espaços, nada", () => {
    expect(diagnosticoDoContatoNovo(null)).toEqual({});
    expect(diagnosticoDoContatoNovo({ resumo: "  ", autor, em: EM })).toEqual({});
  });
});

describe("gravacaoDoAgente — o PEDAÇO que a ferramenta do agente mescla no banco", () => {
  /** Ficha com diagnóstico de uma rodada ANTERIOR da IA: a IA pode refazer o próprio texto. */
  const atual = {
    link_instagram: "instagram.com/padaria",
    convenio: "Unimed",
    diag_observacoes: "Recado da equipe.",
    diag_resumo: "Texto antigo da IA.",
    diag_por: autoriaDoAgente(AGENTE_ANTERIOR),
    diag_em: "2026-11-01T10:00:00.000Z",
  };

  it("⭐ devolve só as chaves do diagnóstico, nunca o objeto inteiro", () => {
    const r = gravacaoDoAgente(
      atual,
      { segmento: " Padaria ", cnpj: "11.222.333/0001-81", resumo: "Sem cardápio.", oferta: "Cardápio digital." },
      autoriaDoAgente(AGENTE),
      [],
      AGORA,
    );
    expect(r).toEqual({
      ok: true,
      campos: {
        segmento: "Padaria",
        documento_cnpj: CNPJ,
        diag_resumo: "Sem cardápio.",
        diag_oferta: "Cardápio digital.",
        diag_por: autoriaDoAgente(AGENTE),
        diag_em: AGORA.toISOString(),
      },
      remover: [],
      gravados: ["segmento", "cnpj", "resumo", "oferta"],
      preservados: [],
      daEquipe: [],
      escritoPelaIA: true,
    });
    if (r.ok) {
      // Aplicado como a função do banco aplica, o resto sobrevive e o selo aparece.
      const depois = { ...atual, ...r.campos };
      expect(depois).toMatchObject({ link_instagram: "instagram.com/padaria", convenio: "Unimed" });
      expect(escritoPelaIA(lerDiagnostico(depois))).toBe(true);
    }
  });

  it("valor inválido recusa a chamada inteira, sem gravar pela metade", () => {
    expect(gravacaoDoAgente(atual, { resumo: "Ok.", cnpj: "123" }, autoriaDoAgente(AGENTE))).toEqual({
      ok: false,
      motivo: "valor_invalido",
      campo: "cnpj",
    });
    expect(gravacaoDoAgente(atual, { resumo: "   " }, autoriaDoAgente(AGENTE))).toMatchObject({
      ok: false,
      motivo: "valor_invalido",
      campo: "resumo",
    });
    expect(gravacaoDoAgente(atual, { oferta: "x".repeat(2001) }, autoriaDoAgente(AGENTE))).toMatchObject({
      ok: false,
      campo: "oferta",
    });
  });

  it("observações da equipe não são campo do agente", () => {
    const r = gravacaoDoAgente(
      atual,
      { observacoes: "IA no recado" } as unknown as Parameters<typeof gravacaoDoAgente>[1],
      autoriaDoAgente(AGENTE),
    );
    expect(r).toEqual({ ok: false, motivo: "nada_para_gravar" });
  });

  it("chave da organização (declarada ou com valor em outro formato) fica preservada", () => {
    const declarada = gravacaoDoAgente(atual, { segmento: "Padaria", resumo: "Ok." }, autoriaDoAgente(AGENTE), [
      "segmento",
    ]);
    expect(declarada).toMatchObject({ ok: true, gravados: ["resumo"], preservados: ["segmento"] });
    const outroFormato = gravacaoDoAgente(
      { ...atual, segmento: ["Varejo"] },
      { segmento: "Padaria" },
      autoriaDoAgente(AGENTE),
    );
    expect(outroFormato).toEqual({ ok: false, motivo: "campo_da_organizacao", preservados: ["segmento"] });
  });

  it("só segmento ou CNPJ não mexe na autoria", () => {
    const r = gravacaoDoAgente(atual, { segmento: "Padaria" }, autoriaDoAgente(AGENTE), [], AGORA);
    expect(r).toMatchObject({ ok: true, campos: { segmento: "Padaria" }, remover: [], escritoPelaIA: false });
  });

  it("sem autor reconhecível, a autoria antiga sai junto", () => {
    const r = gravacaoDoAgente(atual, { resumo: "Novo." }, null, [], AGORA);
    expect(r).toMatchObject({ ok: true, campos: { diag_resumo: "Novo." }, remover: ["diag_por", "diag_em"] });
    const torto = gravacaoDoAgente(atual, { resumo: "Novo." }, "agente:nao-e-uuid", [], AGORA);
    expect(torto).toMatchObject({ ok: true, remover: ["diag_por", "diag_em"], escritoPelaIA: false });
  });
});

describe("gravacaoDoAgente — o que uma PESSOA da equipe escreveu a IA não sobrescreve", () => {
  /** Diagnóstico assinado por uma pessoa: a equipe assumiu a ficha. */
  const daEquipe = {
    link_instagram: "instagram.com/padaria",
    segmento: "Panificação artesanal",
    diag_resumo: "Texto da equipe.",
    diag_por: autoriaDoUsuario(USUARIO),
    diag_em: "2026-11-01T00:00:00.000Z",
  };

  it("⭐ resumo e oferta assinados pela equipe ficam; nada é gravado e a resposta diz por quê", () => {
    const r = gravacaoDoAgente(daEquipe, { resumo: "Texto da IA.", oferta: "Oferta da IA." }, autoriaDoAgente(AGENTE));
    expect(r).toEqual({
      ok: false,
      motivo: "escrito_pela_equipe",
      preservados: ["resumo", "oferta"],
      daEquipe: ["resumo", "oferta"],
    });
  });

  it("a oferta vazia também fica: gravá-la trocaria a assinatura do resumo da equipe pelo selo da IA", () => {
    const r = gravacaoDoAgente(daEquipe, { oferta: "Oferta da IA." }, autoriaDoAgente(AGENTE));
    expect(r).toMatchObject({ ok: false, motivo: "escrito_pela_equipe", daEquipe: ["oferta"] });
  });

  it("segmento e CNPJ preenchidos ficam; os VAZIOS a IA completa, sem mexer na assinatura", () => {
    const r = gravacaoDoAgente(
      daEquipe,
      { segmento: "Padaria", cnpj: "11.222.333/0001-81", resumo: "Texto da IA." },
      autoriaDoAgente(AGENTE),
      [],
      AGORA,
    );
    expect(r).toEqual({
      ok: true,
      campos: { documento_cnpj: CNPJ },
      remover: [],
      gravados: ["cnpj"],
      preservados: ["segmento", "resumo"],
      daEquipe: ["segmento", "resumo"],
      escritoPelaIA: false,
    });
  });

  it("token de integração sem autor também não apaga o texto nem a assinatura da equipe", () => {
    const r = gravacaoDoAgente(daEquipe, { resumo: "Texto do integrador." }, null);
    expect(r).toMatchObject({ ok: false, motivo: "escrito_pela_equipe" });
  });

  it("uma PESSOA (por token) edita como na aba: grava e assina como ela", () => {
    const outra = autoriaDoUsuario("66666666-6666-4666-8666-666666666666");
    const r = gravacaoDoAgente(daEquipe, { resumo: "Revisado." }, outra, [], AGORA);
    expect(r).toMatchObject({
      ok: true,
      campos: { diag_resumo: "Revisado.", diag_por: outra },
      daEquipe: [],
      escritoPelaIA: false,
    });
  });
});
