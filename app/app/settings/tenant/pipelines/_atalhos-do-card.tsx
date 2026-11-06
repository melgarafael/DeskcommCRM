"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import {
  ICONES_DE_ATALHO,
  MAX_ATALHOS,
  motivoDaRecusaDoModelo,
  TAMANHO_MAXIMO_DO_ROTULO,
  type AtalhoDoCard,
  type IconeDeAtalho,
  type RecusaDoModelo,
} from "@/lib/leads/atalhos-do-card";
import { Plus, Trash } from "@/lib/ui/icons";

/**
 * O CADASTRO DOS ATALHOS DO CARD (issue #3487) — Configurações › Funis.
 *
 * ─── Por que este arquivo é separado da tela ────────────────────────────────
 *
 * `_client.tsx` já passa de 1.500 linhas; a tela de funis não precisa de mais
 * 120. Aqui ficam só os campos e a marcação do erro; o ESTADO vive no editor do
 * funil, junto dos outros ajustes, porque o "Salvar" é UM só — e um atalho
 * salvo por um botão diferente do resto do formulário é a receita para metade
 * das mudanças ir embora sem ninguém notar.
 *
 * ─── O erro aparece NA LINHA, antes de salvar ───────────────────────────────
 *
 * A regra (`modeloAceito`) é a mesma da gravação e da renderização; aqui ela é
 * aplicada enquanto a pessoa digita. Sem isso o `javascript:` digitado por
 * engano viraria "Erro: validation_failed" no toast — uma frase que não diz
 * qual dos seis campos está errado nem por quê.
 *
 * ─── Por que o `t` entra por PARÂMETRO ─────────────────────────────────────
 *
 * A chave de tradução é o texto em português, e o guarda de espanhol varre o AST
 * procurando `t("…")` com literal. `t(fraseDaRecusa(recusa))` seria uma chave
 * dinâmica — invisível para o guarda e impossível de traduzir sem adivinhar. As
 * frases moram nas funções abaixo, cada uma com o seu literal, do mesmo jeito
 * que `rotuloDoTipo` (`lib/schemas/rotulos-do-campo`) faz na tela de campos.
 */

type Tradutor = (texto: string) => string;

function fraseDaRecusa(recusa: RecusaDoModelo, t: Tradutor): string {
  switch (recusa) {
    case "vazio":
      return t("Informe o endereço do atalho.");
    case "longo":
      return t("O endereço é longo demais.");
    case "invisivel":
      return t("O endereço tem caractere invisível.");
    case "sem_esquema":
      return t("Comece com tel:, http:// ou https://.");
    case "esquema_proibido":
      return t("Só tel:, http:// e https:// são aceitos.");
    case "sem_destino":
      return t("Falta o que vem depois do esquema.");
    case "sem_barras":
      return t("Depois do esquema, escreva // e o endereço.");
    case "marcador_no_dominio":
      return t("O domínio tem de ser fixo: use marcadores só depois da primeira /.");
  }
  // Inalcançável: o switch cobre a união inteira. Existe para o dia em que um
  // código novo entrar em `RecusaDoModelo` sem frase — aí o TypeScript acusa
  // aqui, em vez de a tela mostrar `undefined`.
  return "";
}

function rotuloDoIcone(icone: IconeDeAtalho, t: Tradutor): string {
  switch (icone) {
    case "telefone":
      return t("Telefone");
    case "carrinho":
      return t("Carrinho");
    case "link":
      return t("Link");
    case "boleto":
      return t("Boleto");
    case "documento":
      return t("Documento");
    case "mapa":
      return t("Mapa");
    case "email":
      return t("E-mail");
    case "site":
      return t("Site");
  }
  return "";
}

export function EditorDeAtalhos({
  valor,
  onChange,
  podeEditar = true,
}: {
  valor: AtalhoDoCard[];
  onChange: (proximo: AtalhoDoCard[]) => void;
  podeEditar?: boolean;
}) {
  const t = useT();
  const cheio = valor.length >= MAX_ATALHOS;

  /**
   * Troca UM campo da linha. O `Patch` é tipado, e não um `keyof AtalhoDoCard`
   * com valor `string`: o ícone é uma UNIÃO fechada (`IconeDeAtalho`), e passar
   * o nome do campo + texto solto faria o TypeScript aceitar `icone: "foguete"`
   * — exatamente o valor que a gravação recusa depois.
   */
  function trocar(indice: number, patch: Partial<AtalhoDoCard>) {
    const atual = valor[indice];
    if (!atual) return;
    const proximo = [...valor];
    proximo[indice] = { ...atual, ...patch };
    onChange(proximo);
  }

  return (
    <div className="space-y-2" data-testid="editor-de-atalhos">
      <Label className="text-xs">{t("Atalhos do card")}</Label>
      <p className="text-xs text-muted-foreground">
        {t(
          "Botões no card do negócio que abrem outro sistema com o dado do cliente já preenchido. Aceitam tel:, http:// e https://. Marcadores: {{telefone}}, {{nome}}, {{primeiro_nome}}, {{email}} e {{documento}}; campos personalizados entram como {{chave}}, {{lead.chave}} ou {{contact.chave}}.",
        )}
      </p>

      {valor.map((atalho, i) => {
        const recusa = motivoDaRecusaDoModelo(atalho.url);
        return (
          <div
            key={`atalho-${i}`}
            className="grid gap-2 rounded-md border border-border p-2 lg:grid-cols-[1fr_9rem_2fr_auto]"
            data-testid={`atalho-${i}`}
          >
            <Input
              aria-label={`${t("Rótulo do atalho")} ${i + 1}`}
              placeholder={t("Rótulo (Ligar)")}
              maxLength={TAMANHO_MAXIMO_DO_ROTULO}
              value={atalho.rotulo}
              disabled={!podeEditar}
              onChange={(e) => trocar(i, { rotulo: e.target.value })}
            />
            <Select
              value={atalho.icone}
              disabled={!podeEditar}
              onValueChange={(icone) => trocar(i, { icone: icone as IconeDeAtalho })}
            >
              <SelectTrigger aria-label={`${t("Ícone do atalho")} ${i + 1}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ICONES_DE_ATALHO.map((icone) => (
                  <SelectItem key={icone} value={icone}>
                    {rotuloDoIcone(icone, t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              aria-label={`${t("Endereço do atalho")} ${i + 1}`}
              placeholder={t("tel:{{telefone}} ou https://…?cliente={{erp_id}}")}
              value={atalho.url}
              disabled={!podeEditar}
              aria-invalid={recusa !== null}
              onChange={(e) => trocar(i, { url: e.target.value })}
            />
            <button
              type="button"
              aria-label={`${t("Remover atalho")} ${atalho.rotulo || i + 1}`}
              className="justify-self-start rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/10 disabled:opacity-50"
              disabled={!podeEditar}
              onClick={() => onChange(valor.filter((_, j) => j !== i))}
            >
              <Trash size={12} weight="regular" aria-hidden />
            </button>
            {recusa !== null && (
              <p className="text-xs text-danger-fill lg:col-span-4" role="status">
                {fraseDaRecusa(recusa, t)}
              </p>
            )}
          </div>
        );
      })}

      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/10 disabled:opacity-50"
        disabled={!podeEditar || cheio}
        onClick={() => onChange([...valor, { rotulo: "", icone: "link", url: "" }])}
      >
        <Plus size={12} weight="regular" aria-hidden />
        {t("Adicionar atalho")}
      </button>
      {cheio && (
        <p className="text-xs text-muted-foreground">
          {t("O limite é de seis atalhos por funil.")}
        </p>
      )}
    </div>
  );
}
