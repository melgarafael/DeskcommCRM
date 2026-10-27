import "server-only";

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { accessToken, enviarTexto, estadoDoDrive, iniciarEnvio } from "../acervo/drive";
import { garantirPastasDoCliente } from "../acervo/pastas";
import type { TipoDeAprovacao } from "../aprovacoes/vocabulario";
import { criarAviso } from "../avisos/criar";
import { diaLocal } from "../tarefas/regras";
import { apagarObjetos, lerFaixa } from "./armazenamento";
import { nomeNoDrive, proximoPedaco, subpastaDoEnvio } from "./regras";

/**
 * A cópia do envio aprovado para o Google Drive (SPEC-envios, E6–E7, E9).
 * Em pedaços e retomável: cada rodada continua de onde a anterior parou, e só
 * depois de o Drive confirmar o arquivo inteiro o sistema apaga da VPS.
 * Nunca lança — o estado (e o motivo) fica em `agencia_envios_copias`.
 */

const TRAVA_MS = 5 * 60_000;
const MAX_TENTATIVAS = 20;

interface Envio {
  id: string;
  cliente_id: string;
  tarefa_id: string | null;
  tipo: TipoDeAprovacao;
  titulo: string;
  versao: number;
  origem_id: string | null;
  texto: string | null;
  arquivo_caminho: string | null;
  arquivo_nome: string | null;
  arquivo_mime: string | null;
  arquivo_bytes: number | null;
  arquivo_apagado_em: string | null;
  respondido_em: string | null;
  pedido_por: string | null;
}

/** Põe o envio aprovado na fila. Idempotente: aprovar duas vezes não duplica. */
export async function enfileirarCopia(aprovacaoId: string): Promise<void> {
  await createAdminClient().from("agencia_envios_copias").upsert({ aprovacao_id: aprovacaoId }, { onConflict: "aprovacao_id", ignoreDuplicates: true });
}

/** Toma o envio para esta rodada; null quando outra rodada está com ele ou já terminou. */
async function tomar(aprovacaoId: string): Promise<{ sessao: string | null; enviados: number; tentativas: number; avisado_em: string | null } | null> {
  const db = createAdminClient();
  const agora = new Date();
  const { data } = await db
    .from("agencia_envios_copias")
    .update({ situacao: "copiando", atualizado_em: agora.toISOString() })
    .eq("aprovacao_id", aprovacaoId)
    .or(`situacao.in.(aguardando,falhou),and(situacao.eq.copiando,atualizado_em.lt.${new Date(agora.getTime() - TRAVA_MS).toISOString()})`)
    .lt("tentativas", MAX_TENTATIVAS)
    .select("sessao, enviados, tentativas, avisado_em");
  return (data?.[0] as { sessao: string | null; enviados: number; tentativas: number; avisado_em: string | null } | undefined) ?? null;
}

async function anotar(aprovacaoId: string, campos: Record<string, unknown>): Promise<void> {
  await createAdminClient().from("agencia_envios_copias").update({ ...campos, atualizado_em: new Date().toISOString() }).eq("aprovacao_id", aprovacaoId);
}

/** E7: avisa a equipe UMA vez que o envio está esperando o Drive. */
async function avisarQueEspera(e: Envio, motivo: string, jaAvisado: string | null): Promise<void> {
  if (jaAvisado) return;
  try {
    const db = createAdminClient();
    const { data: m } = e.pedido_por ? await db.from("agencia_membros").select("id").eq("user_id", e.pedido_por).eq("situacao", "ativo").maybeSingle() : { data: null };
    await criarAviso({
      alvo: m ? { tipo: "membros", ids: [(m as { id: string }).id] } : { tipo: "gerais" },
      tipo: "envio_aguardando_drive",
      titulo: `Aprovado, esperando o Drive: ${e.titulo}`,
      corpo: `${motivo} O arquivo continua guardado na VPS até a cópia dar certo.`,
      link: `/agencia/envios?abrir=${e.id}`,
      referenciaId: e.id,
    });
    await anotar(e.id, { avisado_em: new Date().toISOString() });
  } catch (err) {
    logger.warn("agência: aviso de envio esperando o Drive falhou", { detalhe: err instanceof Error ? err.message : String(err) });
  }
}

