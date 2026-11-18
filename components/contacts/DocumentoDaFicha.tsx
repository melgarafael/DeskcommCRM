"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { formatarCpf } from "@/lib/contacts/formatar-cpf";

/**
 * A linha do DOCUMENTO do titular na ficha do contato (CPF no Brasil, NIF em
 * Portugal).
 *
 * ═══ Por que existe ════════════════════════════════════════════════════════
 *
 * O documento era cadastrado e nunca mais visto: a ficha recebia só
 * `cpf_available`, e nenhuma tela pedia ao servidor para decifrar. O GET da
 * ficha já sabia decifrar — com o cabeçalho `x-decrypt-purpose`, para gerente ou
 * acima, auditando na RPC `decrypt_cpf` — mas ninguém mandava o cabeçalho.
 *
 * ═══ O que este componente NÃO faz ═════════════════════════════════════════
 *
 * Não recebe o número. O documento não vem no payload da ficha; o clique em
 * "Mostrar" é que pede, e quem decide é o servidor (organização, papel e
 * auditoria). O valor decifrado fica só no estado deste componente — fora do
 * cache do React Query de propósito, para não sobreviver à tela nem ser
 * reaproveitado por outra que não pediu.
 *
 * ═══ Os estados ════════════════════════════════════════════════════════════
 *
 *   sem documento → "—", como os outros campos vazios da ficha
 *   cadastrado    → "Cadastrado"; com "Mostrar" para gerente ou acima, e a
 *                   explicação para quem não pode ver
 *   verificando   → "Verificando permissão…"
 *   revelado      → o número (com máscara, no Brasil) e "Ocultar"
 *   negado        → o servidor recusou o papel (`cpf_decrypt_denied`)
 *   indisponivel  → falha de rede, RPC ausente, chave não semeada: dizer
 *                   "sem permissão" quando faltou conexão seria mentira
 */
type Estado = "oculto" | "verificando" | "revelado" | "negado" | "indisponivel";

/** O que o GET da ficha devolve, só a parte que interessa aqui. */
interface RespostaDaFicha {
  data?: { cpf_decrypted?: unknown; cpf_decrypt_denied?: unknown };
}

/**
 * O propósito gravado na auditoria (`decrypt_purpose`). Uma constante, não um
 * texto livre: é por ela que se responde depois "quantas vezes alguém abriu o
 * documento pela ficha".
 */
export const PROPOSITO_DA_FICHA = "ficha_do_contato";

interface Props {
  contatoId: string;
  /** `contact.cpf_available` — se a ficha tem documento gravado. */
  temDocumento: boolean;
  /** O nome do documento no país da organização (`perfil.documento.rotulo`). */
  rotulo: string;
  /** Gerente ou acima — a mesma régua do servidor (`getContactHandler`). */
  podeVer: boolean;
  /** Aplica a máscara de CPF. Só faz sentido na organização brasileira. */
  mascararComoCpf: boolean;
}

export function DocumentoDaFicha({
  contatoId,
  temDocumento,
  rotulo,
  podeVer,
  mascararComoCpf,
}: Props) {
  const t = useT();
  const [estado, setEstado] = useState<Estado>("oculto");
  const [valor, setValor] = useState<string | null>(null);

  const mostrar = async () => {
    setEstado("verificando");
    try {
      const resposta = await apiClient.get<RespostaDaFicha>(`/api/v1/contacts/${contatoId}`, {
        headers: { "x-decrypt-purpose": PROPOSITO_DA_FICHA },
      });
      const decifrado = resposta.data?.cpf_decrypted;
      if (typeof decifrado === "string" && decifrado.trim()) {
        setValor(mascararComoCpf ? formatarCpf(decifrado) : decifrado.trim());
        setEstado("revelado");
        return;
      }
      setEstado(resposta.data?.cpf_decrypt_denied === true ? "negado" : "indisponivel");
    } catch {
      setEstado("indisponivel");
    }
  };

  const ocultar = () => {
    setValor(null);
    setEstado("oculto");
  };

  return (
    <div>
      <dt className="text-xs uppercase text-muted-foreground">{rotulo}</dt>
      <dd className="mt-1">
        {!temDocumento ? (
          "—"
        ) : estado === "revelado" && valor ? (
          <span className="flex flex-wrap items-center gap-2">
            <span data-testid="documento-revelado" className="tabular-nums">
              {valor}
            </span>
            <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={ocultar}>
              {t("Ocultar")}
            </Button>
          </span>
        ) : (
          <span className="flex flex-wrap items-center gap-2">
            <span>{t("Cadastrado")}</span>
            {podeVer && estado !== "verificando" && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={() => void mostrar()}
              >
                {t("Mostrar")}
              </Button>
            )}
          </span>
        )}
      </dd>
      {temDocumento && estado === "verificando" && (
        <p role="status" className="mt-0.5 text-xs text-muted-foreground">
          {t("Verificando permissão…")}
        </p>
      )}
      {temDocumento && estado === "negado" && (
        <p role="status" className="mt-0.5 text-xs text-muted-foreground">
          {t("Você não tem permissão para ver este documento.")}
        </p>
      )}
      {temDocumento && estado === "indisponivel" && (
        <p role="status" className="mt-0.5 text-xs text-muted-foreground">
          {t("Não foi possível mostrar agora. Tente de novo.")}
        </p>
      )}
      {temDocumento && !podeVer && (
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("Só gerente ou administrador vê o número.")}
        </p>
      )}
    </div>
  );
}
