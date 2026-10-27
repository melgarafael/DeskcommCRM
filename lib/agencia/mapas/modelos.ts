/**
 * Mapas prontos para começar (plano de 27/10, item 5): as três etapas do cliente
 * recorrente (docs/agencia/mapa-de-capacidades.md › Regras do negócio) e os
 * serviços avulsos. A pessoa abre o modelo e ajusta — nada aqui é definitivo.
 * Puro: as posições saem de um layout por profundidade, de cima para baixo — as
 * alças do bloco ficam em cima (chega) e embaixo (sai), como no Fluxo.
 */
import { especieDe } from "./blocos";

interface BlocoDoModelo {
  chave: string;
  especie: string;
  titulo?: string;
}

export interface ModeloDeMapa {
  id: string;
  nome: string;
  grupo: "Recorrente" | "Avulsos";
  descricao: string;
  blocos: BlocoDoModelo[];
  setas: Array<[string, string]>;
}

export const MODELOS_DE_MAPA: readonly ModeloDeMapa[] = [
  {
    id: "recorrente_etapa_1",
    nome: "Recorrente — Etapa 1 (reuniões até a Ativação)",
    grupo: "Recorrente",
    descricao: "Apresentação → proposta → Fechamento → contrato assinado e pago → grupo e formulário → Ativação.",
    blocos: [
      { chave: "apr", especie: "apresentacao" },
      { chave: "prop", especie: "proposta" },
      { chave: "fech", especie: "fechamento" },
      { chave: "ctr", especie: "contrato" },
      { chave: "ass", especie: "assinatura" },
      { chave: "grp", especie: "grupo" },
      { chave: "form", especie: "formulario" },
      { chave: "atv", especie: "ativacao" },
      { chave: "nota", especie: "nota", titulo: "Recusou ou a proposta expirou? Use o bloco “Proposta expirada / recusa”." },
    ],
    setas: [
      ["apr", "prop"],
      ["prop", "fech"],
      ["fech", "ctr"],
      ["ctr", "ass"],
      ["ass", "grp"],
      ["ass", "form"],
      ["grp", "atv"],
      ["form", "atv"],
    ],
  },
  {
    id: "recorrente_etapa_2",
    nome: "Recorrente — Etapa 2 (mês de preparação)",
    grupo: "Recorrente",
    descricao: "Vídeos e fotos, identidade e artes, redes e árvore de links, campanhas.",
    blocos: [
      { chave: "rot", especie: "roteiro" },
      { chave: "apr_rot", especie: "aprovacao", titulo: "Roteiros para o cliente aprovar" },
      { chave: "sto", especie: "storyboard" },
      { chave: "grav", especie: "gravacao" },
      { chave: "sub", especie: "subir_material" },
      { chave: "edi", especie: "edicao" },
      { chave: "fot", especie: "fotos" },
      { chave: "idv", especie: "identidade" },
      { chave: "art", especie: "arte" },
      { chave: "per", especie: "perfis" },
      { chave: "arv", especie: "arvore" },
      { chave: "crm", especie: "acesso_crm" },
      { chave: "apr_vid", especie: "aprovacao", titulo: "Vídeos e artes para o cliente aprovar" },
      { chave: "cam", especie: "campanha" },
    ],
    setas: [
      ["rot", "apr_rot"],
      ["apr_rot", "sto"],
      ["sto", "grav"],
      ["grav", "sub"],
      ["sub", "edi"],
      ["sub", "fot"],
      ["sub", "per"],
      ["idv", "art"],
      ["idv", "per"],
      ["per", "arv"],
      ["edi", "apr_vid"],
      ["fot", "apr_vid"],
      ["art", "apr_vid"],
      ["apr_vid", "cam"],
    ],
  },
  {
    id: "recorrente_etapa_3",
    nome: "Recorrente — Etapa 3 (ciclo do mês)",
    grupo: "Recorrente",
    descricao: "Grava no mês N o que vai ao ar no N + 1: pautas → roteiros → gravação → edição → aprovação → dia 1 → publicação → relatório.",
    blocos: [
      { chave: "pau", especie: "pautas_ia" },
      { chave: "rot", especie: "roteiro" },
      { chave: "apr_rot", especie: "aprovacao", titulo: "Roteiros do mês para aprovar" },
      { chave: "grav", especie: "gravacao" },
      { chave: "sub", especie: "subir_material" },
      { chave: "edi", especie: "edicao" },
      { chave: "leg", especie: "legenda_ia" },
      { chave: "apr_vid", especie: "aprovacao", titulo: "Vídeos do mês para aprovar" },
      { chave: "esp", especie: "espera", titulo: "Esperar o dia 1 do mês de postagem" },
      { chave: "pub", especie: "publicacao", titulo: "Publicações do mês" },
      { chave: "cam", especie: "campanha", titulo: "Campanhas do mês" },
      { chave: "rel", especie: "relatorio" },
    ],
    setas: [
      ["pau", "rot"],
      ["rot", "apr_rot"],
      ["apr_rot", "grav"],
      ["grav", "sub"],
      ["sub", "edi"],
      ["edi", "leg"],
      ["leg", "apr_vid"],
      ["apr_vid", "esp"],
      ["esp", "pub"],
      ["esp", "cam"],
      ["pub", "rel"],
      ["cam", "rel"],
    ],
  },
  {
    id: "avulso_gravacao",
    nome: "Avulso — Gravação",
    grupo: "Avulsos",
    descricao: "Roteiro → gravação → subir → edição → aprovação.",
    blocos: [
      { chave: "rot", especie: "roteiro" },
      { chave: "grav", especie: "gravacao" },
      { chave: "sub", especie: "subir_material" },
      { chave: "edi", especie: "edicao" },
      { chave: "apr", especie: "aprovacao" },
    ],
    setas: [
      ["rot", "grav"],
      ["grav", "sub"],
      ["sub", "edi"],
      ["edi", "apr"],
    ],
  },
  {
    id: "avulso_trafego",
    nome: "Avulso — Tráfego",
    grupo: "Avulsos",
    descricao: "Campanha → aprovação → relatório.",
    blocos: [
      { chave: "cam", especie: "campanha" },
      { chave: "apr", especie: "aprovacao", titulo: "Campanha para o cliente aprovar" },
      { chave: "rel", especie: "relatorio" },
    ],
    setas: [
      ["cam", "apr"],
      ["apr", "rel"],
    ],
  },
  {
    id: "avulso_site",
    nome: "Avulso — Site",
    grupo: "Avulsos",
    descricao: "Site (briefing → layout → no ar) → aprovação → aviso de entrega.",
    blocos: [
      { chave: "site", especie: "site" },
      { chave: "apr", especie: "aprovacao", titulo: "Layout para o cliente aprovar" },
      { chave: "av", especie: "aviso", titulo: "Site no ar" },
    ],
    setas: [
      ["site", "apr"],
      ["apr", "av"],
    ],
  },
  {
    id: "avulso_automacao",
    nome: "Avulso — Automação",
    grupo: "Avulsos",
    descricao: "Automação → aviso de entrega.",
    blocos: [
      { chave: "aut", especie: "automacao" },
      { chave: "av", especie: "aviso", titulo: "Automação pronta" },
    ],
    setas: [["aut", "av"]],
  },
  {
    id: "avulso_artes",
    nome: "Avulso — Artes / design",
    grupo: "Avulsos",
    descricao: "Identidade → artes → aprovação.",
    blocos: [
      { chave: "idv", especie: "identidade" },
      { chave: "art", especie: "arte" },
      { chave: "apr", especie: "aprovacao", titulo: "Artes para o cliente aprovar" },
    ],
    setas: [
      ["idv", "art"],
      ["art", "apr"],
    ],
  },
  {
    id: "avulso_assessoria",
    nome: "Avulso — Assessoria",
    grupo: "Avulsos",
    descricao: "Assessoria → relatório.",
    blocos: [
      { chave: "ass", especie: "assessoria" },
      { chave: "rel", especie: "relatorio" },
    ],
    setas: [["ass", "rel"]],
  },
];

