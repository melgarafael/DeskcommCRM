import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { gerarGrade } from "@/lib/prospeccao/grade";
import {
  decidirDedup,
  type ProspectCandidato,
  type ProspectExistente,
} from "@/lib/prospeccao/dedup";
import {
  extrairDominio,
  normalizarNome,
  normalizarTelefone,
  partirEndereco,
  whatsappPotencial,
} from "@/lib/prospeccao/normalizacao";
import { scoreDeProspect } from "@/lib/prospeccao/score";
import { criarProvider } from "@/lib/prospeccao/providers/registro";
import { CUSTO_DETAILS_CENTS, CUSTO_SEARCH_CENTS } from "@/lib/prospeccao/providers/google-places";
import type { NegocioDescoberto } from "@/lib/prospeccao/tipos";

/**
 * O MOTOR — um tick processa N células da busca mais antiga pendente.
 *
 * Modelo de execução (§10 do plano, com a infra que o projeto JÁ tem): NÃO há
 * BullMQ/Redis de fila aqui — há a rota cron `prospecting-drain` (mesmo molde
 * de `event-log-drain`), chamada a cada minuto pelo scheduler da VPS e pelo
 * `pnpm dev:crons` em dev. Cada tick avança o cursor; o cursor (contagem
 * sobre a grade determinística) É o checkpoint (§12): cair o servidor no
 * meio só perde o tick atual, e `running` velho volta a `queued` sozinho.
 */

const CELULAS_POR_TICK = 3;
const STUCK_MINUTOS = 30;

export interface TickResult {
  search_id: string | null;
  status: string | null;
  celulas: number;
  novas: number;
  duplicadas: number;
  erros: number;
}

function hashBusca(params: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(params)).digest("hex").slice(0, 32);
}

export function hashDaBusca(p: {
  categorias: string[];
  cidade: string | null;
  estado: string | null;
  raioKm: number;
  provider: string;
  latitude?: number | null;
  longitude?: number | null;
}): string {
  return hashBusca({
    categorias: [...p.categorias].sort(),
    cidade: (p.cidade ?? "").toLowerCase().trim(),
    estado: (p.estado ?? "").toLowerCase().trim(),
    raioKm: p.raioKm,
    provider: p.provider,
    ...(p.latitude != null && p.longitude != null
      ? { lat: Math.round(p.latitude * 1000) / 1000, lng: Math.round(p.longitude * 1000) / 1000 }
      : {}),
  });
}

interface LinhaBusca {
  id: string;
  organization_id: string;
  categorias: string[];
  cidade: string | null;
  estado: string | null;
  latitude: number | null;
  longitude: number | null;
  raio_km: number;
  max_empresas: number;
  provider: string;
  status: string;
  grid_size_km: number;
  grid_overlap_pct: number;
  total_celulas: number;
  celulas_processadas: number;
  encontradas: number;
  novas: number;
  duplicadas: number;
  erros: number;
  requisicoes: number;
  detalhes: number;
  custo_estimado_cents: number;
}

async function resolverChave(
  admin: SupabaseClient,
  orgId: string,
): Promise<{ chave: string | null; origem: string }> {
  const { data } = await admin
    .from("prospecting_settings")
    .select("google_api_key_encrypted")
    .eq("organization_id", orgId)
    .maybeSingle();
  const enc = (data as unknown as { google_api_key_encrypted: string | null } | null)
    ?.google_api_key_encrypted;
  if (enc) {
    const chave = await decryptWebhookSecret(admin, enc);
    if (chave) return { chave, origem: "tenant" };
  }
  const envKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (envKey) return { chave: envKey, origem: "instalacao" };
  return { chave: null, origem: "nenhuma" };
}

