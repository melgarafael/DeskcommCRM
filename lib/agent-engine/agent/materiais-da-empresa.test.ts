import { describe, expect, it, vi } from "vitest";

import { corpoDoEnvio } from "../edge/crm/send-message";
import {
  descreverMateriais,
  historicoDoMaterial,
  listarMateriaisDoAgente,
  prepararMaterialDaEmpresa,
} from "./materiais-da-empresa";
import {
  materialCompativelComCanal,
  materialPertenceAOrganizacao,
  nomeDoMaterialNaConversa,
  tipoDeMaterial,
  TAMANHO_MAXIMO_DO_MATERIAL,
} from "@/lib/materiais/materiais";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const OUTRA_ORG = "aaaaaaaa-0000-4000-8000-000000000002";
const AGENTE = "dddddddd-0000-4000-8000-000000000001";
const CONVERSA = "cccccccc-0000-4000-8000-000000000001";
const MATERIAL = "eeeeeeee-0000-4000-8000-000000000001";
const CAMINHO = `${ORG}/11111111-2222-4333-8444-555555555555.pdf`;

interface LinhaDoBanco {
  id: string;
  nome: string;
  legenda: string | null;
  mime: string;
  storage_path: string;
  tamanho: string | number;
  ativo: boolean;
  quando_enviar?: string | null;
}

/**
 * Banco de mentira com as duas consultas do preparo, roteadas pelo SQL.
 *
 * A separação não é conveniência: a query de HISTÓRICO é o freio, e um teste que
 * a devolvesse junto com a do material provaria o caminho feliz sem provar
 * nenhum dos quatro casos de reenvio.
 */
function banco(
  material: LinhaDoBanco | null,
  historico: { nas_ultimas_24h: number | string; ultimo: Date | string | null } = {
    nas_ultimas_24h: 0,
    ultimo: null,
  },
) {
  const query = vi.fn(async (sql: string, _valores: unknown[]) => {
    if (sql.includes("from messages")) return { rows: [historico] };
    if (sql.includes("from crm_materiais m")) return { rows: material ? [material] : [] };
    return { rows: [] };
  });
  return { db: { query } as never, query };
}

const MATERIAL_PRONTO: LinhaDoBanco = {
  id: MATERIAL,
  nome: "Catálogo 2026",
  legenda: "Segue o catálogo completo.",
  mime: "application/pdf",
  storage_path: CAMINHO,
  tamanho: 2_000_000,
  ativo: true,
};

function preparar(
  material: LinhaDoBanco | null,
  opcoes: {
    historico?: { nas_ultimas_24h: number | string; ultimo: Date | string | null };
    copiar?: () => Promise<boolean>;
    canal?: string | null;
    clientePediu?: boolean;
  } = {},
) {
  const { db } = banco(material, opcoes.historico);
  const copiar = vi.fn(opcoes.copiar ?? (async () => true));
  const resultado = prepararMaterialDaEmpresa(db, copiar, {
    tenantId: ORG,
    agentId: AGENTE,
    conversationId: CONVERSA,
    materialId: MATERIAL,
    canal: opcoes.canal ?? "whatsapp",
    clientePediu: opcoes.clientePediu,
  });
  return { resultado, copiar };
}

