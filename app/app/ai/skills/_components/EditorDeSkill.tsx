"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { useSkill, useSalvarSkill, useSkillVersions, useRestaurarSkill } from "@/hooks/ai/useSkills";

/** Mesmo teto do backend (`MAX_SKILL_BODY_LINES` em lib/agent-engine/agent/skills.ts). */
const MAX_LINHAS = 200;

interface Props {
  nome: string;
  aberto: boolean;
  aoMudarAberto: (aberto: boolean) => void;
}

/** Conta linhas como o backend (última linha vazia por trailing newline não conta). */
function contarLinhas(texto: string): number {
  const partes = texto.split("\n");
  return partes[partes.length - 1] === "" ? partes.length - 1 : partes.length;
}

/** Vírgulas/quebras separam palavras-chave; normaliza e remove vazias. */
function parseKeywords(texto: string): string[] {
  return texto
    .split(/[,\n]/)
    .map((k) => k.trim())
    .filter((k) => k !== "");
}

export function EditorDeSkill({ nome, aberto, aoMudarAberto }: Props) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const skill = useSkill(aberto ? nome : null);
  const salvar = useSalvarSkill();
  const versoes = useSkillVersions(aberto ? nome : null);
  const restaurar = useRestaurarSkill();

  const [descricao, setDescricao] = useState("");
  const [keywords, setKeywords] = useState("");
  const [corpo, setCorpo] = useState("");
  const [probe, setProbe] = useState<string[] | undefined>(undefined);

  useEffect(() => {
    const s = skill.data;
    if (!aberto || !s) return;
    setDescricao(s.description);
    setKeywords(s.matcher.any_keywords.join(", "));
    setCorpo(s.body);
    setProbe(s.matcher.probe_keywords);
  }, [aberto, skill.data]);

  const linhas = contarLinhas(corpo);
  const excedeTeto = linhas > MAX_LINHAS;
  const veioDePacote = skill.data?.tem_arquivos_do_pacote === true;

  function salvarSkill() {
    const anyKeywords = parseKeywords(keywords);
    if (anyKeywords.length === 0) {
      toast.error(t("Informe pelo menos uma palavra-chave de ativação."));
      return;
    }
    if (descricao.trim() === "") {
      toast.error(t("A descrição é obrigatória."));
      return;
    }
    if (corpo.trim() === "") {
      toast.error(t("O corpo da skill não pode ficar vazio."));
      return;
    }
    if (excedeTeto) {
      toast.error(`${t("Linhas no corpo")}: ${linhas}/${MAX_LINHAS}.`);
      return;
    }
    salvar.mutate(
      {
        name: nome,
        body: {
          description: descricao.trim(),
          body: corpo,
          matcher: { any_keywords: anyKeywords, ...(probe ? { probe_keywords: probe } : {}) },
        },
      },
      {
        onSuccess: () => {
          toast.success(`Skill "${nome}" ${t("atualizada — já vale para os agentes.")}`);
          aoMudarAberto(false);
        },
        onError: (err) => showApiError(err),
      },
    );
  }

  return (
    <Dialog open={aberto} onOpenChange={aoMudarAberto}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Editar skill")} “{nome}”</DialogTitle>
          <DialogDescription>
            {t(
              "Salvar cria uma versão nova (a antiga fica no histórico). O corpo só entra na conversa quando uma das palavras-chave aparece na mensagem do cliente.",
            )}
          </DialogDescription>
        </DialogHeader>

        {skill.isLoading && <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>}
        {skill.isError && (
          <p className="text-sm text-destructive">{t("Não foi possível carregar a skill.")}</p>
        )}

        {skill.isSuccess && (
          <div className="flex flex-col gap-4 py-2">
            {veioDePacote && (
              <p className="rounded-md border border-border/60 p-3 text-sm text-muted-foreground">
                {t(
                  "Esta skill veio de um pacote com arquivos. Para mudar o texto, edite o pacote e envie o .zip de novo.",
                )}
              </p>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="skill-desc">{t("Descrição (aparece no índice do agente)")}</Label>
              <Input
                id="skill-desc"
                value={descricao}
                onChange={(e) => setDescricao(e.target.value)}
                maxLength={500}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="skill-kw">{t("Palavras-chave de ativação (separe por vírgula)")}</Label>
              <Input
                id="skill-kw"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                placeholder={t("consulta, horário, preço")}
              />
              <p className="text-xs text-muted-foreground">
                {t("A skill é carregada quando o cliente escreve uma destas palavras.")}
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="skill-body">{t("Corpo (o procedimento que o agente segue)")}</Label>
                <span className={excedeTeto ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                  {linhas}/{MAX_LINHAS} {t("linhas")}
                </span>
              </div>
              <Textarea
                id="skill-body"
                value={corpo}
                onChange={(e) => setCorpo(e.target.value)}
                className="min-h-[320px] font-mono text-xs"
                spellCheck={false}
              />
            </div>

            <div className="flex flex-col gap-2 rounded-md border border-border/60 p-3">
              <Label>{t("Histórico de versões")}</Label>
              {versoes.isLoading && (
                <p className="text-xs text-muted-foreground">{t("Carregando…")}</p>
              )}
              {versoes.data && versoes.data.length > 0 && (
                <ul className="flex flex-col gap-1">
                  {versoes.data.map((v) => (
                    <li key={v.id} className="flex items-center justify-between gap-2 text-xs">
                      <span>
                        {new Date(v.created_at).toLocaleString(tagDoIdioma, {
                          day: "2-digit",
                          month: "2-digit",
                          year: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                        {v.atual ? ` — ${t("em uso")}` : ""}
                      </span>
                      {!v.atual && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={restaurar.isPending}
                          onClick={() =>
                            restaurar.mutate(
                              { name: nome, versionId: v.id },
                              {
                                onSuccess: () => toast.success(t("Versão restaurada.")),
                                onError: (err) => showApiError(err),
                              },
                            )
                          }
                        >
                          {t("Restaurar")}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => aoMudarAberto(false)}>
            {t("Cancelar")}
          </Button>
          <Button
            onClick={salvarSkill}
            disabled={salvar.isPending || skill.isLoading || excedeTeto || veioDePacote}
          >
            {salvar.isPending ? t("Salvando…") : t("Salvar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