async function lerSettings(admin: SupabaseClient, orgId: string) {
  const { data } = await admin
    .from("prospecting_settings")
    .select("limite_diario, requisicoes_por_minuto, provider_ativo")
    .eq("organization_id", orgId)
    .maybeSingle();
  const linha = data as unknown as {
    limite_diario: number;
    requisicoes_por_minuto: number;
    provider_ativo: string;
  } | null;
  return {
    temLinha: Boolean(linha),
    limite_diario: linha?.limite_diario ?? 2000,
    requisicoes_por_minuto: linha?.requisicoes_por_minuto ?? 60,
    provider_ativo: linha?.provider_ativo ?? "google_places",
  };
}

export async function processarTick(
  admin: SupabaseClient,
  criar: typeof criarProvider = criarProvider,
): Promise<TickResult> {
  const vazio: TickResult = {
    search_id: null,
    status: null,
    celulas: 0,
    novas: 0,
    duplicadas: 0,
    erros: 0,
  };

  // Recupera travadas: running sem atualização há 30min volta para a fila.
  const limiteStuck = new Date(Date.now() - STUCK_MINUTOS * 60000).toISOString();
  await admin
    .from("prospecting_searches")
    .update({ status: "queued" })
    .eq("status", "running")
    .lt("updated_at", limiteStuck);

  const { data: linha } = await admin
    .from("prospecting_searches")
    .select("*")
    .in("status", ["queued", "running"])
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const busca = linha as unknown as LinhaBusca | null;
  if (!busca) return vazio;

  const res: TickResult = {
    search_id: busca.id,
    status: busca.status,
    celulas: 0,
    novas: 0,
    duplicadas: 0,
    erros: 0,
  };

  const falhar = async (msg: string) => {
    await admin
      .from("prospecting_searches")
      .update({ status: "failed", ultimo_erro: msg.slice(0, 500), finished_at: new Date().toISOString() })
      .eq("id", busca.id);
    res.status = "failed";
    return res;
  };

  if (busca.provider !== "google_places" && busca.provider !== "osm_overpass") {
    return falhar(`provider "${busca.provider}" sem executor ligado.`);
  }

  const settings = await lerSettings(admin, busca.organization_id);
  // Sem linha de settings, vale o default honesto: osm_overpass (grátis, sem
  // chave) — não google_places, que falharia nomeando chave inexistente.
  const ativo = settings.temLinha ? settings.provider_ativo : "osm_overpass";
  if (ativo !== busca.provider) {
    return falhar(`Provider ${busca.provider} desligado nas configurações (Configurações → Prospecção).`);
  }

  // Teto diário (§29 + limites do tenant). OSM não custa, mas o teto também
  // protege a instância pública (uso justo) — mesmo portão, dois motivos.
  const hoje = new Date().toISOString().slice(0, 10);
  const { data: hojeRows } = await admin
    .from("prospecting_searches")
    .select("requisicoes")
    .eq("organization_id", busca.organization_id)
    .gte("created_at", `${hoje}T00:00:00Z`);
  const gastoHoje = ((hojeRows ?? []) as { requisicoes: number }[]).reduce((s, r) => s + r.requisicoes, 0);
  if (gastoHoje >= settings.limite_diario) {
    return falhar(`Teto diário de ${settings.limite_diario} requisições atingido. Volta amanhã.`);
  }

  // Google exige chave (tenant cifrada ou instalação); OSM é aberto.
  let chave: string | null = null;
  if (busca.provider === "google_places") {
    if (process.env.GOOGLE_PLACES_ENABLED === "false") {
      return falhar("GOOGLE_PLACES_ENABLED=false nesta instalação.");
    }
    const resolvida = await resolverChave(admin, busca.organization_id);
    chave = resolvida.chave;
    if (!chave) {
      return falhar("Sem chave do Google (tenant e instalação). Configure em Configurações → Prospecção.");
    }
  }

  if (busca.latitude === null || busca.longitude === null) {
    return falhar("Busca sem coordenadas (geocodificação falhou na criação).");
  }

  let provider;
  try {
    provider =
      busca.provider === "osm_overpass"
        ? criar("osm_overpass", {})
        : criar("google_places", { chaveGoogle: chave ?? "" });
  } catch (e) {
    return falhar(e instanceof Error ? e.message : String(e));
  }

  // Grade determinística: cursor = contagem (checkpoint).
  const grade = gerarGrade(
    busca.latitude,
    busca.longitude,
    busca.raio_km,
    Number(busca.grid_size_km),
    Number(busca.grid_overlap_pct),
  );
  const categorias = busca.categorias.length > 0 ? busca.categorias : ["empresas"];
  const total = grade.length * categorias.length;
  if (busca.total_celulas !== total) {
    await admin.from("prospecting_searches").update({ total_celulas: total }).eq("id", busca.id);
  }

  if (busca.status === "queued") {
    await admin
      .from("prospecting_searches")
      .update({ status: "running", started_at: new Date().toISOString() })
      .eq("id", busca.id);
    res.status = "running";
  } else {
    res.status = "running";
  }

  const pausaMs = Math.max(0, Math.round(60000 / Math.max(1, settings.requisicoes_por_minuto)));
  let processadas = busca.celulas_processadas;
  let encontradas = busca.encontradas;
  let novas = busca.novas;
  let duplicadas = busca.duplicadas;
  let erros = busca.erros;
  let requisicoes = busca.requisicoes;
  let detalhes = busca.detalhes;
  let custo = busca.custo_estimado_cents;

  const gravarProgresso = () =>
    admin
      .from("prospecting_searches")
      .update({
        celulas_processadas: processadas,
        encontradas,
        novas,
        duplicadas,
        erros,
        requisicoes,
        detalhes,
        custo_estimado_cents: custo,
      })
      .eq("id", busca.id);

  for (let n = 0; n < CELULAS_POR_TICK && processadas < total; n++) {
    const idxCat = Math.floor(processadas / grade.length);
    const idxCel = processadas % grade.length;
    const categoria = categorias[idxCat] ?? "empresas";
    const celula = grade[idxCel];
    if (!celula) break;

    try {
      // Ritmo do tenant (§11): sem ele, rajada estoura a cota e o 429 trava a fila.
      if (n > 0 && pausaMs > 0) await new Promise((r) => setTimeout(r, pausaMs));
      const r = await provider.search({
        categoria,
        latitude: celula.latitude,
        longitude: celula.longitude,
        raioMetros: celula.raioMetros,
        limite: 60,
      });
      requisicoes += r.requisicoes;
      detalhes += r.detalhes;
      // OSM é gratuito: conta requisições (ritmo/cota), nunca custo.
      if (busca.provider !== "osm_overpass") {
        custo += r.requisicoes * CUSTO_SEARCH_CENTS + r.detalhes * CUSTO_DETAILS_CENTS;
      }

      const { novas: nn, duplicadas: dd } = await ingerirNegocios(admin, busca, r.negocios, categoria);
      novas += nn;
      duplicadas += dd;
      encontradas += r.negocios.length;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      erros++;
      logger.warn("[prospeccao] célula falhou", { search: busca.id, celula: celula.indice, error: msg });
      // Bloqueio do fornecedor (§3): não insiste — falha a busca nomeando.
      if (/google_40[13]|NAO_AUTORIZADO|INVALID|bloque/i.test(msg)) {
        await gravarProgresso();
        return falhar(`Fornecedor recusou: ${msg} (tarefa pausada, sem retry cego).`);
      }
      await admin
        .from("prospecting_searches")
        .update({ ultimo_erro: msg.slice(0, 500) })
        .eq("id", busca.id);
    }
    processadas++;
    res.celulas++;
    await gravarProgresso();
  }

  res.novas = novas - busca.novas;
  res.duplicadas = duplicadas - busca.duplicadas;
  res.erros = erros - busca.erros;

  if (processadas >= total) {
    await admin
      .from("prospecting_searches")
      .update({ status: "completed", finished_at: new Date().toISOString() })
      .eq("id", busca.id);
    res.status = "completed";
  }
  return res;
}

