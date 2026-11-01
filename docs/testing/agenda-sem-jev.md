# Agenda independente da revisão JEV

Extração da PR #3069 conforme o pedido de separação. Serviços, turmas, profissionais/recursos, configuração em quatro abas e título opcional são opt-in. O agendamento individual existente permanece no caminho nativo. A projeção factual local acompanha a agenda; integração de revisão, consentimento ampliado, captura e conferência semântica pré-gravação ficam na contribuição dependente.

## Limite de dependências

Foi percorrido o grafo de imports de runtime das ferramentas MCP, consulta/escrita de serviços, coletor do atendimento e projeção factual: 97 módulos locais; nenhuma chamada a `revisarRespostaComJev`, `classifyPromise` ou `conferirPedidoDaAgenda`, nem import de cliente/revisor JEV por esses caminhos. Imports apenas de tipos não são execução. Essa conferência não afirma que o restante do CRM deixou de ter JEV.

## Conferência desta extração

- 91 testes dirigidos de regras, responsáveis, consulta, reativação, Google e apêndice SQL.
- 24 invariantes de serviços em PostgreSQL 15: papéis/duas organizações, capacidade, bloqueios, grupo, corrida, identidade, remarcação e cancelamento.
- Um invariante de reaplicação do baseline com turma reservada; mantém as duas proteções históricas da agenda contra deslocar turma ou atribuir responsável fictício.
- Baseline instalado e reaplicado com `ON_ERROR_STOP=1` em banco vazio, sem migration/captura da revisão. Os dois arquivos usaram bancos separados no QA existente, com o prelude oficial e as mesmas assertivas; não houve novo stack ou chamada a provedor.
- Tipos de produção, lint dirigido, cercas de canal/papel e fragmentos de release aprovados. O typecheck incluindo toda a suíte excedeu o heap local de 4GiB; não é apresentado como aprovado. Os checks oficiais do PR continuam necessários.

Fixtures usam a próxima terça-feira, pois a escrita respeita o relógio real do banco. Datas absolutas vencidas não medem disponibilidade. A configuração de destino da reserva e os calendários de bloqueio continuam independentes; publicação e entrega externa não são inferidas de uma reserva local.

A prova histórica em `docs/evidence/agendas-servicos/prova-em-par.json` pertence à candidata integrada original e está identificada assim. Ela não é prova de modelo real nesta extração nem autorização para ativar revisão externa. Nenhum dado empresarial ou pacote privado de diagnóstico integra a contribuição.
