/**
 * O veredito EFETIVO de um candidato — o que a LEITURA deve mostrar (tela,
 * prévia, contador). Morada única: ninguém deriva "sem site" de segunda mão.
 *
 * `data.site` é o veredito GRAVADO. Quando ele não existe e a empresa não tem
 * `website`, o veredito é determinístico e não depende de rede: `sem-site`
 * (`vereditoPuro`). Sem esta derivação, as linhas sem `website` ficavam em
 * "A verificar" para sempre — medido na VPS em 15/10/2026: 113 candidatas, porque
 * o `select` do enriquecimento exige `website` não-nulo e elas nunca chegavam à
 * fase pura.
 *
 * Nada aqui grava no banco: quem persiste o veredito puro é a cura em lote do
 * botão "Verificar sites" (`site-enrich.ts`).
 *
 * Client-safe (sem `node:*`): a tela importa daqui, e `site-fetch.ts`
 * (server-only) reexporta os limites para não duplicar a régua.
 */
import {
  ehSemSite,
  problemasMedidos,
  vereditoPuro,
  type ItemDoRaioX,
  type RaioXDoSite,
  type SiteEnrichment,
} from "@/lib/prospecting/site-classify";

/** O mínimo que a leitura precisa de um candidato (não amarra a `Prospect`). */
export interface DadosComSite {
  website: string | null;
  site?: SiteEnrichment | null;
}

/** Teto de reverificações de um veredito provisório antes de congelar. */
export const LIMITE_TENTATIVAS = 3;

// As 3 tentativas cobrem 1h (30min × 2 intervalos), não 3 minutos de queda de rede; domínio inexistente nem espera.
export const INTERVALO_MINIMO_ENTRE_TENTATIVAS_MIN = 30;

/** Verdadeiro enquanto um veredito provisório ainda aceita nova tentativa. */
export function deveReverificar(site: { provisorio: boolean; tentativas: number }): boolean {
  return site.provisorio && site.tentativas < LIMITE_TENTATIVAS;
}

/**
 * O checklist que a LEITURA usa: `wa.me` no site é telefone de contato.
 *
 * O veredito gravado antes do #3723 marcava `falta-tel` em site que tinha link
 * de WhatsApp — o próprio checklist, duas linhas acima, marcava `whatsapp`
 * como presente. Corrigir só o gerador deixaria as linhas já gravadas mentindo;
 * a regra vale, portanto, também na leitura (sem reescrever o banco).
 */
function checklistLido(checklist: RaioXDoSite | undefined, resumo: string | null): RaioXDoSite {
  const lido: RaioXDoSite = {
    tem: [...(checklist?.tem ?? [])],
    falta: [...(checklist?.falta ?? [])],
  };
  if (checklist?.inconclusivo) lido.inconclusivo = true;
  if (lido.tem.includes("whatsapp") && !lido.tem.includes("tel")) lido.tem.push("tel");
  // O resumo guardado abre com "Título: …" quando a página TINHA `<title>`: a
  // falta de título do veredito antigo era o mínimo de 8 caracteres, não o site.
  if (resumo && /^Título:\s*\S/m.test(resumo) && !lido.tem.includes("titulo")) lido.tem.push("titulo");
  const tem = new Set<string>(lido.tem);
  lido.falta = lido.falta.filter((item: ItemDoRaioX) => !tem.has(item));
  return lido;
}

/**
 * A LEITURA do veredito gravado, corrigida pela regra "medido × não medido"
 * (#3723). Função pura, sem banco: os vereditos já gravados NÃO são migrados —
 * é aqui que eles deixam de mentir, e a próxima auditoria regrava com a regra
 * nova.
 *
 * Três correções, e só elas (o resto passa byte a byte):
 *
 * 1. `falta-*` sai de `problemas`: item de checklist é melhoria, nunca foi
 *    defeito medido — e `problemas` é o que a copy cita.
 * 2. `site-ruim` que só tinha `falta-*` volta a `site-ok`: era o falso positivo
 *    que fez 30 de 47 empresas virarem "site com problemas".
 * 3. Medição bloqueada (`http-403/401/406/429/451/503`) e `fora-do-ar` sem
 *    prova (`http_status` nulo e sem `dns-morto`) viram `nao-medido`: o site
 *    pode estar no ar, só não olhamos. Antes congelavam citáveis.
 */
export function normalizarVeredito(gravado: SiteEnrichment): SiteEnrichment {
  const checklist = checklistLido(gravado.checklist, gravado.conteudo_resumo);
  const medidos = problemasMedidos(gravado.problemas);
  const codigoDeBloqueio = medidos.find((p) => /^http-(401|403|406|429|451|503)$/.test(p));
  const semProvaDeQueda =
    gravado.classe === "fora-do-ar" && gravado.http_status === null && !medidos.includes("dns-morto");
  const semDefeito =
    gravado.classe === "site-ruim" && medidos.length === 0 && gravado.problemas.length > 0;

  let classe = gravado.classe;
  let problemas = medidos;
  if (codigoDeBloqueio || semProvaDeQueda) {
    classe = "nao-medido";
    // O código antigo dizia "o site responde com erro (403)" — que é o que NÃO
    // se sabe. O da medição barrada diz o que aconteceu com a nossa tentativa.
    problemas = [codigoDeBloqueio ? "medicao-bloqueada" : "medicao-instavel"];
  } else if (semDefeito) {
    classe = "site-ok";
  }

  const mudouChecklist =
    checklist.tem.length !== (gravado.checklist?.tem.length ?? 0) ||
    checklist.falta.length !== (gravado.checklist?.falta.length ?? 0) ||
    checklist.inconclusivo !== gravado.checklist?.inconclusivo;
  // Nada a corrigir: devolve o MESMO objeto (a tela chama isto por linha).
  const mesmosProblemas =
    problemas.length === gravado.problemas.length &&
    problemas.every((p, i) => p === gravado.problemas[i]);
  if (classe === gravado.classe && mesmosProblemas && !mudouChecklist) return gravado;

  return { ...gravado, classe, problemas, checklist };
}

/**
 * O veredito que a leitura usa: o gravado (já corrigido por
 * `normalizarVeredito`) quando existe; o `sem-site` derivado quando não há
 * `website`; `null` quando ainda depende de rede (pendente de verdade).
 */
export function siteEfetivo(data: DadosComSite, agoraIso: string): SiteEnrichment | null {
  if (data.site) return normalizarVeredito(data.site);
  if (ehSemSite(data.website)) return vereditoPuro(null, agoraIso);
  return null;
}

/**
 * Quem o botão "Verificar sites" ainda pode socorrer: site preenchido e ainda
 * sem veredito, ou provisório já elegível para nova rodada. O `sem-site`
 * derivado NÃO entra — não há rede a fazer, e contá-lo dava um número que nunca
 * zerava.
 */
export function precisaDeRede(data: DadosComSite, agoraIso: string): boolean {
  const gravado = data.site;
  if (!gravado) return !ehSemSite(data.website);
  if (!deveReverificar(gravado)) return false;
  const decorrido = Date.parse(agoraIso) - Date.parse(gravado.verificado_em);
  return decorrido >= INTERVALO_MINIMO_ENTRE_TENTATIVAS_MIN * 60_000;
}
