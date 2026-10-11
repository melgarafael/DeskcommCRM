/**
 * Fixture do E2E do painel de Skills com VERSÃO NOVA DO CATÁLOGO (#1977).
 *
 * A tela de Skills tem um estado que nenhum e2e alcançava: a cópia da organização
 * está ATRÁS do catálogo. Reproduzi-lo pela interface exige três passos que a
 * interface NÃO tem como dar rápido — publicar uma versão de plataforma, instalar
 * (fork) numa organização e publicar OUTRA versão de plataforma em seguida.
 * `skill_versions` é imutável por trigger (`trg_skill_versions_immutable`), então
 * "publicar versão nova" aqui é INSERT de uma linha nova + UPDATE do ponteiro —
 * exatamente o que o caminho de produto faz (`installPlatformSkill` +
 * `setSkillPointer`).
 *
 * As TRÊS linhas que ficam no banco, e por que a spec pode cobrar números:
 *
 *   1. `skill_versions` de PLATAFORMA, versão antiga (organization_id null).
 *   2. `skill_versions` da ORGANIZAÇÃO — a cópia instalada, com
 *      `forked_from_version_id` apontando para a versão antiga de plataforma
 *      (é o vínculo que `temVersaoNovaNoCatalogo` compara).
 *   3. `skill_versions` de PLATAFORMA, versão NOVA — descrição, palavras-chave e
 *      corpo diferentes, e o ponteiro de plataforma movido para ela.
 *
 * O delta é SEMPRE o mesmo, de propósito: a spec cobra na tela
 * `+reatendimento, lista de espera` (entram), `−legado` (sai) e
 * `Procedimento (corpo): +2 −1` (LCS de 3 linhas entre o corpo antigo de 4 e o
 * novo de 5). Mudar os textos abaixo quebra a spec — é o contrato.
 *
 * IDEMPOTENTE: reusa as versões pelo par (escopo, descrição) e volta o ponteiro
 * da organização para a cópia ANTIGA. Sem isto, a segunda rodada nasceria depois
 * do próprio "Adotar versão nova" da primeira e a spec falharia por o aviso já
 * ter sumido — o cenário seria lido do estado destruído pelo run anterior.
 *
 * `E2E_SKILL_SEM_VERSAO_NOVA=1` monta o CENÁRIO INVERSO: a cópia da organização
 * nasce forkada da versão ATUAL de plataforma, ou seja, o catálogo não publicou
 * nada depois da instalação. É o RED da spec — com ele a tela não tem nada a
 * avisar e a spec tem de reprovar.
 *
 * Run: npx tsx scripts/seed-e2e-skill-versao-nova.ts
 */
import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";

import { anunciarDestino, credenciaisSupabaseDeTeste } from "./lib/env-de-teste";

const credenciais = credenciaisSupabaseDeTeste();
anunciarDestino("seed-e2e-skill-versao-nova", credenciais);

