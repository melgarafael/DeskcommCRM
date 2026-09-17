# Marco 2 — bases reais para instalação declarativa

**Referência:** `b3a056b85`, na branch do PR #1016, já integrada a `origin/main` @ `60079eb5`. Investigação de 14/set/2026, somente leitura de código; nenhum serviço iniciado, teste/migration executado ou credencial acessada. **CONFIRMADO** indica código lido; **INFERIDO** indica consequência sem ensaio; **NECESSÁRIO** traduz o aceite aprovado em trabalho ainda não implementado.

**Conclusão:** podemos reutilizar preparação de conteúdo, versões imutáveis, publicação por ponteiro, Storage privado, autorização canônica e pedido durável ao host. Não existe nessas bases um catálogo de extensões separado nem um instalador completo com confiança de origem. Ativar implementação já compilada não demonstra baixar e instalar pacote novo sem rebuild.

## Contratos aprovados que delimitam o reaproveitamento

O PROG-017 *(documento interno de decisão)*, §§4–6 e 12, separa catálogo central, artefato local admitido, ativação/configuração da organização e ação autorizada do ator. Catálogo tem aplicação/banco próprios; não recebe contatos/conversas nem executa na VPS. Pacote tem identidade incluindo origem/publicador, versão/digest exatos e contrato do host. Metadado obrigatório desconhecido impede ativação.

O PROG-018 *(documento interno de decisão)*, marco 2, exige serviço separado, pacote realmente baixado, instalação/configuração pela tela, uso em A sem efeito em B e desativação/recuperação. O primeiro host pode exigir uma release para introduzir esses contratos; o pacote de prova deve ser publicado depois dessa imagem e instalado sem recompilá-la.

## Mapa de reutilização

| Base CONFIRMADA | Arquivos e contrato real | Consequência para o marco 2 |
|---|---|---|
| ZIP de skill | [package.ts](../../../lib/ai/skills/package.ts:97): SKILL.md, references/, assets/ admitidos; caminhos relativos; limites de quantidade/tamanho; matcher validado; SHA256 calculado por arquivo. | Reutilizar disciplinas de parser e erros instrutivos. Não reutilizar o formato como se já declarasse publicador, compatibilidade, dependências, contribuições visuais ou concessões. |
| Preparar e publicar | [install.ts](../../../lib/ai/skills/install.ts:27): cria versão, sobe arquivos para `{org}/{name}/{versionId}/{path}`, move ponteiro após uploads; falha de upload tenta limpeza e preserva versão órfã. | Bom precedente para só expor conteúdo completo. Falta livro recuperável de instalação, coordenação entre cliques/abas e reconciliação após queda; sequência de awaits não é transação DB+Storage. |
| Versão local imutável | [skills.ts](../../../lib/agent-engine/agent/skills.ts:147): `setSkillPointer` deriva escopo/nome da versão no SQL; [baseline](../../../supabase/baseline.sql:6868) cria trigger anti-UPDATE e índices de ponteiro. | Reutilizar preparação + troca de referência e histórico. Para extensões, registrar identidade/digest do pacote e revisão de ativação separadamente das versões de skills. |
| Catálogo existente | [GET skills](../../../app/api/v1/ai/skills/route.ts): catálogo são pointers com `organization_id=null`, no mesmo banco da VPS; lista exclui nomes já copiados à org. | Pode inspirar apresentação, não sustenta catálogo compartilhado entre instalações, publicação revisada, retirada de versão ou confiança de publicador. |
| Ingresso tenant | [import](../../../app/api/v1/ai/skills/import/route.ts:33), [install](../../../app/api/v1/ai/skills/[name]/install/route.ts), [delete](../../../app/api/v1/ai/skills/[name]/route.ts): manager+, `requireSupportWrite`, org do guard, auditoria. | Reutilizar wrappers/guard/audit e origem confiável da org. O papel manager das skills não substitui a autoridade admin aprovada para configurar extensões. |
| Assets privados | [baseline](../../../supabase/baseline.sql:4982): bucket skill-assets privado; leitura de prefixo da própria org ou platform; escrita via service role. | Padrão de armazenamento local reutilizável. Um artefato compartilhado por instância precisa de política própria, sem conceder acesso a configurações/segredos das orgs. |
| Consumidor no agente | [loadSkills](../../../lib/agent-engine/agent/skills.ts:177) lê a cada run; [inbound-turn](../../../lib/agent-engine/agent/inbound-turn.ts:1936) resolve e casa conteúdo por sinal; references só das skills casadas. | Conteúdo novo já pode mudar um turno sem restart. Isso prova uma classe de conteúdo, não UI genérica nem tools/código novos. |
| Pedido ao host | [system/update](../../../app/api/v1/system/update/route.ts), [system/agent](../../../app/api/v1/system/agent/route.ts), [agent.sh](../../../hostgator-setup-kit/agent.sh): run persistido, heartbeat, progresso/desfecho, host puxa pedido e executa update.sh conhecido. | Reutilizar a separação pedido/execução e correlação por run. O contrato atual só conhece atualização do core; não aceita operações de pacote nem deve receber shell, URL ou compose arbitrários. |

