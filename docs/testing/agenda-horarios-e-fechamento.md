# Evidência: horários locais e fechamento depois das ações

Medição de contribuição externa em 07/10/2026, base oficial inicial `ce5b87a3c`.
Depois da medição, a `main` oficial `857917055` foi incorporada sem conflito;
nenhum dos seis arquivos de implementação desta correção mudou nesse intervalo.
Os avanços `6f8228f54` e `17a67d3da` também foram incorporados sem conflito.
O último acrescentou somente um teste de credenciais; nenhum arquivo do produto mudou.
Código candidato em worktree, sem implantação. Dados, contatos, canal e banco
fictícios; nenhum envio por WhatsApp. O canal somente capturou mensagens.

## Causas reproduzidas

1. O bloco de reservas interpolava `Date` do PostgreSQL, apresentando a hora
   do processo em vez da hora local da reserva. Listagem e escrita das ferramentas
   também entregavam instantes sem rótulo local para as reservas existentes.
2. No SDK `ai@7.0.116`, `result.response.messages` é só a última etapa.
   O fechamento perdia as ações de etapas anteriores; `result.responseMessages`
   contém a fita completa. Isso foi observado no ensaio: criação confirmada no
   banco às 11h e mensagem correta, mas resumo "a reserva ainda não foi confirmada".
3. O bloco da abertura precede a ação. Na remarcação ele pode conservar 17h30
   depois de o escritor concluir a mudança para 17h. A releitura após as ações
   fornece a reserva vigente ao fechamento.

## Par agente e ferramenta, com o mesmo recorte

Motor `runAgentTurn` e ferramentas MCP nativas, modelo real configurado pela
instalação (`gpt-5.6-luna`), dois turnos por cenário. Consulta direta de
`crm_list_appointments` antes e depois, mesmas organização e pessoa fictícias.
Escritores e funções do baseline executaram no PostgreSQL descartável.

| Cenário e pedido enviado                                                                                                 | Banco / ferramenta direta                      | Resposta e registro no turno seguinte                          |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------- |
| "Oi, pode confirmar que horas ficou meu design na sexta, dia 09/10?"                                                     | 17:00 UTC; `quando`: 14:00 São Paulo           | 09/10 às 14h; confirmado                                       |
| "Que horas ficou meu design na sexta?", resumo anterior dizia 17h                                                        | 17:00 UTC; `quando`: 14:00 São Paulo           | 14h; resumo antigo corrigido; preferência preservada           |
| "Pode reservar meu design de sobrancelhas na sexta, dia 09/10, às 11h, por favor. Meu nome completo é Cliente Fictícia." | Criação confirmada às 14:00 UTC / 11:00 local  | 11h; reserva confirmada, sem repetir criação como próxima ação |
| "Pode mudar meu design de sexta, dia 09/10, de 17h30 para 17h, por favor."                                               | Revisão 2, 20:00 UTC / 17:00 local             | 17h; remarcação concluída                                      |
| "Cancele meu design de sexta, dia 09/10, por favor. Não vou conseguir ir."                                               | Cancelado, revisão 2; sem reserva futura ativa | Cancelamento confirmado; sem oferecer a reserva como ativa     |

O segundo pedido foi "Só para confirmar: para que dia e horário ficou marcado?",
ou, no cancelamento, "Só para confirmar: meu horário foi cancelado mesmo?".
Mensagens, dados persistidos, ferramenta direta e registros de ambos os turnos
foram conferidos. Resultado semântico: cinco cenários coerentes nos dois turnos.

Uma asserção inicial exigia `commitments: []` após cancelar. O modelo registrou
"o design está cancelado" nesse campo, o que é coerente e não significa reserva
ativa. A asserção foi corrigida para admitir a confirmação do cancelamento;
a repetição isolada passou. Não se contou uma alteração de asserção como conserto
no produto.

## Limites da evidência

- A fronteira Supabase foi uma ponte SQL de teste, com filtros, ordenação,
  JSON e funções reais. Não mede HTTP PostgREST nem uma sessão autenticada
  de navegador. Os testes nativos de isolamento medem esses recortes à parte.
- Foi usado o prompt publicado autorizado pelo operador; fontes de conhecimento,
  roteadores, handoff, casos e operação secundária não foram copiados. Esta é
  evidência do núcleo de agenda e fechamento, não reprodução integral da instalação.
- A prova por interface e o transporte WhatsApp não foram medidos. Ficaram
  para o mantenedor, conforme o guia de contribuição externa.
- A hora fornecida é determinística, mas mensagens e resumo continuam gerados
  pelo modelo. Cinco cenários não provam ausência de todo erro futuro.
- Não houve migração, alteração de configuração ou edição de reservas reais.

## Gates e sabotagem

Ambiente: macOS, Node 24.19.0, pnpm 9.15.9. O projeto declara Node 22;
esta medição local não substitui esse ambiente do CI. Nenhuma variável de
produção foi carregada na compilação.

