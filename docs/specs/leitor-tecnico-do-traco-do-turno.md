# Retenção e leitor técnico do traço do turno

Entrega parcial da [issue #3201](https://github.com/melgarafael/DeskcommCRM/issues/3201), originada no PR #3516 de @webtecnica. A decisão 218 aprovou reutilizar a configuração da telemetria e integrar primeiro a API. A tela, sua localização e sua prova visual continuam pendentes na issue; esta entrega não a encerra.

## Retenção

`AI_TELEMETRY_RETENTION_DAYS` já existe: padrão 400 dias, piso 100, validação por `interpretarRetencao`. Não há variável nova. A migration inédita do contribuidor foi reconciliada para `20261027013000_9021_o_traco_do_turno_tem_prazo.sql`; o corpo da função permanece igual à fonte. A migration aplicada 0721 e seu bloco de tabela/permissões permanecem intactos, embora o bloco do baseline tenha sido deslocado pela contribuição para existir antes da nova função.

`fn_expurgar_traco_do_turno_vencido` recebe somente prazo e tamanho do lote, sem seletor de organização ou linha. O piso está no corpo; só `service_role` executa. O cron reutiliza o laço existente, isola falhas por poda e audita quando houve efeito. A limpeza é por `created_at`, não por `updated_at`.

## GET `/api/v1/ai/turn-traces`

Autenticação por cookie, papel `manager` ou superior. A organização vem do guard e da sessão, com filtro explícito na consulta e RLS. Um parâmetro `organization_id` não redireciona a leitura. A RLS herdada da 0721 isola memberships; a restrição de gerente é desta API, não uma nova restrição global do armazenamento.

| Filtro                                    | Contrato                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `conversation_id`, `contact_id`, `job_id` | UUID opcional                                                           |
| `status`                                  | `completed`, `failed` ou `aborted`                                      |
| `tipo`                                    | `real` ou `previa`                                                      |
| `desde`, `ate`                            | Datas existentes no calendário, `YYYY-MM-DD`, dias civis UTC inclusivos |
| `limite`                                  | Inteiro entre 1 e 200; padrão 50                                        |

Sem datas, consulta sete dias civis terminando hoje em UTC. Com `ate` omitido, o fim é hoje. Datas impossíveis ou início posterior ao fim retornam 422 canônico antes da consulta dos traços.

A consulta usa início inclusivo e o início do dia seguinte como fim exclusivo, preservando a precisão nativa dos timestamps no fim do dia. O início nunca recua além de `agora - retenção`, inclusive quando o corte cai no meio do dia. Um pedido inteiramente anterior ao corte retorna vazio sem consultar backlog vencido.

A resposta mantém `tracos`, `total`, `janela`, `retencao_dias`, `truncado_pela_retencao` e `motivo_do_vazio`, acrescentando `corte_retencao_em` com o instante ISO usado na leitura. `total` é a quantidade devolvida, limitada por `limite`; não é uma contagem global. `janela.de`/`ate` são datas UTC, e `dias` conta os dias civis alcançados. Uma janela sem interseção tem zero dias e datas normalizadas no dia do corte.

| `motivo_do_vazio`        | Significado                           |
| ------------------------ | ------------------------------------- |
| `null`                   | Há recibos na resposta                |
| `nenhum_turno_na_janela` | Nenhum resultado na parte consultável |
| `fora_da_retencao`       | O pedido inteiro precede a retenção   |

Não há inferência de que linhas existiram ou foram apagadas. O enum não usa `purgado_pela_retencao`.

## Conteúdo do recibo

O leitor não seleciona `error_message`. Projeta campos individualmente; não espalha a linha nem seus JSONs. Mantém IDs, estado, contadores, custo, latência, datas e identificadores técnicos de provedor/modelo. Identificadores rejeitados pelo formato, pelos padrões compartilhados de PII ou por prefixos de chave ficam nulos; isto não promete anonimizar todo identificador configurável arbitrário.

Erros são códigos canônicos ou nomes técnicos conhecidos de exceções; valores desconhecidos tornam-se `internal_error`. Motivos de aborto são um conjunto fechado; os demais ficam nulos. Erros de consulta e exceções inesperadas retornam `fail` genérico, sem ecoar mensagens do banco.

`ferramentas` devolve apenas nome reconhecido do catálogo/nativo, estado conhecido, código técnico de erro e duração numérica. Nomes/estados desconhecidos ficam nulos. Não devolve argumentos, texto livre de erro ou chaves extras. `skills` devolve somente `versao_id`; `kb_sources`, somente IDs/versão, hash hexadecimal e o indicador `ligada`.

A gravação legada pode conter mensagens livres e não foi reescrita nesta entrega. Esta projeção protege o novo leitor; não anuncia higienização retroativa, mudança de RLS ou nova cascata LGPD.

## Verificação

Testes novos reproduzem datas inválidas/invertidas, fronteira no meio do dia, backlog vencido e conteúdo pessoal/segredo sintéticos nos erros e JSONs. O invariante autoral permanece byte a byte igual à fonte; provas adicionais usam arquivo próprio.

O [recibo de banco e tipos](../../evidence/tracos-3516/typegen-e-banco.json) registra o baseline aplicado em instalação e atualização com erro alto, dois brutos iguais do CLI 2.122.0 e cópia integral após formatação das duas saídas. No PG17.11, os dez casos autorais e três adicionais passaram: isolamento entre dois tenants, fronteira SQL antes/igual/depois do corte e conteúdo pessoal sintético realmente guardado no legado sem saída pelo recibo. Todos os contratos da main permanecem idênticos; os tipos acrescentam somente a função de expurgo. Contêiner e porta próprios foram removidos.

A main `790b592fbaa79ebf682625637d752aff368ad94d` foi incorporada depois da bancada local. Sua migration 9017 altera o corpo de `fn_conversation_assign`, mantendo assinatura, retorno e os tipos da main idênticos aos da base anterior. O arquivo inteiro gerado continua válido para esse contrato. **A prova local de instalação/atualização permanece restrita ao hash anterior declarado no recibo; o baseline integrado será provado pelos checks de banco do head final.** Não foi repetida a bancada para uma interface inalterada.

A prova HTTP entre dois tenants segue pendente do CI oficial. A coleção local do Playwright prepara um caso com sessões reais de gerente A/B, viewer e anônimo; coleção não é execução do endpoint nem prova de tela. Nenhuma captura visual é alegada nesta fatia de API.