async function ingerirNegocios(
  admin: SupabaseClient,
  busca: Pick<LinhaBusca, "organization_id" | "provider"> & { id: string | null },
  negocios: NegocioDescoberto[],
  categoriaBusca: string,
): Promise<{ novas: number; duplicadas: number }> {
  let novas = 0;
  let duplicadas = 0;
  if (negocios.length === 0) return { novas, duplicadas };

  type Cand = ProspectCandidato & { bruto: NegocioDescoberto };
  const candidatos: Cand[] = negocios
    .filter((b) => b.nome && b.nome.trim())
    .map((b) => {
      const telefone = normalizarTelefone(b.telefone);
      return {
        provider: busca.provider,
        external_id: b.idExterno,
        nome_normalizado: normalizarNome(b.nome),
        telefone_normalizado: telefone,
        dominio: extrairDominio(b.website),
        endereco: b.endereco,
        latitude: b.latitude,
        longitude: b.longitude,
        bruto: b,
      };
    });

  // Busca em lote (3 queries, não 3N): identidade, telefone+domínio.
  const idsExternos = [...new Set(candidatos.map((c) => c.external_id).filter(Boolean))] as string[];
  const fones = [...new Set(candidatos.map((c) => c.telefone_normalizado).filter(Boolean))] as string[];
  const dominios = [...new Set(candidatos.map((c) => c.dominio).filter(Boolean))] as string[];

  const existentes: ProspectExistente[] = [];
  if (idsExternos.length > 0) {
    const { data } = await admin
      .from("business_prospects")
      .select("id, provider, external_id, nome_normalizado, telefone_normalizado, dominio, endereco, latitude, longitude")
      .eq("organization_id", busca.organization_id)
      .eq("provider", busca.provider)
      .in("external_id", idsExternos);
    existentes.push(...((data ?? []) as unknown as ProspectExistente[]));
  }
  if (fones.length > 0 || dominios.length > 0) {
    const q = admin
      .from("business_prospects")
      .select("id, provider, external_id, nome_normalizado, telefone_normalizado, dominio, endereco, latitude, longitude")
      .eq("organization_id", busca.organization_id)
      .limit(2000);
    const conds: string[] = [];
    if (fones.length > 0) conds.push(`telefone_normalizado.in.(${fones.join(",")})`);
    if (dominios.length > 0) conds.push(`dominio.in.(${dominios.join(",")})`);
    const { data } = await q.or(conds.join(","));
    for (const e of (data ?? []) as unknown as ProspectExistente[]) {
      if (!existentes.some((x) => x.id === e.id)) existentes.push(e);
    }
  }

  const vistos = new Map(existentes.map((e) => [e.id, e]));

  for (const c of candidatos) {
    const decisao = decidirDedup(c, [...vistos.values()]);
    if (decisao.nivel === "proximidade_sugestao" || decisao.nivel === "novo") {
      const inserido = await inserirProspect(admin, busca, c, categoriaBusca, decisao.nivel === "proximidade_sugestao" ? decisao.comQuem : null);
      if (inserido) {
        novas++;
        vistos.set(inserido, {
          id: inserido,
          provider: c.provider,
          external_id: c.external_id,
          nome_normalizado: c.nome_normalizado,
          telefone_normalizado: c.telefone_normalizado,
          dominio: c.dominio,
          endereco: c.endereco,
          latitude: c.latitude,
          longitude: c.longitude,
        });
        if (busca.id !== null) {
          await vincularResultado(admin, { organization_id: busca.organization_id, id: busca.id }, inserido, true);
        }
      }
    } else if (decisao.comQuem) {
      duplicadas++;
      await admin
        .from("business_prospects")
        .update({ last_verified_at: new Date().toISOString() })
        .eq("id", decisao.comQuem);
      if (busca.id !== null) {
        await vincularResultado(admin, { organization_id: busca.organization_id, id: busca.id }, decisao.comQuem, false);
      }
    }
  }
  return { novas, duplicadas };
}

