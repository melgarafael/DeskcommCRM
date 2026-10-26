import Link from "next/link";

import { EditorDeModelos, type ModeloNoEditor } from "@/components/agencia/trilhas/EditorDeModelos";
import { requirePermissaoNaPagina } from "@/lib/agencia/acesso";
import type { RegraDePrazo, TipoDePasso } from "@/lib/agencia/trilhas/vocabulario";
import type { TipoDeReuniao } from "@/lib/agencia/calendario/vocabulario";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Modelos de trilha · Agência" };
export const dynamic = "force-dynamic";

/** Editor dos modelos de trilha (docs/agencia/SPEC-trilhas.md, R1–R2). */
export default async function PaginaDosModelos() {
  await requirePermissaoNaPagina("trilhas.gerenciar");
  const db = createAdminClient();
  const [{ data: modelos }, { data: funcoes }] = await Promise.all([
    db.from("agencia_trilha_modelos").select("id, nome, tipo, ativo, agencia_trilha_modelo_passos(*)").order("nome"),
    db.from("agencia_funcoes").select("id, nome").eq("ativa", true).order("ordem"),
  ]);

  const lista: ModeloNoEditor[] = ((modelos ?? []) as Array<{
    id: string;
    nome: string;
    tipo: "recorrente" | "avulsa";
    ativo: boolean;
    agencia_trilha_modelo_passos: Array<{
      chave: string;
      etapa: number;
      ordem: number;
      titulo: string;
      descricao: string | null;
      tipo: TipoDePasso;
      reuniao_tipo: TipoDeReuniao | null;
      funcao_id: string | null;
      depende_de: string[];
      prazo_regra: RegraDePrazo;
      prazo_dias: number | null;
      prazo_ancora: string | null;
      checklist: string[];
      executor: "humano" | "ia";
    }> | null;
  }>).map((m) => ({
    id: m.id,
    nome: m.nome,
    tipo: m.tipo,
    ativo: m.ativo,
    passos: [...(m.agencia_trilha_modelo_passos ?? [])]
      .sort((a, b) => a.etapa - b.etapa || a.ordem - b.ordem)
      .map((x) => ({
        chave: x.chave,
        etapa: x.etapa,
        ordem: x.ordem,
        titulo: x.titulo,
        descricao: x.descricao,
        tipo: x.tipo,
        reuniaoTipo: x.reuniao_tipo,
        funcaoId: x.funcao_id,
        dependeDe: x.depende_de,
        regra: x.prazo_regra,
        dias: x.prazo_dias,
        ancora: x.prazo_ancora,
        checklist: x.checklist,
        executor: x.executor,
      })),
  }));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="space-y-1">
        <Link href="/agencia/trilhas" className="text-sm text-muted-foreground underline underline-offset-4">
          ← Trilhas
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Modelos de trilha</h1>
        <p className="text-sm text-muted-foreground">
          Mudar um modelo vale para as trilhas que começarem depois; as que já andam guardam a própria cópia.
        </p>
      </div>
      <EditorDeModelos modelos={lista} funcoes={(funcoes ?? []) as Array<{ id: string; nome: string }>} />
    </div>
  );
}
