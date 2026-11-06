"use client";
import { useRef } from "react";

import { useT } from "@/hooks/i18n/useT";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePreenchimentoPorCep } from "@/hooks/contacts/usePreenchimentoPorCep";
import {
  enderecoDoCep,
  type CampoDoEndereco,
  type EnderecoDoContato,
} from "@/lib/contacts/endereco-por-cep";

interface Props {
  /**
   * Prefixo dos `id`/`htmlFor` — a ficha usa `ec` e o cadastro `nc`. Sem ele os
   * dois diálogos abertos ao mesmo tempo (o cadastro abre por cima da ficha em
   * vários fluxos) teriam `id="zip"` duplicado, e o `<label>` do segundo
   * apontaria para o campo do primeiro.
   */
  idPrefix: string;
  valores: EnderecoDoContato;
  /** Grava um campo no formulário dono — RHF na ficha, estado local no cadastro. */
  onCampo: (campo: CampoDoEndereco, valor: string) => void;
  /**
   * A consulta de CEP é coisa do Brasil: a BrasilAPI não conhece código postal
   * de outro país, e o aviso de 8 dígitos seria falso. `false` deixa o campo como
   * texto livre.
   */
  consultarCep: boolean;
  disabled?: boolean;
}

/**
 * Os sete campos do endereço da pessoa física, com o CEP preenchendo o resto
 * (#3494, fatia 2).
 *
 * ─── Por que um componente, e não o bloco copiado ──────────────────────────
 *
 * A ficha ganhou estes campos no #3670 e o cadastro não tinha nenhum: duas
 * listas iguais seriam duas telas para corrigir a cada campo novo. O componente
 * é dono do comportamento (CEP → logradouro/bairro/cidade/UF) e recebe os
 * valores por prop, então cada formulário continua com a sua fonte de verdade.
 *
 * ─── O que o CEP NÃO toca ──────────────────────────────────────────────────
 *
 * `number` e `complement` nunca vêm da BrasilAPI: número é do imóvel e o
 * complemento é de quem entrega. A regra mora em `comEnderecoDoCep`
 * (`lib/contacts/endereco-por-cep.ts`), testada sem dublê.
 *
 * ─── CEP inválido não impede salvar ────────────────────────────────────────
 *
 * Campo vazio, 7 dígitos ou letra só NÃO consultam: nada aqui bloqueia o
 * botão de salvar nem valida o campo. O produto atende fora do Brasil e a
 * coluna é texto livre — CEP é erro de preenchimento, não de cadastro.
 *
 * ─── Só o CEP que MUDOU consulta ───────────────────────────────────────────
 *
 * A resposta sobrescreve logradouro, bairro, cidade e UF. Na ficha, só passar
 * pelo campo (clicar e Tab) consultava o CEP já gravado e trocava o que alguém
 * digitou à mão, marcando o formulário como alterado. Sair com o mesmo valor com
 * que se entrou não faz nada — nem depois de falha: "preencha à mão" é o que a
 * tela acabou de pedir, e uma nova consulta apagaria esse preenchimento.
 */
export function CamposDeEndereco({
  idPrefix,
  valores,
  onCampo,
  consultarCep,
  disabled = false,
}: Props) {
  const t = useT();
  const { estado, buscar, cancelar } = usePreenchimentoPorCep();
  const cepAoEntrar = useRef("");

  async function aoSairDoCep(): Promise<void> {
    if (!consultarCep || valores.zip_code === cepAoEntrar.current) return;
    // Sem nada digitado não há o que consultar nem o que avisar: só quem digitou
    // um CEP incompleto recebe a dica.
    if (!valores.zip_code.trim()) return;
    const resposta = await buscar(valores.zip_code);
    if (!resposta) return;
    for (const [campo, valor] of Object.entries(enderecoDoCep(resposta))) {
      onCampo(campo as CampoDoEndereco, valor);
    }
  }

  const aviso =
    estado === "buscando"
      ? t("Buscando o CEP…")
      : estado === "invalido"
        ? t("CEP deve ter 8 dígitos.")
        : estado === "nao_encontrado"
          ? t("CEP não encontrado.")
          : estado === "falhou"
            ? t("Não foi possível consultar o CEP agora. Preencha o endereço à mão.")
            : estado === "preenchido"
              ? t("Endereço preenchido pelo CEP.")
              : null;
  const avisoEhErro = estado === "nao_encontrado" || estado === "falhou";

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-zip`}>{t("CEP")}</Label>
          <Input
            id={`${idPrefix}-zip`}
            inputMode="numeric"
            autoComplete="postal-code"
            disabled={disabled}
            value={valores.zip_code}
            onChange={(e) => {
              cancelar();
              onCampo("zip_code", e.target.value);
            }}
            onFocus={() => {
              cepAoEntrar.current = valores.zip_code;
            }}
            onBlur={() => void aoSairDoCep()}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-state`}>{t("UF")}</Label>
          <Input
            id={`${idPrefix}-state`}
            disabled={disabled}
            value={valores.state}
            onChange={(e) => onCampo("state", e.target.value)}
          />
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor={`${idPrefix}-street`}>{t("Logradouro")}</Label>
          <Input
            id={`${idPrefix}-street`}
            autoComplete="address-line1"
            disabled={disabled}
            value={valores.street}
            onChange={(e) => onCampo("street", e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-number`}>{t("Número")}</Label>
          <Input
            id={`${idPrefix}-number`}
            autoComplete="address-line2"
            disabled={disabled}
            value={valores.number}
            onChange={(e) => onCampo("number", e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-complement`}>{t("Complemento")}</Label>
          <Input
            id={`${idPrefix}-complement`}
            disabled={disabled}
            value={valores.complement}
            onChange={(e) => onCampo("complement", e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-district`}>{t("Bairro")}</Label>
          <Input
            id={`${idPrefix}-district`}
            disabled={disabled}
            value={valores.district}
            onChange={(e) => onCampo("district", e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-city`}>{t("Cidade")}</Label>
          <Input
            id={`${idPrefix}-city`}
            autoComplete="address-level2"
            disabled={disabled}
            value={valores.city}
            onChange={(e) => onCampo("city", e.target.value)}
          />
        </div>
      </div>
      {aviso && (
        <p
          role={avisoEhErro ? "alert" : "status"}
          className={avisoEhErro ? "text-sm text-error-fg" : "text-sm text-text-muted"}
        >
          {aviso}
        </p>
      )}
    </div>
  );
}
