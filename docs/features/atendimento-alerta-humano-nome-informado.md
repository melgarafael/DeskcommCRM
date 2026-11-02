# Aviso de transferência humana e nome informado no atendimento

Esta contribuição acrescenta duas capacidades ao atendimento existente. O alerta reutiliza o
cadastro do número interno e o barramento de eventos. O preenchimento do nome reutiliza a ferramenta
de proposta de dados do contato. Não adiciona serviço, dependência, variável de ambiente ou migration.

Destino: **núcleo**. São capacidades gerais de continuidade e cadastro, sem regra de nicho ou
integração particular. Com ambas desligadas, o atendimento, a Central e a revisão de propostas
continuam disponíveis.

## Configurar o aviso interno

1. Abra **Central de alertas → Aviso no WhatsApp** (`/app/ai/cases/avisos`).
2. Configure uma conexão que aceite mensagens livres e o número da equipe, e ligue o aviso.
3. O mesmo cadastro passa a valer para novas transferências humanas. Se já estava ligado, as
   transferências também passam a avisar esse destinatário. Logo abaixo do formulário, a opção
   **Avisar também nas transferências para atendimento humano** (ligada por padrão, como o aviso de
   Propostas) tira as transferências do número sem desligar os avisos de casos. Ela mora em
   `settings.crm.avisar_transferencia_no_whatsapp`; só o booleano `false` desliga.
4. Consulte o resultado no item da transferência na Central. Abra a conversa pelo link do aviso
   e responda pelo CRM; responder ao aviso interno não envia uma resposta ao cliente.

O texto externo é genérico: informa que um atendimento precisa de uma pessoa e inclui o link
autenticado para a conversa. Não inclui nome, motivo livre, resumo nem transcrição. A origem do
link vem da URL pública da instalação, exige HTTPS e descarta caminho, query e fragmento.

CONFIRMADO pelo código:

- `performHumanHandoff` preserva um UUID enquanto a conversa permanece silenciada. A Central e
  o evento `ai.handoff_aviso_solicitado` são gravados no mesmo statement; sem opt-in, ou com as
  transferências desligadas, só a Central.
- O marcador na conversa evita solicitar novamente o mesmo episódio mesmo após a poda do evento.
  Após devolver ao automático, uma nova transferência pode iniciar outro episódio.
- O consumidor `escalacao-aviso-handoff.v1` roda pelo worker. Na requisição HTTP ele adia; na
  organização suspensa ou inoperante ele pula, conforme o contrato do dispatcher.
- Antes do transporte, relê a configuração, a opção das transferências (desligada no meio do
  caminho cancela com `desligado_em_transferencias`) e o episódio; confere organização, contato,
  anonimização, canal, capacidade, destino circular e pacing existentes. Canal offline e pacing
  adiam sem reservar uma tentativa. Evento com mais de 24 horas é cancelado.
- Uma reserva persistida por compare-and-set permite uma única tentativa externa. Timeout,
  falta de recibo e reserva interrompida viram resultado incerto, sem repetição automática.
  A reserva antiga não libera outra chamada. Falha ao persistir um resultado não permite repetir
  a tentativa. Um aceite tardio pode esclarecer incerteza; o inverso não rebaixa o aceite.
- O recibo é acrescentado ao corpo da Central preservando adendos concorrentes. “Aceito pelo
  canal” não afirma que a equipe recebeu ou leu. O histórico de entregas de **casos** continua
  separado: o recibo da transferência aparece no próprio item da Central.
- A revalidação ocorre antes da reserva; uma chamada já iniciada pode concluir depois de um
  desligamento. A equipe continua responsável por acompanhar a Central se o aviso não sair.

## Configurar o nome informado

1. Com uma conta autorizada a administrar a empresa, abra **Configurações → Distribuição de
   atendimento** (`/app/settings/atendimento`).
2. Ligue **Preencher o nome que o cliente informa no atendimento**. A opção ausente é desligada.
3. No agente que atende, habilite a capacidade **Anotar dado que o cliente informou**
   (`crm_propose_contact_field`). Ligar apenas o interruptor não obriga o modelo a chamar a ferramenta.
4. Confira a ficha do contato no CRM. Para voltar ao comportamento de proposta, desligue a opção;
   isso não apaga os nomes que já entraram.

CONFIRMADO pelo código:

- A seleção semântica continua no assistente: ele deve identificar o nome do próprio cliente na
  mensagem atual. O servidor não extrai nome por substring nem usa um trecho inventado pelo modelo.
