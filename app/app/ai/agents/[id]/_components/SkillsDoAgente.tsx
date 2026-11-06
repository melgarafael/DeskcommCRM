"use client";

/**
 * QUAIS SKILLS ESTE ASSISTENTE USA (migration 9107).
 *
 * Até aqui toda skill da organização — e toda de plataforma, mesmo sem instalar —
 * entrava em todo agente: o índice ia no prompt de cada um e o corpo carregava
 * quando a conversa batia na palavra-chave. Uma skill de clínica entrou seis
 * vezes no agente de imóveis.
 *
 * O padrão continua sendo TODAS (`null` no banco), e é o que toda versão que já
 * existia tem: restringir é escolha explícita, desmarcando a primeira caixa. Ao
 * desmarcar, a lista começa com TODAS marcadas — sair do padrão não pode tirar
 * nenhuma skill do agente sem que alguém desmarque uma por uma.
 *
 * No molde de `BasesDoAgente`: nomeia o estado vazio (nenhuma skill marcada é
 * legítimo e precisa ser dito) e devolve à tela o nome marcado que não existe mais
 * (skill desinstalada ou renomeada), com o desmarcar a um clique — sem isso o
 * salvar recusaria e não haveria onde desmarcar.
 */
import * as React from "react";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import type { SkillDisponivel } from "@/lib/ai/skills/skills-do-agente";

interface Props {
  skills: SkillDisponivel[];
  /** `null` = todas (o padrão); `[]` = nenhuma. */
  value: string[] | null;
  onChange: (nomes: string[] | null) => void;
  disabled?: boolean;
}

export function SkillsDoAgente({ skills, value, onChange, disabled = false }: Props) {
  const t = useT();
  const todas = value === null;
  const marcadas = new Set(value ?? []);
  const inexistentes = (value ?? []).filter((nome) => !skills.some((s) => s.name === nome));

  function alternar(nome: string, marcada: boolean): void {
    const proxima = new Set(marcadas);
    if (marcada) proxima.add(nome);
    else proxima.delete(nome);
    onChange([...proxima]);
  }

  return (
    <Card className="space-y-3 p-4" data-testid="agente-skills">
      <div>
        <h3 className="text-sm font-medium">{t("Quais skills ele usa")}</h3>
        <p className="text-xs text-muted-foreground">
          {t(
            "Skills são roteiros para situações específicas, como objeção de preço ou agendamento. Ele só carrega uma skill quando a conversa pede.",
          )}
        </p>
      </div>

      <div className="flex items-center gap-2">
        {/* `input` nativo, como o BasesDoAgente ao lado: o repo não tem checkbox próprio. */}
        <input
          id="skills-todas"
          data-testid="skills-todas"
          type="checkbox"
          className="h-4 w-4 shrink-0 rounded-md border-border accent-primary"
          checked={todas}
          onChange={(e) => onChange(e.target.checked ? null : skills.map((s) => s.name))}
          disabled={disabled}
        />
        <Label htmlFor="skills-todas" className="text-sm font-normal">
          {t("Usar todas as skills da organização (padrão)")}
        </Label>
      </div>

      {todas ? (
        <p className="text-xs text-muted-foreground" data-testid="skills-todas-explicacao">
          {t("Toda skill instalada, inclusive as que você instalar depois, vale para este agente.")}
        </p>
      ) : (
        <>
          {skills.length === 0 && inexistentes.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="skills-sem-nenhuma-instalada">
              {t("Esta organização ainda não tem skill nenhuma.")}{" "}
              <Link
                href="/app/ai/skills"
                className="font-medium text-foreground underline underline-offset-4"
              >
                {t("Ver as skills")}
              </Link>
            </p>
          ) : (
            <div className="space-y-2" data-testid="skills-lista">
              {skills.map((s) => (
                <div key={s.name} className="flex items-start gap-2">
                  <input
                    id={`skill-${s.name}`}
                    data-testid={`skill-${s.name}`}
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 shrink-0 rounded-md border-border accent-primary"
                    checked={marcadas.has(s.name)}
                    onChange={(e) => alternar(s.name, e.target.checked)}
                    disabled={disabled}
                  />
                  <Label htmlFor={`skill-${s.name}`} className="text-sm font-normal">
                    <span className="font-mono text-xs">{s.name}</span>
                    {s.description ? (
                      <span className="ml-2 text-xs text-muted-foreground">{s.description}</span>
                    ) : null}
                  </Label>
                </div>
              ))}
              {inexistentes.map((nome) => (
                <div key={nome} className="flex items-start gap-2">
                  <input
                    id={`skill-${nome}`}
                    data-testid={`skill-${nome}`}
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 shrink-0 rounded-md border-border accent-primary"
                    checked
                    onChange={() => alternar(nome, false)}
                    disabled={disabled}
                  />
                  <Label htmlFor={`skill-${nome}`} className="text-sm font-normal">
                    <span className="font-mono text-xs">{nome}</span>
                    <span
                      data-testid={`skill-${nome}-inexistente`}
                      className="ml-2 text-xs font-medium text-warning-fg"
                    >
                      {t("marcada, mas não existe mais — desmarque para voltar a salvar")}
                    </span>
                  </Label>
                </div>
              ))}
            </div>
          )}

          {marcadas.size === 0 ? (
            <p data-testid="skills-nenhuma-marcada" className="text-xs text-warning-fg">
              {t("Nenhuma skill marcada: este agente não carrega skill nenhuma, nem as de plataforma. Só a que um roteiro de atendimento puxar continua valendo.")}
            </p>
          ) : null}

          <p className="text-xs text-muted-foreground" data-testid="skills-lista-propria-aviso">
            {t("Uma skill instalada depois NÃO chega a este agente: marque aqui quando instalar. A que um roteiro de atendimento puxar vale mesmo fora desta lista.")}
          </p>
        </>
      )}
    </Card>
  );
}