const admin = createClient(credenciais.url, credenciais.serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

/** Prefixo E2E: o nome é dado (aparece na tela), e o catálogo real já tem skills de verdade. */
const NOME = "E2E Versão Nova";

const DESCRICAO_ANTIGA = "Atende o cliente pelo WhatsApp e fecha o agendamento.";
const DESCRICAO_NOVA =
  "Atende o cliente pelo WhatsApp, fecha o agendamento e cuida da lista de espera.";

const CORPO_ANTIGO = [
  "Cumprimente o cliente pelo nome.",
  "Confirme o horário pedido.",
  "Ofereça horários alternativos quando a agenda estiver cheia.",
  "Registre o retorno no funil.",
].join("\n");

const CORPO_NOVO = [
  "Cumprimente o cliente pelo nome.",
  "Confirme o horário pedido pela tela.",
  "Ofereça horários alternativos quando a agenda estiver cheia.",
  "Quando houver espera, ofereça a lista de espera.",
  "Registre o retorno no funil.",
].join("\n");

/** 4 linhas × 5 linhas, LCS 3 → o comparativo mostra +2 −1. */
const MATCHER_ANTIGO = { any_keywords: ["agendar", "remarcar", "legado"] };
const MATCHER_NOVO = {
  any_keywords: ["agendar", "remarcar", "reatendimento", "lista de espera"],
};

interface SkillVersaoNova {
  nome: string;
  versao_copia: string;
  versao_plataforma: string;
  plataforma_antiga: string;
  /** Descrição da cópia INSTALADA — o que a tela mostra embaixo do nome. */
  descricao_copia: string;
  /** Descrição da versão ATUAL de catálogo — o que a tela passa a mostrar ao adotar. */
  descricao_plataforma: string;
  com_versao_nova: boolean;
}

interface Creds {
  org_id: string;
  skill_versao_nova?: SkillVersaoNova;
}

function lerCreds(): Creds {
  if (!fs.existsSync(CREDS_PATH)) {
    throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts`");
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

/** A versão já existente neste escopo com esta descrição — é a chave de idempotência. */
async function versaoCom(
  organizationId: string | null,
  description: string,
): Promise<string | null> {
  let consulta = admin
    .from("skill_versions")
    .select("id")
    .eq("name", NOME)
    .eq("description", description);
  consulta =
    organizationId === null
      ? consulta.is("organization_id", null)
      : consulta.eq("organization_id", organizationId);
  const { data, error } = await consulta
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data?.id as string | undefined) ?? null;
}

async function garantirVersao(input: {
  organizationId: string | null;
  description: string;
  body: string;
  matcher: { any_keywords: string[] };
  forkedFrom: string | null;
}): Promise<string> {
  const achada = await versaoCom(input.organizationId, input.description);
  if (achada) return achada;
  const { data, error } = await admin
    .from("skill_versions")
    .insert({
      organization_id: input.organizationId,
      name: NOME,
      description: input.description,
      body: input.body,
      matcher: input.matcher,
      forked_from_version_id: input.forkedFrom,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

/** Move (ou cria) o ponteiro deste escopo para `versionId` — é o "publicar" e o "voltar". */
async function moverPonteiro(organizationId: string | null, versionId: string): Promise<void> {
  let leitura = admin.from("skill_pointers").select("name").eq("name", NOME);
  leitura =
    organizationId === null
      ? leitura.is("organization_id", null)
      : leitura.eq("organization_id", organizationId);
  const { data: existente, error } = await leitura.maybeSingle();
  if (error) throw error;

  if (existente) {
    let atualizar = admin
      .from("skill_pointers")
      .update({ version_id: versionId })
      .eq("name", NOME);
    atualizar =
      organizationId === null
        ? atualizar.is("organization_id", null)
        : atualizar.eq("organization_id", organizationId);
    const { error: updErr } = await atualizar;
    if (updErr) throw updErr;
    return;
  }

  const { error: insErr } = await admin
    .from("skill_pointers")
    .insert({ organization_id: organizationId, name: NOME, version_id: versionId });
  if (insErr) throw insErr;
}

async function main(): Promise<void> {
  const creds = lerCreds();
  const semVersaoNova = process.env.E2E_SKILL_SEM_VERSAO_NOVA === "1";

  // (1) e (3) — as duas versões de PLATAFORMA; o ponteiro de catálogo fica na NOVA.
  const plataformaAntiga = await garantirVersao({
    organizationId: null,
    description: DESCRICAO_ANTIGA,
    body: CORPO_ANTIGO,
    matcher: MATCHER_ANTIGO,
    forkedFrom: null,
  });
  const plataformaNova = await garantirVersao({
    organizationId: null,
    description: DESCRICAO_NOVA,
    body: CORPO_NOVO,
    matcher: MATCHER_NOVO,
    forkedFrom: null,
  });
  await moverPonteiro(null, plataformaNova);

  // (2) — a cópia INSTALADA na organização. No cenário normal ela nasce da versão
  // antiga (catálogo andou depois); no inverso, da atual (nada mudou depois).
  const origemDaCopia = semVersaoNova ? plataformaNova : plataformaAntiga;
  const copia = await garantirVersao({
    organizationId: creds.org_id,
    description: semVersaoNova ? DESCRICAO_NOVA : DESCRICAO_ANTIGA,
    body: semVersaoNova ? CORPO_NOVO : CORPO_ANTIGO,
    matcher: semVersaoNova ? MATCHER_NOVO : MATCHER_ANTIGO,
    forkedFrom: origemDaCopia,
  });
  await moverPonteiro(creds.org_id, copia);

  const bloco: SkillVersaoNova = {
    nome: NOME,
    versao_copia: copia,
    versao_plataforma: plataformaNova,
    plataforma_antiga: plataformaAntiga,
    descricao_copia: semVersaoNova ? DESCRICAO_NOVA : DESCRICAO_ANTIGA,
    descricao_plataforma: DESCRICAO_NOVA,
    com_versao_nova: !semVersaoNova,
  };
  const atualizado: Creds = { ...creds, skill_versao_nova: bloco };
  fs.writeFileSync(CREDS_PATH, `${JSON.stringify(atualizado, null, 2)}\n`);

  console.log(
    `[seed-skill-versao-nova] cópia da org ${copia} ← origem ${origemDaCopia} | ` +
      `catálogo aponta para ${plataformaNova} (antiga: ${plataformaAntiga})`,
  );
  console.log(
    semVersaoNova
      ? "⚠️  CENÁRIO SEM VERSÃO NOVA (E2E_SKILL_SEM_VERSAO_NOVA=1) — a spec tem de reprovar"
      : "✅ skill do catálogo instalada com versão nova publicada no ponteiro de plataforma",
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