## Diferenças que impedem reaproveitamento literal

**CONFIRMADO — catálogo de skill não é opt-in.** `loadSkills` inclui plataforma global antes da instalação e permite override por nome. DELETE remove só o ponteiro da org; o global pode reaparecer. **INFERIDO:** usar esse mecanismo sozinho faria “desativar extensão” reativar comportamento padrão. As novas contribuições precisam resolver disponibilidade/ativação explícita, preservando o comportamento legado das skills.

**CONFIRMADO — copiar skill não copia seu pacote.** `installPlatformSkill` copia body/matcher/manifest e registra `forked_from_version_id`, mas não copia arquivos. [readSkillReference](../../../lib/agent-engine/agent/skill-references.ts:47) busca no prefixo da org e do novo versionId. **INFERIDO:** um item de plataforma com references não terá seus arquivos nesse destino apenas por instalar; as seeds body-only não demonstram esse percurso. É necessário copiar bytes ou resolver uma origem imutável admitida com autorização adequada.

**CONFIRMADO — digest registrado não é download verificado.** O parser calcula hashes sobre o upload recebido; não compara pacote com digest confiável externo. `readSkillReference` confere path/kind no manifesto e depois retorna `data.text()`; não reconfere size/SHA256. Também não há raiz de confiança, assinatura de catálogo, expiração, rotação de chave ou proteção contra catálogo antigo nesses módulos.

**CONFIRMADO — há um precedente experimental delimitado.** [verify-image.mjs](../../../experiments/extensoes/runtime/container/verify-image.mjs) baixa bytes de um índice OCI, compara SHA256 com pin já conhecido em profile.mjs e verifica digests por arquitetura. Não baixa camadas nem instala extensões. Reaproveitável: conferir bytes contra referência admitida, antes de interpretar/publicar. Não é protocolo de confiança de catálogo; não copiar seus pins de imagem para um contrato de pacotes.

**CONFIRMADO — entrada hostil ainda pede limites próprios.** O ZIP usa `unzipSync`; o próprio comentário registra que tamanho declarado mentiroso só é detectado após descompressão. A rota materializa multipart e o buffer do arquivo; Content-Length é apenas uma rejeição antecipada. **NECESSÁRIO:** download/parser do novo formato com limites efetivos de bytes e trabalho, sem avaliar JS, SQL, shell ou HTML livre; não converter os números das skills em orçamento de produto sem decidir o formato do piloto.

## Download, confiança e operação local

**CONFIRMADO:** [outbound-url.ts](../../../lib/automation/outbound-url.ts) e [outbound-ip.ts](../../../lib/automation/outbound-ip.ts) oferecem guardas de esquema/destino e resolução DNS; [call-webhook.ts](../../../lib/automation/actions/call-webhook.ts:112) não segue redirects e impõe timeout. O guard DNS declara janela de rebinding entre checagem e conexão. São peças reaproveitáveis, não um downloader pronto.

**NECESSÁRIO:** origem de catálogo admitida pela instalação, referência exata do pacote, validação de metadados de confiança e digest/tamanho dos bytes, compatibilidade antes da ativação e persistência local do artefato/decisão admitidos. Falha/interrupção não pode substituir versão ativa. URLs e redirecionamentos do pacote não podem transformar um clique de tenant em acesso à rede interna. A origem loopback da prova deve ser configuração explícita do ambiente isolado, sem afrouxar o guard de destinos de tenant.

