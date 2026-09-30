# Prova do contexto do roteador com o Jev real

Validação em 29/09/2026 (America/Sao_Paulo), 30/09 em UTC. Melhoria instalada na instância existente, autorizada pelo operador como instalação piloto. Nenhum ambiente separado foi criado para esta rodada.

## Versões e procedência

- Código do PR: `32b9cd6cae86f224640ee50d191247c25f07da93`.
- Instalação: v1.58.1 com patches de marca existentes, antes em `9c958509de3a4772e66d5b07ff345fa7095e0446`; melhoria incorporada em `a4be5d237512678ee9c9d2cea7967a5e829890d8`.
- Imagens do app, worker e scheduler publicadas pelo [workflow do fork](https://github.com/vitorlacerdadigital/DeskcommCRM/actions/runs/36655632034), fixadas por digest. Os oito arquivos executáveis envolvidos são idênticos aos do PR: [hashes SHA-256](source-hashes.json), conferidos no worker instalado.
- App, worker e scheduler saudáveis; endpoint público de saúde confirmou a revisão `a4be5d2` e conectividade com banco, Redis e canal. Backup de banco/configuração/sessões e reversão dos ponteiros preparados antes da troca. Sem migration.
- Jev `jev-1.13.0`, API real TypeSafe, chave existente da organização; classificador convencional real Anthropic `claude-sonnet-5`. Nenhuma resposta de modelo foi simulada nesta rodada.

## Classificação: oito casos definidos antes da comparação

Mesmas intenções, descrições, exemplos e mensagens atuais nas duas rodadas. Antes: adaptador instalado anterior, que enviava somente a mensagem atual. Depois: novo adaptador com autorização específica, até quatro mensagens anteriores e mensagem atual separada. Chamada real pelo `consultarJevNoRoteador`; o `fetchImpl` apenas registrou o corpo enviado e encaminhou a requisição ao fornecedor. Credenciais não foram capturadas.

O esperado está fixado nos arquivos de casos. “Nenhuma” é a resposta correta para a pergunta fora do escopo. As porcentagens dentro da tabela são probabilidades retornadas pelo Jev, **não** taxas de acerto. Para as intenções casadas, o limiar configurado era 60%.

| Mensagem atual | Esperado pelo contexto | Jev antes | Jev com histórico |
|---|---|---|---|
| Quero me matricular na academia. | Quer se matricular | Quer se matricular (100%) | Quer se matricular (100%) |
| Sim | Visita ou aula experimental | Nenhuma (83%) | Visita ou aula experimental (99%) |
| Amanhã | Visita ou aula experimental | Nenhuma (78%) | Visita ou aula experimental (97%) |
| E o anual? | Planos e valores | Planos e valores (96%) | Planos e valores (100%) |
| De manhã | Modalidades e horários | Modalidades e horários (71%) | Modalidades e horários (99%) |
| Agora quero saber quais os horários da hidroginástica. | Modalidades e horários | Modalidades e horários (100%) | Modalidades e horários (100%) |
| Quero sim | Quer se matricular | Nenhuma (58%) | Quer se matricular (100%) |
| Qual a capital da Noruega? | Nenhuma | Nenhuma (96%) | Nenhuma (98%) |

- Jev: **5/8 (62,5%) antes → 8/8 (100%) depois**, nesta amostra. O classificador convencional, também com contexto, acertou 8/8.
- Mediana da latência reportada pelo cliente Jev: **277 → 295,5 ms**. Isso não mede a duração completa do turno e não inclui toda a resolução da credencial.
- Tokens de entrada Jev, oito chamadas: **6.078 → 6.966** (+14,6%). Pelo preço versionado no CRM de US$ 0,042/milhão de entrada, saída zero, estimativa total Jev: **US$ 0,000255276 → US$ 0,000292572**. É estimativa do catálogo, não conferência da fatura. A cobrança do classificador convencional continua adicional.
- A amostra é pequena, sintética, com uma execução por condição: não estima acurácia geral, conversão comercial ou ganho estatisticamente comprovado. As cinco intenções do roteador existente apontam ao mesmo agente; o resultado acima mede intenção, não melhora entre destinos distintos.

Dados sem credenciais ou ids de clientes: [antes](antes.json), [depois](depois.json).

## Leitura pelo fluxo real do turno

`resolveConversationTurn` foi executado dentro do worker instalado, com o banco da instância e os dois fornecedores reais. Seis mensagens sintéticas foram inseridas em uma transação: uma fora da janela, quatro anteriores e a atual “Sim”. O Jev recebeu exatamente as quatro anteriores, em ordem, com autores, e a atual separada. A mensagem fora da janela não saiu; telefone e e-mail fictícios foram substituídos por `[PHONE]` e `[EMAIL]`.

A primeira execução revelou uma condição anterior da instalação: o agente configurado no roteador estava sem `published_version_id`; a decisão da intenção ocorreu, mas o resolvedor caiu em `no_match`, sem agente publicado. O teste da tela lista o agente cadastrado, portanto **seu resultado sozinho não prova que esse agente possa atender**.

Para verificar a seleção completa, a mesma transação recebeu um agente sintético publicado ligado somente à intenção “Visita ou aula experimental”. A chamada real retornou `classified`, essa intenção, confiança 0,99 e configuração publicada. A observação registrou estado `decidindo`, concordância do agente e `origem_da_escolha=jev`. O classificador convencional também foi chamado com sucesso.

Tudo que era fixture — contato, conversa, mensagens, agente, versão e troca do membro do roteador — foi revertido por rollback. Os workers concorrentes nunca enxergaram esses registros não confirmados. Nenhuma mensagem foi enviada ao WhatsApp. A contabilização das APIs foi conservada em `llm_calls` como teste, sem os vínculos fictícios; as observações sintéticas não contam como concordância de atendimento. Conferência final: zero contatos/agentes de fixture restantes. [Resultado do fluxo](runtime.json).

Esta é prova de seleção pelo resolvedor e banco reais. **Não é prova do atendimento completo por WhatsApp**, nem publicação do agente comercial que ainda está em rascunho.

## Tela, persistência e revogação

Capturas reais de elementos da interface, sem alterar o DOM para simular resultado e sem marca, chaves, contatos ou conversas de clientes.

1. Histórico inicialmente desligado após instalar: [captura](01-historico-desativado.png).
2. Autorização específica acionada pelo administrador: [diálogo](02-autorizacao.png).
3. Histórico ligado e persistente após recarregar: [captura](03-historico-autorizado.png).
4. Tarefa do roteador em **Decide**: [captura](04-jev-decidindo.png).
5. “Quero me matricular na academia.” pela tela e diretamente pela mesma API: intenção, agente e Jev decidindo concordaram. [Captura](05-roteador-real.png), [respostas sem ids](tela-api.json). Esse campo de teste recebe uma frase, não um histórico; a janela de quatro mensagens foi provada no fluxo acima.
6. Revogação pela tela, persistência e chamada real de “Sim” com histórico disponível: o payload voltou a ser a string `"Sim"`, sem histórico. [Captura](06-revogacao.png), [resultado](revogado.json).
7. Autorização refeita pela tela; estado final **histórico autorizado, roteador decidindo**. [Captura](07-configuracao-final.png).

## Testes automatizados

No commit de código `32b9cd6ca`, os checks `verify`, `build-and-size`, `invariants`, `e2e` e `imagens-ok` concluíram com sucesso. A cobertura inclui autorização/revogação, limite e ordem da janela, isolamento de conversa/organização, scrub e fallback. Evidência visual e APIs reais acima complementam os testes com respostas controladas; não são substituídas por eles.