- A exceção exige um `inbound_turn` real, com organização, contato, job, mensagem, conversa e
  revisão amarrados pelo contexto do runtime. MCP externo, preview sem job, Operador e follow-up
  continuam no caminho de proposta.
- O servidor relê a mensagem inbound de texto e compara o valor ao corpo inteiro ou a uma
  apresentação ancorada, como “Meu nome é Maria Silva”. Exige pelo menos duas partes, limita
  tamanho e caracteres, e recusa conteúdo misto e nomes de terceiros dentro de frases.
- A escrita exige nome vazio, mesma mensagem e revisão, opção ainda ligada e contato elegível.
  Conversa terminal, grupo, anonimização, bloqueio, mescla, contato pessoal, responsável humano,
  `force_human` e pausa humana impedem essa aplicação automática. `guardServiceEffect` é chamado
  antes de escrever, e o SQL revalida o escopo e o estado na própria escrita.
- Atualização e `contact.field_auto_applied` em `api_audit_log` ficam no mesmo statement. Duas
  chamadas concorrentes não substituem um nome confirmado pela equipe. O ajuste da opção gera
  `crm.nome_informado_alterado`, com suporte somente leitura, autorização, MFA e CAS de settings.
- Nome já preenchido, e-mail e nascimento continuam exigindo revisão. O apelido do WhatsApp é
  separado. As regras anteriores para telefone vazio são preservadas. Só o retorno
  `aplicado_automaticamente` autoriza o modelo a dizer que o dado foi salvo.

Limites: correspondência literal **não autentica identidade e não prova que o texto é um nome**.
Se o modelo selecionar incorretamente “Tudo bem” como nome, a igualdade por si só não o rejeita;
há um caso explícito para esse limite na suíte. A gravação muda a ficha, emite auditoria e
deixa a linha `contact_field_auto_applied` (campo `name`) na timeline do contato, como o telefone
aplicado — quando o contato tem um negócio aberto; sem negócio, só a auditoria registra.

## Ligações do sistema

| Pergunta | Artefato concreto |
| --- | --- |
| Entrada | `human-handoff.ts` e o contexto inbound de `crm_propose_contact_field` |
| Saída | Transporte do aviso interno; `contacts.name`; revisão em `proporDadoDoContato` |
| Registro | Evento e metadata da reserva, recibo em `agent_inbox_items`, `api_audit_log` |
| Tela | Central de alertas e link para o Inbox; ficha do contato e linha na timeline do nome aplicado |
| Porta | Destinos existentes `/app/ai/cases/avisos` e `/app/settings/atendimento` no catálogo de navegação |
| Anti-morte | Central persiste mesmo sem aviso; resultado incerto exige conferência humana; proposta continua no fluxo existente |
| Configuração | `AvisoNoWhatsApp`, `AvisoDeTransferencia`, `NomeInformado` e ações `definirNomeInformado` e `definirAvisoDeTransferencia` |
| Continuidade | Handoff conserva o contexto existente; o aviso só leva à conversa; retorno ao automático delimita novo episódio |
| Retorno | Recibo incerto muda a ação da equipe; ficha pode ser corrigida e opção desligada. Não há aprendizado automático novo |
| Mapa | `docs/architecture/atendimento-alerta-humano-nome-informado.architecture.json` |

## Verificação e fronteira da prova

As suites `lib/escalacao/aviso-de-handoff.test.ts` e `lib/contacts/nome-informado.test.ts`
rodam no Vitest padrão (`pnpm test:unit`). Cobrem reserva, concorrência, replay, timeout,
interrupção simulada, recibo concorrente, escopo, opt-in, mensagem original e CAS. As fixtures
de banco e transporte são sintéticas: não comprovam SQL executado, RLS, múltiplos processos,
queda real, entrega WhatsApp nem classificação por um modelo real.

`tests/invariants/nome-informado-e-aviso-de-handoff.test.ts` (`pnpm test:db`) executa o SQL novo
em Postgres real: nome preenchido nunca sobrescrito, id de outra organização sem efeito, gravação
única com uma auditoria, um evento por episódio mesmo depois da poda do `event_log`, novo episódio
após retomar o automático, e nenhum evento com as transferências desligadas.

`tests/unit/aviso-de-caso-tela.test.tsx` monta o componente real com hooks simulados e mede o
texto explicativo. `tests/unit/dispatcher-org-parada.test.ts` mede o registro e a classificação
do consumidor. Isso não substitui a jornada pela tela em instalação fresca, a prova em par do
agente e ferramenta ou os invariantes de banco; o corpo do PR registra o que foi executado.