/**
 * A PONTE DE ARQUIVO — mesmos dedup/score/insert do tick, sem busca.
 *
 * Arquivo não tem search: `vincularResultado` é pulado (id null) e o
 * provider é `maps_arquivo` (identidade separada do `google_places` no
 * unique org+provider+external_id). Recusadas = sem nome após o trim.
 */
export async function importarNegociosDeArquivo(
  admin: SupabaseClient,
  orgId: string,
  categoria: string,
  brutos: NegocioDescoberto[],
): Promise<{ novas: number; duplicadas: number; recusadas: number }> {
  const validos = brutos.filter((b) => b.nome && b.nome.trim());
  const { novas, duplicadas } = await ingerirNegocios(
    admin,
    { organization_id: orgId, provider: "maps_arquivo", id: null },
    validos,
    categoria,
  );
  return { novas, duplicadas, recusadas: brutos.length - validos.length };
}

async function vincularResultado(
  admin: SupabaseClient,
  busca: Pick<LinhaBusca, "id" | "organization_id">,
  prospectId: string,
  primeiraVez: boolean,
): Promise<void> {
  await admin.from("prospect_search_results").upsert(
    {
      search_id: busca.id,
      prospect_id: prospectId,
      organization_id: busca.organization_id,
      primeira_vez: primeiraVez,
    },
    { onConflict: "search_id,prospect_id", ignoreDuplicates: true },
  );
}