export const LARGURA_DO_PASSO = 300;
export const ALTURA_DO_PASSO = 140;

/** A profundidade de cada bloco (o caminho mais longo até ele): a linha do layout. */
export function profundidades(chaves: readonly string[], setas: ReadonlyArray<[string, string]>): Map<string, number> {
  const prof = new Map(chaves.map((c) => [c, 0]));
  for (let volta = 0; volta < chaves.length; volta++) {
    let mudou = false;
    for (const [de, para] of setas) {
      const d = (prof.get(de) ?? 0) + 1;
      if (d > (prof.get(para) ?? 0)) {
        prof.set(para, d);
        mudou = true;
      }
    }
    if (!mudou) break;
  }
  return prof;
}

/** As linhas prontas para gravar (sem `mapa_id`) e as setas por chave. */
export function blocosDoModelo(id: string) {
  const m = MODELOS_DE_MAPA.find((x) => x.id === id);
  if (!m) return { blocos: [], setas: [] as Array<[string, string]> };
  const prof = profundidades(
    m.blocos.map((b) => b.chave),
    m.setas,
  );
  const naLinha = new Map<number, number>();
  const blocos = m.blocos.map((b) => {
    const e = especieDe(b.especie);
    const nivel = e.tipo === "nota" ? 0 : (prof.get(b.chave) ?? 0);
    const lado = e.tipo === "nota" ? 0 : (naLinha.get(nivel) ?? 0);
    if (e.tipo !== "nota") naLinha.set(nivel, lado + 1);
    return {
      chave: b.chave,
      linha: {
        especie: b.especie,
        tipo: e.tipo,
        titulo: b.titulo ?? (e.titulo || e.rotulo),
        cor: e.cor,
        // A nota fica à esquerda do começo, fora do caminho.
        x: e.tipo === "nota" ? -LARGURA_DO_PASSO : lado * LARGURA_DO_PASSO,
        y: nivel * ALTURA_DO_PASSO,
        checklist: e.checklist ?? [],
        executor: e.executor ?? "humano",
        acao_ia: e.executor === "ia" ? (e.acaoIa ?? null) : null,
      },
    };
  });
  return { blocos, setas: m.setas };
}