/** Os caminhos da cadeia de versões (esta e as anteriores) que ainda estão na VPS. */
async function caminhosDaCadeia(e: Envio): Promise<Array<{ id: string; caminho: string }>> {
  const db = createAdminClient();
  const fila: Array<{ id: string; caminho: string }> = [];
  let atual: { id: string; origem_id: string | null; arquivo_caminho: string | null; arquivo_apagado_em: string | null } | null = e;
  for (let i = 0; atual && i < 99; i++) {
    if (atual.arquivo_caminho && !atual.arquivo_apagado_em) fila.push({ id: atual.id, caminho: atual.arquivo_caminho });
    if (!atual.origem_id) break;
    const { data } = await db.from("agencia_aprovacoes").select("id, origem_id, arquivo_caminho, arquivo_apagado_em").eq("id", atual.origem_id).maybeSingle();
    atual = data as typeof atual;
  }
  return fila;
}

async function limparDaVps(e: Envio): Promise<void> {
  const cadeia = await caminhosDaCadeia(e);
  if (cadeia.length === 0) return;
  if (await apagarObjetos(cadeia.map((c) => c.caminho))) {
    await createAdminClient()
      .from("agencia_aprovacoes")
      .update({ arquivo_apagado_em: new Date().toISOString() })
      .in(
        "id",
        cadeia.map((c) => c.id),
      );
  }
}