async function inserirProspect(
  admin: SupabaseClient,
  busca: Pick<LinhaBusca, "organization_id">,
  c: ProspectCandidato & { bruto: NegocioDescoberto },
  categoriaBusca: string,
  sugestaoDe: string | null,
): Promise<string | null> {
  const b = c.bruto;
  const partes = partirEndereco(b.endereco);
  const score = scoreDeProspect({
    temTelefone: Boolean(c.telefone_normalizado),
    temWebsite: Boolean(c.dominio),
    whatsappPotencial: whatsappPotencial(c.telefone_normalizado),
    nota: b.nota,
    totalAvaliacoes: b.totalAvaliacoes,
  });
  const { data, error } = await admin
    .from("business_prospects")
    .insert({
      organization_id: busca.organization_id,
      nome: b.nome.trim(),
      nome_normalizado: c.nome_normalizado,
      categoria: categoriaBusca,
      categorias: [categoriaBusca, ...(b.categoriasSecundarias ?? [])].slice(0, 10),
      telefone: b.telefone,
      telefone_normalizado: c.telefone_normalizado,
      whatsapp_potencial: whatsappPotencial(c.telefone_normalizado),
      website: b.website,
      dominio: c.dominio,
      email: b.email,
      endereco: b.endereco,
      logradouro: partes.logradouro,
      numero_end: partes.numero,
      bairro: partes.bairro ?? b.bairro,
      cidade: partes.cidade ?? b.cidade,
      estado: partes.estado ?? b.estado,
      cep: partes.cep,
      pais: b.pais ?? "BR",
      latitude: b.latitude,
      longitude: b.longitude,
      provider: c.provider,
      external_id: c.external_id,
      external_url: b.urlExterna,
      nota: b.nota,
      total_avaliacoes: b.totalAvaliacoes,
      horario_funcionamento: b.horarioFuncionamento,
      status_comercial: "novo",
      score,
      candidato_duplicado_de: sugestaoDe,
      source: `provider:${c.provider}`,
      source_url: b.urlExterna,
      created_by: null,
    })
    .select("id")
    .single();
  if (error) {
    // Corrida entre ticks (unique provider+id): quem perdeu vira duplicada.
    if (error.code === "23505") return null;
    logger.warn("[prospeccao] insert falhou", { error: error.message });
    return null;
  }
  return (data as unknown as { id: string }).id;
}