O PROG-017 §12 já determina biblioteca/protocolo estabelecido para confiança, sem criptografia própria; a escolha concreta continua aberta. Hash entregue junto do arquivo pela mesma origem não prova publicador. Sem catálogo, conteúdo já admitido continua disponível após restart; expiração limita novas admissões, não desliga execução local. As decisões A/A/A do DEC-004, reproduzidas no PROG-017, já fixam revisão prévia, decisão local sobre versão instalada e downloads/avaliações sem identificador persistente de adoção: não são perguntas a reabrir.

## Instância, organização e ator

**CONFIRMADO:** atualizar o core exige `is_platform_admin`; o host se autentica por bearer interno e recebe `{update_requested, run_id}`. [update-run.ts](../../../lib/system/update-run.ts) distingue pedido despachado de resultado, mas run vencido não prova processo morto. O `.update.lock` coordena apenas o atualizador atual. **NECESSÁRIO:** uma nova operação compartilhada não pode declarar exclusão com atualização de core apenas por criar outro lock independente.

**APROVADO:** binários/schema compartilhados são autoridade da plataforma; admin da organização ativa/configura o que a instalação disponibilizou. Concessões restringem a autoridade do ator; instalação não concede envio, dinheiro ou permissão de banco. Uma versão de código por instância não é a mesma regra dos forks personalizáveis de skills.

**CONFIRMADO:** o [McpContext](../../../lib/mcp/types.ts) contém cliente administrativo Supabase; não pode ser entregue ao pacote. [tools.ts](../../../lib/ai/runtime/tools.ts) já faz seleção/guards de ferramentas do núcleo. **NECESSÁRIO:** ações declaradas referenciam operações admitidas do host, com payload validado e org/ator resolvidos no backend; a configuração do pacote não inventa handlers, SQL, tokens ou autoridade de IA. Desativação deve ser reavaliada no efeito, não só ao montar a tela ou iniciar o turno.

## Mínimo da jornada real e escolhas ainda abertas

**NECESSÁRIO para o marco 2:** contrato versionado de contribuição declarativa; catálogo com banco/artefatos próprios e publicação do pacote após o build; verificador local; registros distintos de artefato/instalação/ativação/configuração e operação; renderer/consumidor real do CRM; tela com progresso, motivo de recusa e recuperação; RLS/grants para acesso direto; auditoria; uso A/B e desativação provados pela interface. Novas tabelas do host seguem migration + baseline + MANIFEST. Isso pode começar sem executor externo ou SQL de pacote.

| Questão ainda não especificada no recorte aprovado | Alternativas e consequências, sem decisão implícita |
|---|---|
| Qual contribuição é o primeiro pacote? | Tema/widget de aparência é candidato no PROG-018; skill é precedente de conteúdo já consumido. Escolher skill sozinha não prova a composição visual proposta; escolher widget com ação exige contrato de domínio correspondente. |
| Quem admite um pacote puramente declarativo compartilhado, sem binário/schema? | Plataforma admite e admin da org ativa: deixa clara a fronteira compartilhada, exige passagem pelo operador. Delegação por política local pode reduzir passos, mas precisa explicitar origens/perfis permitidos; manager+ das skills não concede isso automaticamente. |
| Onde ficam bytes admitidos do piloto? | Storage/DB locais permitem consumo pelo app existente sem acesso ao host; diretório gerido pelo host preserva a separação de infraestrutura, mas exige entrega/volume e coordenação operacional. Ambos precisam sobreviver sem catálogo e conservar digest/versão. |
| Qual formato mínimo de pacote? | JSON estrito com contribuições conhecidas reduz superfície de parsing; ZIP com manifesto+assets reaproveita organização de conteúdo, mas acrescenta extração, limites e integridade de múltiplos arquivos. Não incluir uma propriedade de código/SQL “para depois”. |
| Como evolui configuração quando muda a versão? | Manter configuração validada por versão ou transformação declarativa restrita têm impactos diferentes sobre recuperação. Não escolher migração destrutiva, sobreposição silenciosa ou reset como regra não escrita. |
| Como o operador introduz outra origem de confiança? | O protocolo admite origem alternativa, mas bootstrap/rotação/revogação e UX de administração ainda precisam contrato concreto. Arquivo privado passa pela mesma validação local, sem herdar reputação oficial. |

**Limite desta investigação:** achados de leitura e impactos arquiteturais; nenhuma alegação de journey, isolamento, download instalado ou teste verde. Os caminhos de pesquisa foram skills/importação, Storage, consumidor de IA, atualizador, guardas de rede e o verificador experimental de bytes. Não foi repetida a investigação de runtime isolado.
