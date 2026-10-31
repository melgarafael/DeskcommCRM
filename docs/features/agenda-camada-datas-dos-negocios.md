# Agenda — camada "Datas dos negócios"

A Agenda responde "o que está marcado". Esta camada acrescenta a outra pergunta de
quem trabalha com data: **quem embarca hoje e quem volta amanhã**. Ela lê os campos
de data do **negócio** — os mesmos que a aba Calendário do funil usa — e desenha o
negócio no dia de cada data, acima da grade.

## Como se usa

1. Na Agenda, o interruptor **Datas dos negócios** fica acima da grade. Ele nasce
   **desligado**: sem escolha, não há item e não há consulta.
2. Ligado, escolha o **funil** e o **campo de data**. Só aparecem funis que
   declaram campo de data do negócio; só aparecem campos do tipo *data* do escopo
   *negócio*.
3. Opcionalmente, escolha um **segundo campo** (por exemplo, o retorno). O negócio
   passa a aparecer também no dia desse campo.
4. Cada item mostra o título do negócio, o rótulo do campo ("Embarque",
   "Retorno"), o funil e a etapa. Clicar abre o negócio no funil, onde a data é
   editada.

## Limites, de propósito

- **Só leitura.** A camada não cria, move nem altera negócio, não ocupa horário
  livre, não entra em `crm_find_free_slots` e não gera lembrete.
- **Nada por padrão.** Nenhum campo é escolhido por heurística de nome
  (`data_inicio`, `data_fim`): a escolha é explícita, na tela.
- **Um item por dia.** Início e fim no mesmo dia viram uma ocorrência com os dois
  rótulos. Os dias do meio de um intervalo não entram: a camada marca datas, não
  ocupação.
- **Campo renomeado ou removido** deixa de valer: a camada esquece a escolha e
  volta a pedir o campo, com o motivo à vista (o servidor responde
  `campo_nao_e_data`).
- **Recorte = o que a grade desenha.** Dia, semana ou mês, no fuso da organização.
- A leitura usa a lista de funis e a visibilidade que a pessoa já tem no CRM; quem
  não enxerga o funil não enxerga a data.

## Living System Checklist

1. Entrada: `funisComCamposDeData` (`lib/agenda/datas-dos-negocios.ts`), alimentada
   pelo RSC da Agenda com os funis da organização.
2. Saída: `itensDaCamada` → `GET /api/v1/agenda/datas-dos-negocios` →
   `CamadaDatasDosNegocios` (`app/app/agenda/_components/`).
3. Registro: nenhum. A camada não escreve — sem auditoria, sem evento, sem fila.
4. Visibilidade: `requireRole("viewer", { resource: "crm_leads" })` + policy
   `crm_leads_select` → `fn_can_view_lead` (`supabase/baseline.sql`).
5. Porta: interruptor na própria Agenda (`data-testid="camada-datas-alternar"`),
   acima da grade.
6. Anti-morte: campo que sumiu responde `campo_nao_e_data` e a tela volta a pedir a
   escolha; falha de rede mostra motivo e não inventa item; lista vazia é dita como
   vazia.
7. Configuração: nenhuma nova. Os campos vêm do `settings.fields` do funil; nada de
   env, credencial ou migration.
8. Continuidade: não mexe em compromisso, histórico, remarcação nem ocupação do
   Google — a grade recebe exatamente a mesma lista de antes.
9. Retorno: o item leva ao negócio (`/app/pipelines/<funil>?lead=<id>`), que é onde
   a data é corrigida; a volta é a própria Agenda.
10. Prova: `tests/unit/datas-dos-negocios-na-agenda.test.ts`,
    `tests/unit/agenda-camada-datas-dos-negocios.test.tsx`,
    `tests/unit/agenda-camada-datas-desligada-e-igual.test.tsx` e
    `app/api/v1/agenda/datas-dos-negocios/route.test.ts`.