/** Uma rodada da cópia de UM envio, até o fim ou até o tempo acabar. */
export async function copiarEnvio(aprovacaoId: string, prazoMs = 90_000): Promise<"copiado" | "continua" | "esperando" | "falhou" | "ocupado"> {
  const inicio = Date.now();
  const c = await tomar(aprovacaoId);
  if (!c) return "ocupado";
  const db = createAdminClient();
  const { data } = await db
    .from("agencia_aprovacoes")
    .select("id, cliente_id, tarefa_id, tipo, titulo, versao, origem_id, texto, arquivo_caminho, arquivo_nome, arquivo_mime, arquivo_bytes, arquivo_apagado_em, respondido_em, pedido_por")
    .eq("id", aprovacaoId)
    .eq("situacao", "aprovado")
    .maybeSingle();
  const e = data as Envio | null;
  if (!e) {
    await anotar(aprovacaoId, { situacao: "falhou", erro: "O envio não está aprovado." , tentativas: MAX_TENTATIVAS });
    return "falhou";
  }
  const subpasta = subpastaDoEnvio(e.tipo);
  const falhar = async (erro: string, contar = true) => {
    await anotar(e.id, { situacao: contar ? "falhou" : "aguardando", erro, ...(contar ? { tentativas: c.tentativas + 1 } : {}) });
    await avisarQueEspera(e, erro, c.avisado_em);
    return contar ? ("falhou" as const) : ("esperando" as const);
  };
  if (!subpasta || (!e.arquivo_caminho && !e.texto)) {
    await anotar(e.id, { situacao: "copiado", erro: null });
    return "copiado";
  }

  // E7: Drive desconectado não é falha — espera, sem gastar tentativa.
  const drive = await estadoDoDrive();
  if (!drive.conectado) return falhar("O Google Drive não está conectado (Configurações da agência).", false);
  if (!(await garantirPastasDoCliente(e.cliente_id, { renomear: false }))) return falhar("Não deu para preparar a pasta do cliente no Drive.");
  const { data: cli } = await db.from("agencia_clientes").select("drive_subpastas").eq("id", e.cliente_id).maybeSingle();
  const pastaId = ((cli as { drive_subpastas: Record<string, string> | null } | null)?.drive_subpastas ?? {})[subpasta];
  if (!pastaId) return falhar(`A subpasta "${subpasta}" do cliente não existe no Drive.`);
  const dia = diaLocal(new Date(e.respondido_em ?? Date.now()));

  // Texto (roteiro, estratégia): um .txt na pasta de planejamento.
  if (!e.arquivo_caminho) {
    const r = await enviarTexto({ nome: nomeNoDrive({ titulo: e.titulo, versao: e.versao, dia, extensao: "txt" }), conteudo: e.texto ?? "", pastaId });
    if (!r.ok) return falhar(r.erro);
    await anotar(e.id, { situacao: "copiado", erro: null, drive_arquivo_id: r.valor.id });
    return "copiado";
  }

  if (e.arquivo_apagado_em) {
    await anotar(e.id, { situacao: "falhou", erro: "O arquivo já não está na VPS.", tentativas: MAX_TENTATIVAS });
    return "falhou";
  }
  const total = Number(e.arquivo_bytes ?? 0);
  const extensao = e.arquivo_caminho.split(".").pop() ?? "bin";
  let sessao = c.sessao;
  let enviados = sessao ? c.enviados : 0;
  if (!sessao) {
    const s = await iniciarEnvio({
      nome: nomeNoDrive({ titulo: e.titulo, versao: e.versao, dia, extensao }),
      mime: e.arquivo_mime ?? "application/octet-stream",
      tamanho: total,
      pastaId,
      origem: env.NEXT_PUBLIC_APP_URL,
    });
    if (!s.ok) return falhar(s.erro);
    sessao = s.valor.urlDeEnvio;
    enviados = 0;
    await anotar(e.id, { sessao, enviados: 0 });
  }
  const token = await accessToken();
  if (!token.ok) return falhar(token.erro);

  try {
    for (;;) {
      const p = proximoPedaco(enviados, total);
      if (!p) break;
      const corpo = await lerFaixa(e.arquivo_caminho, p.inicio, p.fim);
      const r = await fetch(sessao, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token.valor}`, "Content-Range": `bytes ${p.inicio}-${p.fim}/${total}`, "Content-Length": String(corpo.byteLength) },
        body: new Uint8Array(corpo),
        signal: AbortSignal.timeout(120_000),
      });
      if (r.status === 308) {
        const faixa = r.headers.get("range");
        enviados = faixa ? Number(faixa.split("-")[1]) + 1 : 0;
        await anotar(e.id, { enviados });
        if (Date.now() - inicio > prazoMs) {
          await anotar(e.id, { situacao: "aguardando" });
          return "continua";
        }
        continue;
      }
      if (r.status === 404 || r.status === 410) {
        // A sessão do Drive venceu (dura uma semana): recomeça do zero na próxima rodada.
        await anotar(e.id, { situacao: "aguardando", sessao: null, enviados: 0 });
        return "continua";
      }
      if (r.status !== 200 && r.status !== 201) return falhar(`O Google Drive recusou o pedaço (${r.status}).`);
      const arq = (await r.json()) as { id: string; size?: string; webViewLink?: string };
      if (Number(arq.size ?? total) !== total) return falhar("O Drive gravou um tamanho diferente do original; o arquivo continua na VPS.");
      await anotar(e.id, { situacao: "copiado", erro: null, enviados: total, drive_arquivo_id: arq.id, drive_link: arq.webViewLink ?? null });
      await db
        .from("agencia_arquivos")
        .upsert(
          {
            cliente_id: e.cliente_id,
            tarefa_id: e.tarefa_id,
            subpasta,
            drive_file_id: arq.id,
            nome: e.arquivo_nome ?? e.titulo,
            mime: e.arquivo_mime,
            tamanho_bytes: total,
            link: arq.webViewLink ?? `https://drive.google.com/file/d/${arq.id}/view`,
            enviado_por: e.pedido_por,
          },
          { onConflict: "drive_file_id", ignoreDuplicates: true },
        );
      await limparDaVps(e);
      return "copiado";
    }
    return "continua";
  } catch (err) {
    return falhar(err instanceof Error ? err.message.slice(0, 300) : "A cópia parou no meio.");
  }
}

/** A rodada do relógio (cron agencia-prazos): termina as cópias pendentes, dentro do tempo. */
export async function copiarEnviosPendentes(prazoMs = 80_000): Promise<{ copiados: number; pendentes: number }> {
  const inicio = Date.now();
  const { data } = await createAdminClient()
    .from("agencia_envios_copias")
    .select("aprovacao_id")
    .in("situacao", ["aguardando", "copiando", "falhou"])
    .lt("tentativas", MAX_TENTATIVAS)
    .order("atualizado_em")
    .limit(10);
  let copiados = 0;
  const ids = ((data ?? []) as Array<{ aprovacao_id: string }>).map((d) => d.aprovacao_id);
  for (const id of ids) {
    const resta = prazoMs - (Date.now() - inicio);
    if (resta < 10_000) break;
    if ((await copiarEnvio(id, resta)) === "copiado") copiados++;
  }
  return { copiados, pendentes: ids.length - copiados };
}