| Verificação                                              | Resultado medido                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                         | exit 0                                                                                 |
| `pnpm lint`                                              | exit 0; zero erros, 507 avisos existentes                                              |
| `pnpm lint:channels`                                     | exit 0; 62 arquivos de dívida conhecida, nenhum novo                                   |
| `pnpm lint:role-rank`                                    | exit 0                                                                                 |
| `pnpm release:conferir`                                  | exit 0; somente conferência, sem cortar release                                        |
| `pnpm build`                                             | exit 0                                                                                 |
| Cinco arquivos unitários de agenda                       | 75 testes passaram; repetidos depois de restaurar a sabotagem                          |
| Três arquivos nativos de banco: fechamento e isolamento  | 8 testes passaram; baseline aplicado e reaplicado, 164 regras de isolamento conferidas |
| Invariante de fechamento depois de restaurar a sabotagem | 1 teste passou                                                                         |

A suíte inteira foi executada, sem filtro por caminho:

```text
pnpm test:unit --maxWorkers=3
Test Files  5 failed | 1973 passed (1978)
Tests       16 failed | 20690 passed | 1 expected fail (20707)
```

Arquivos vermelhos e comparação na base oficial `ce5b87a3c`, sem a correção:

- `atualizacao-confere-regras-de-isolamento.test.ts`: dois limites de tempo,
  também reproduzidos na base.
- `instalador-idioma-da-cli.test.ts`: onze falhas, também reproduzidas na base.
- `dialog-base-roda-e-tem-teto.test.ts`: uma falha, também reproduzida na base;
  o comando de shell trata a pasta com espaços como argumentos separados.
- `baseline-nao-constroi-o-que-derruba.test.ts`: um limite de tempo na suíte
  completa; passou isolado na base.
- `agent-form-callback-default.test.tsx`: um limite de tempo na suíte completa;
  passou isolado na base.

Comparação dos três primeiros arquivos, mais o teste de baseline:
`3 failed | 1 passed`, `14 failed | 59 passed`.
Repetição isolada dos dois arquivos com limite de tempo:
`2 passed`, `23 passed`. Não se declara a suíte completa verde; as falhas
persistentes do ambiente e os limites de tempo ficam explícitos para o mantenedor.

### Sabotagem depois do commit `0b59226ad`

| Alteração deliberada                                           | Previsão                                                                          | Resultado                                                               |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Renderizar tudo em UTC                                         | Sete casos vermelhos: quatro fusos não UTC, remarcação e dois caminhos de criação | Exatamente 7 falharam e 7 passaram no arquivo de 14 testes              |
| Voltar a usar somente `result.response.messages` no fechamento | Um invariante vermelho: a ação de envio anterior desaparece da fita               | Exatamente 1 falhou; ausência de `toolName: send_message` no fechamento |
| Reutilizar o bloco da abertura em vez de reler a reserva       | Um invariante vermelho: persistência de 17h30 após mudar para 17h                 | Exatamente 1 falhou; compromisso persistido continuava 17h30            |

As duas últimas sabotagens rodaram numa segunda cópia, separada da branch
candidata. Todas foram restauradas; os testes de agenda voltaram ao verde.
Os testes nativos de banco usam modelo determinístico para medir a integração;
a semântica do modelo real é medida pelos cinco cenários acima.

### Reconferência após incorporar `857917055`

- `pnpm lint`: **exit 0**, zero erros e 508 avisos na branch mesclada.
- `pnpm build`: **exit 0** na branch mesclada, incluindo TypeScript e geração
  das páginas. Os avisos de leitura de marca/módulos sem banco configurado
  pertencem à compilação sem variáveis opcionais.
- Agenda, mais os dois arquivos que tinham excedido o tempo: **7 arquivos,
  98 testes passaram**, incluindo os 75 testes de agenda.
- Fechamento e isolamento no novo baseline oficial: **3 arquivos, 8 testes
  passaram**; banco instalado e reaplicado novamente, sem usar produção.
- A suíte completa de 20.707 casos e os cinco ensaios com modelo real acima
  pertencem à base inicial; não foram repetidos integralmente após esse merge.
  A implementação da correção e seus cinco arquivos unitários são idênticos.

Após incorporar `6f8228f54`: os **75 testes de agenda mais cinco de métricas
passaram (80 no total)**; o invariante nativo de fechamento passou novamente;
`pnpm build` terminou com **exit 0**. Esse avanço oficial alterou medição de
custo/latência e exportou o gate de orçamento; não alterou os arquivos desta
correção. Os ensaios com modelo real não foram repetidos por essa mudança.

### Ajustes do mantenedor e evidência de segurança

Após o envio, o mantenedor acrescentou `6c4250817` (causa truncada no aviso de
falha) e `b62f68fa1` (fita completa como texto no fechamento, compatível com
chamadas sem ferramentas da Anthropic). Na revisão `b62f68fa1`:

- Os cinco arquivos unitários de agenda e o novo de fechamento passaram:
  **6 arquivos, 78 testes**.
- Fechamento, isolamento entre organizações e isolamento entre contatos foram
  repetidos no PostgreSQL descartável: **3 arquivos, 8 testes passaram**.
- `pnpm typecheck`: **exit 0** com limite de memória de 8 GiB no processo;
  a primeira tentativa atingiu o limite padrão, sem erro de tipagem reportado.
  Verificador dos cinco arquivos de código/testes alterados: zero erros e dois
  avisos existentes. Nenhuma mudança de produto para acomodar o ambiente.
- O scan de segurança do diff original foi concluído; relatório, SARIF gerado
  e saídas de regressão estão em `evidence/security/agenda-no-turno/`.
  O scan fixa `17a67d3da..1adb4ee92`; os dois novos commits foram lidos e testados
  separadamente. Não é uma auditoria do repositório inteiro.