describe("tipoDeMaterial — PDF e imagem passam, o resto é recusado", () => {
  it("PDF sai como DOCUMENTO", () => {
    expect(tipoDeMaterial("m.pdf", "application/pdf")).toEqual({
      ok: true,
      type: "document",
      mime: "application/pdf",
    });
  });

  it("imagem sai como IMAGEM", () => {
    expect(tipoDeMaterial("m.png", "image/png")).toMatchObject({ ok: true, type: "image" });
  });

  it("extensão decide quando o MIME não veio", () => {
    expect(tipoDeMaterial("m.pdf", null)).toMatchObject({ ok: true, type: "document" });
  });

  it("`octet-stream` NÃO é tipo: a extensão decide, e sem extensão recusa", () => {
    expect(tipoDeMaterial("m.pdf", "application/octet-stream")).toMatchObject({
      ok: true,
      type: "document",
    });
    const recusado = tipoDeMaterial("arquivo", "application/octet-stream");
    expect(recusado.ok).toBe(false);
  });

  it(".webm é RECUSADO — a mesma extensão serve a áudio e a vídeo", () => {
    const r = tipoDeMaterial("m.webm", null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain("não tem tipo identificável");
  });

  it("vídeo e áudio declarados não são material de empresa", () => {
    expect(tipoDeMaterial("m.mp4", "video/mp4")).toMatchObject({ ok: false });
    expect(tipoDeMaterial("m.ogg", "audio/ogg")).toMatchObject({ ok: false });
  });

  it("planilha e apresentação passam como documento", () => {
    expect(
      tipoDeMaterial(
        "m.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    ).toMatchObject({ ok: true, type: "document" });
  });
});

describe("materialCompativelComCanal — Instagram só leva PDF e imagem", () => {
  it("WhatsApp aceita tudo o que a régua aprovou", () => {
    expect(materialCompativelComCanal("document", "application/vnd.ms-excel", "whatsapp")).toBe(true);
  });

  it("Instagram aceita PDF e imagem, e recusa planilha", () => {
    expect(materialCompativelComCanal("document", "application/pdf", "instagram")).toBe(true);
    expect(materialCompativelComCanal("image", "image/png", "instagram")).toBe(true);
    expect(materialCompativelComCanal("document", "application/vnd.ms-excel", "instagram")).toBe(false);
  });

  it("sem canal declarado, vale a régua do WhatsApp", () => {
    expect(materialCompativelComCanal("document", "application/vnd.ms-excel", null)).toBe(true);
  });
});

describe("materialPertenceAOrganizacao — o caminho é desta organização", () => {
  it("aceita a forma que a rota de upload gera", () => {
    expect(materialPertenceAOrganizacao(CAMINHO, ORG)).toBe(true);
  });

  it("recusa arquivo de OUTRA organização", () => {
    expect(materialPertenceAOrganizacao(CAMINHO, OUTRA_ORG)).toBe(false);
  });

  it("recusa nome fora da forma <uuid>.<ext> (traversal, pasta, vazio)", () => {
    expect(materialPertenceAOrganizacao(`${ORG}/../outra/x.pdf`, ORG)).toBe(false);
    expect(materialPertenceAOrganizacao(`${ORG}/pasta/x.pdf`, ORG)).toBe(false);
    expect(materialPertenceAOrganizacao(`${ORG}/`, ORG)).toBe(false);
  });
});

describe("nomeDoMaterialNaConversa — o nome é determinístico", () => {
  it("prefixa com `material-` e mantém o arquivo", () => {
    expect(nomeDoMaterialNaConversa(CAMINHO)).toBe(
      "material-11111111-2222-4333-8444-555555555555.pdf",
    );
  });
});

describe("listarMateriaisDoAgente — só ativo, permitido e compatível com o canal", () => {
  const linhas = [
    { ...MATERIAL_PRONTO, quando_enviar: "quando pedirem o catálogo" },
    {
      ...MATERIAL_PRONTO,
      id: "eeeeeeee-0000-4000-8000-000000000002",
      nome: "Inativo",
      ativo: false,
    },
    {
      ...MATERIAL_PRONTO,
      id: "eeeeeeee-0000-4000-8000-000000000003",
      nome: "De outra org",
      storage_path: `${OUTRA_ORG}/99999999-2222-4333-8444-555555555555.pdf`,
    },
    {
      ...MATERIAL_PRONTO,
      id: "eeeeeeee-0000-4000-8000-000000000004",
      nome: "Vídeo",
      storage_path: `${ORG}/99999999-2222-4333-8444-555555555555.mp4`,
      mime: "video/mp4",
    },
  ];

  function dbCom(rows: unknown[]) {
    return { query: vi.fn(async () => ({ rows })) } as never;
  }

  it("lista só o que passou por todos os filtros", async () => {
    const lista = await listarMateriaisDoAgente(dbCom(linhas), {
      tenantId: ORG,
      agentId: AGENTE,
      canal: "whatsapp",
    });
    expect(lista.map((m) => m.nome)).toEqual(["Catálogo 2026"]);
    expect(lista[0]).toMatchObject({ quandoEnviar: "quando pedirem o catálogo", type: "document" });
  });

  it("no Instagram a planilha não é oferecida, o PDF é", async () => {
    const lista = await listarMateriaisDoAgente(
      dbCom([
        { ...MATERIAL_PRONTO, quando_enviar: "" },
        {
          ...MATERIAL_PRONTO,
          id: "eeeeeeee-0000-4000-8000-000000000005",
          nome: "Planilha",
          storage_path: `${ORG}/99999999-2222-4333-8444-555555555555.xlsx`,
          mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      ]),
      { tenantId: ORG, agentId: AGENTE, canal: "instagram" },
    );
    expect(lista.map((m) => m.nome)).toEqual(["Catálogo 2026"]);
  });
});

describe("descreverMateriais — é o único lugar onde o modelo aprende", () => {
  it("lista vazia diz para NÃO usar material_id", () => {
    expect(descreverMateriais([])).toContain("NENHUM");
    expect(descreverMateriais([])).toContain("Não use `material_id`");
  });

  it("com material, mostra id, nome e o quando enviar", () => {
    const texto = descreverMateriais([
      { id: MATERIAL, nome: "Catálogo 2026", quandoEnviar: "quando pedirem preço", mime: "application/pdf", type: "document" },
    ]);
    expect(texto).toContain(MATERIAL);
    expect(texto).toContain("Catálogo 2026");
    expect(texto).toContain("quando pedirem preço");
    expect(texto).toContain("DOCUMENTO");
  });

  it("uma frase longa não vira parágrafo no prompt", () => {
    const texto = descreverMateriais([
      { id: MATERIAL, nome: "x".repeat(300), quandoEnviar: "y".repeat(300), mime: "application/pdf", type: "document" },
    ]);
    expect(texto.split("\n").filter((l) => l.startsWith("- "))[0]!.length).toBeLessThan(300);
  });
});

describe("prepararMaterialDaEmpresa — o caminho feliz", () => {
  it("copia para a pasta da conversa e devolve o anexo pronto", async () => {
    const { resultado, copiar } = preparar(MATERIAL_PRONTO);
    const r = await resultado;
    expect(r).toEqual({
      ok: true,
      anexo: {
        storagePath: `${ORG}/${CONVERSA}/material-11111111-2222-4333-8444-555555555555.pdf`,
        mime: "application/pdf",
        type: "document",
      },
      material: { id: MATERIAL, nome: "Catálogo 2026" },
      legenda: "Segue o catálogo completo.",
    });
    expect(copiar).toHaveBeenCalledWith(
      CAMINHO,
      `${ORG}/${CONVERSA}/material-11111111-2222-4333-8444-555555555555.pdf`,
    );
  });

  it("a cópia é service role na origem certa e o destino é o MESMO no replay", async () => {
    const primeiro = await preparar(MATERIAL_PRONTO).resultado;
    const segundo = await preparar(MATERIAL_PRONTO).resultado;
    expect(primeiro).toEqual(segundo);
  });
});

describe("prepararMaterialDaEmpresa — os freios", () => {
  it("material inexistente, inativo ou de outro agente → ENSINO, sem cópia", async () => {
    const { resultado, copiar } = preparar(null);
    expect(await resultado).toMatchObject({ ok: false, code: "material_nao_encontrado" });
    expect(copiar).not.toHaveBeenCalled();
  });

  it("caminho de OUTRA organização → recusa antes de copiar", async () => {
    const { resultado, copiar } = preparar({
      ...MATERIAL_PRONTO,
      storage_path: `${OUTRA_ORG}/99999999-2222-4333-8444-555555555555.pdf`,
    });
    expect(await resultado).toMatchObject({ ok: false, code: "material_fora_da_organizacao" });
    expect(copiar).not.toHaveBeenCalled();
  });

  it("tipo recusado → ENSINO, sem cópia", async () => {
    const { resultado, copiar } = preparar({
      ...MATERIAL_PRONTO,
      storage_path: `${ORG}/99999999-2222-4333-8444-555555555555.webm`,
      mime: "video/webm",
    });
    expect(await resultado).toMatchObject({ ok: false, code: "material_tipo_recusado" });
    expect(copiar).not.toHaveBeenCalled();
  });

  it("arquivo acima do teto de mídia → recusa", async () => {
    const { resultado } = preparar({ ...MATERIAL_PRONTO, tamanho: TAMANHO_MAXIMO_DO_MATERIAL + 1 });
    expect(await resultado).toMatchObject({ ok: false, code: "material_grande_demais" });
  });

  it("arquivo vazio/sem tamanho → recusa", async () => {
    expect(await preparar({ ...MATERIAL_PRONTO, tamanho: 0 }).resultado).toMatchObject({
      ok: false,
      code: "material_tamanho_invalido",
    });
  });

  it("canal Instagram + planilha → ENSINO do canal", async () => {
    const { resultado } = preparar(
      {
        ...MATERIAL_PRONTO,
        storage_path: `${ORG}/99999999-2222-4333-8444-555555555555.xlsx`,
        mime: "application/vnd.ms-excel",
      },
      { canal: "instagram" },
    );
    const r = await resultado;
    expect(r).toMatchObject({ ok: false, code: "material_incompativel_com_canal" });
    if (!r.ok) expect(r.message).toContain("só entrega PDF e imagem");
  });

  it("já enviado nos últimos 7 dias e o cliente NÃO pediu → 'já enviado', sem cópia", async () => {
    const { resultado, copiar } = preparar(MATERIAL_PRONTO, {
      historico: { nas_ultimas_24h: 1, ultimo: new Date() },
    });
    const r = await resultado;
    expect(r).toMatchObject({ ok: false, code: "material_ja_enviado" });
    if (!r.ok) expect(r.message).toContain("cliente_pediu: true");
    expect(copiar).not.toHaveBeenCalled();
  });

  it("cliente PEDIU e já saiu antes → reenvia", async () => {
    const { resultado, copiar } = preparar(MATERIAL_PRONTO, {
      historico: { nas_ultimas_24h: 1, ultimo: new Date() },
      clientePediu: true,
    });
    expect(await resultado).toMatchObject({ ok: true });
    expect(copiar).toHaveBeenCalledTimes(1);
  });

  it("3 envios em 24 h → teto, mesmo com o cliente pedindo", async () => {
    const { resultado, copiar } = preparar(MATERIAL_PRONTO, {
      historico: { nas_ultimas_24h: 3, ultimo: new Date() },
      clientePediu: true,
    });
    const r = await resultado;
    expect(r).toMatchObject({ ok: false, code: "material_limite_do_dia" });
    if (!r.ok) expect(r.message).toContain("NÃO envie de novo");
    expect(copiar).not.toHaveBeenCalled();
  });

  it("cópia que falha NÃO degrada para texto: o material não é enviado", async () => {
    const { resultado } = preparar(MATERIAL_PRONTO, { copiar: async () => false });
    expect(await resultado).toMatchObject({ ok: false, code: "material_nao_copiado" });
  });
});

describe("historicoDoMaterial — consulta na organização e na conversa certas", () => {
  it("conta só outbound com o mesmo material_id no metadata", async () => {
    const { db, query } = banco(null, { nas_ultimas_24h: "2", ultimo: "2026-11-06T12:00:00.000Z" });
    const r = await historicoDoMaterial(db, {
      tenantId: ORG,
      conversationId: CONVERSA,
      materialId: MATERIAL,
    });
    expect(r).toEqual({ nasUltimas24h: 2, ultimo: new Date("2026-11-06T12:00:00.000Z") });
    const [sql, valores] = query.mock.calls[0]!;
    expect(sql).toContain("metadata->>'material_id'");
    expect(sql).toContain("direction = 'outbound'");
    expect(valores).toEqual([ORG, CONVERSA, MATERIAL]);
  });
});

describe("corpoDoEnvio — o material chega ao handler como DOCUMENTO", () => {
  const base = {
    tenantId: ORG,
    leadId: "lead",
    jobId: "job",
    seq: 1,
    conversationId: CONVERSA,
  };

  it("type document, caminho, mime e o material_id no metadata", () => {
    expect(
      corpoDoEnvio(
        {
          ...base,
          body: "Segue o catálogo",
          media: { storagePath: "m.pdf", mime: "application/pdf", type: "document" },
          materialId: MATERIAL,
        },
        "k",
      ),
    ).toEqual({
      conversation_id: CONVERSA,
      type: "document",
      media_storage_path: "m.pdf",
      media_mime: "application/pdf",
      body: "Segue o catálogo",
      metadata: { idempotency_key: "k", material_id: MATERIAL },
    });
  });

  it("sem legenda, o documento vai SEM body", () => {
    const corpo = corpoDoEnvio(
      { ...base, body: "", media: { storagePath: "m.pdf", mime: "application/pdf", type: "document" } },
      "k",
    );
    expect("body" in corpo).toBe(false);
  });

  it("foto de produto não declara material_id no metadata", () => {
    const corpo = corpoDoEnvio(
      { ...base, body: "foto", media: { storagePath: "p.jpg", mime: "image/jpeg" } },
      "k",
    );
    expect(corpo.metadata).toEqual({ idempotency_key: "k" });
  });
});
