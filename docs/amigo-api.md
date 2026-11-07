# Integração Amigo API

A instalação atende uma clínica. Em **Amigo API**, um administrador pode testar e salvar o token, escolher a unidade e confirmar o fuso da clínica. Depois, ative o modo Amigo. O token novo sempre cria uma conexão nova, inicialmente desativada; IDs da conta anterior não são reutilizados. O token fica cifrado no servidor e a interface mostra somente os últimos quatro caracteres.

Com o modo ativo, o Amigo é a agenda principal. A área Amigo permite consultar unidades, especialidades, médicos, atendimentos, grupos de convênio, planos, produtos e disponibilidade; buscar, selecionar, cadastrar e atualizar pacientes; consultar aniversariantes de hoje ou amanhã; marcar, confirmar, registrar chegada, remarcar e cancelar consultas. Conclusão, falta e início de atendimento são estados lidos do Amigo, pois a API não documenta sua escrita.

Um mesmo telefone pode representar vários pacientes. Selecione explicitamente quem será atendido e vincule-o ao contato responsável do CRM. Vínculo com negócio é opcional. Importar a agenda não cria contatos, negócios nem mensagens. O histórico inicial não dispara automações. A IA só acessa pacientes do contato da conversa; consultas globais e aniversariantes exigem gestão humana.

As consultas vinculadas aparecem também na agenda e na timeline do negócio. A aplicação conserva o identificador do Amigo e uma projeção local. A atualização repetida mantém um único compromisso. Ordem de chegada conserva turno e intervalo: não representa garantia de atendimento em um minuto específico. O status local confirmado significa reserva aceita pelo provedor; `external_status` conserva o estado operacional real.

A agenda é atualizada ao consultar e pelo cron `amigo-sync`, a cada cinco minutos, em janelas de sete dias abrangendo os últimos sete e os próximos noventa dias. Em instalação local, execute o relógio de desenvolvimento existente; em servidor, o scheduler inclui a rota. A configuração mostra a última sincronização e falhas. Token recusado durante sincronização deixa uma falha visível e mantém o Amigo como agenda principal; a aplicação não troca automaticamente para reservas locais.

Uma falha de rede após uma alteração pode deixar o resultado **incerto**. O recibo durável impede reenviar a mesma operação. Atualizar a agenda procura evidência de uma única consulta com os mesmos paciente, médico, unidade, atendimento e início. Ausência ou ambiguidade não autorizam nova gravação. Cadastros de paciente com resultado incerto devem ser conferidos no Amigo antes de selecionar e vincular um registro existente. A aplicação não limpa bloqueios incertos por prazo.

Lembretes nascem desligados e dependem da opção na configuração Amigo e do lembrete habilitado no tipo de atendimento. Antes de cada envio, o sistema relê a consulta original, o vínculo com o responsável e o horário. Se o Amigo não responder, se a data mudar ou se a consulta estiver cancelada, concluída ou já em atendimento, o envio é pulado. Projeções Amigo não são publicadas no Google nem expiradas pelo cron da agenda local.

Consultas locais anteriores conservam sua origem. Uma consulta Amigo existente usa a conexão original para alterações, mesmo com o modo desativado, enquanto a credencial original estiver disponível. Desconectar remove as credenciais e conserva o histórico; consultas sem credencial passam a exigir gestão no sistema de origem.

A API documentada não oferece prontuário, receitas, faturamento, preços, webhooks nem emissão/renovação de token. A integração não inventa esses recursos. Documentação de origem: [Amigo API](https://amigobot-api.amigoapp.com.br/api-docs/).

## Validação

Contratos cobrem as 22 operações com respostas e dados fictícios. Testes verificam permissões, isolamento entre clínicas, cifragem, recibos, projeção e os bloqueios de envio. A homologação contra uma conta real requer cadastrar posteriormente um token válido na própria aplicação; nenhuma credencial Amigo foi solicitada pela conversa.

## Ligações no sistema

Configuração e formulários → rotas autenticadas → domínio Amigo → transporte de origem fixa → Amigo. Agenda e ferramentas de IA consomem o mesmo domínio. Respostas do provedor → vínculos/projeção → agenda local, timeline e etapas mapeadas do negócio. Scheduler → sincronização → projeção e reconciliação. Lembretes → revalidação remota → política de envio existente. Falha incerta → recibo bloqueado → conferência/reconciliação, sem reenvio automático.

Seleções de paciente, médico e consulta carregam a identidade da conexão em que foram obtidas. Se outro administrador trocar o token, formulários antigos são recusados e exigem atualizar as seleções. As consultas externas são protegidas no banco contra gravações diretas por clientes autenticados. Estados de conclusão importados não se apresentam como confirmação humana de presença.
