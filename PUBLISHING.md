# Publicação do MCP

O servidor MCP do Dooor OS é open-source e público:

> https://github.com/Dooor-AI/dooor-os-mcp

Usuários externos clonam e configuram o MCP a partir desse repositório público.
Eles não têm e não devem ter acesso a este monorepo privado
(`Dooor-AI/dooor-os`). Por isso, qualquer instrução de setup do MCP que sair
para fora aponta para o repositório público, nunca para o `dooor-os`.

## Onde fica o código: existe um repositório só

**Este repositório é a única fonte da verdade.** Dentro do monorepo privado
`Dooor-AI/dooor-os`, o diretório `dooor-os-mcp/` é um **git submodule** que
aponta para cá, do mesmo jeito que `dooor-os-backend` e `dooor-os-frontend`.
Não existe cópia paralela para manter em sincronia, e não existe mais nenhum
passo de `rsync`.

Toda alteração no MCP nasce aqui, em PR contra a `main` deste repositório. O
monorepo só acompanha o ponteiro do submodule:

```bash
# no monorepo, depois que o PR daqui foi mergeado
cd dooor-os-mcp && git pull origin main && cd ..
git add dooor-os-mcp && git commit -m "chore(mcp): bump submodule"
```

O publish não pode conter segredos: o MCP lê `DOOOR_API_KEY` do ambiente,
nunca de código.

> **Por que essa regra existe.** Até 20/07/2026 esta pasta era uma cópia comum
> dentro do monorepo, sincronizada à mão. As duas cópias divergiram nas duas
> direções e um deploy tirado da cópia errada subiu um build sem o gating de
> tool registry por workspace, que precisou de rollback. Uma cópia editável, um
> repositório, um deploy.

O health check externo do servidor hospedado é `GET /health`. O endpoint
principal MCP é `POST /mcp`.

## Contrato de segurança do servidor hospedado

O MCP público não devolve body de resposta `5xx`, stack trace ou mensagem
interna nas respostas. Falha de servidor é sempre reportada de forma genérica,
porque pode carregar stack trace, string de conexão ou segredo.

Respostas `4xx` são tratadas de forma diferente, e de propósito: elas descrevem
o que o chamador enviou de errado, e o chamador é justamente quem precisa ler
aquilo. Sem isso, um erro de sintaxe numa consulta chega ao usuário como se a
plataforma estivesse fora do ar. A mensagem do backend é repassada apenas
quando o status é `4xx`, é neutra e passa pela sanitização centralizada. Chaves
`dor_sk_*` e headers de autorização são mascarados. Mensagens que contenham
relações físicas, nomes de componentes internos, identificadores de
adapter/runtime/provider ou detalhes de infraestrutura são descartadas por
inteiro e substituídas pela mensagem genérica do status. As demais são
truncadas em 300 caracteres na própria construção do erro, de modo que nenhum
ponto de chamada consiga reter texto não sanitizado. Body fora do formato JSON
esperado também é descartado em vez de ser repassado cru. `401`, `404`, `409` e
`429` mantêm mensagem genérica. O `403` só carrega uma decisão de governança
quando a razão é neutra; sem detail seguro, cai na mensagem genérica.

Falhas públicas recebem um correlation ID criado pelo próprio servidor e
enviado também no header `X-Correlation-Id`. IDs enviados pelo cliente não são
reutilizados.

O limite em memória do MCP é uma defesa local por hash da API key. Ele não usa
IP de origem, pois proxies podem compartilhar o mesmo IP entre clientes. Esse
limite vale somente para o processo ou instância atual. O backend do Dooor é a
fonte autoritativa dos limites e quotas globais entre todas as instâncias.

## Deploy do servidor hospedado

O serviço `dooor-mcp` no Cloud Run **não tem trigger de CI**: o deploy é
manual, a partir de um checkout deste repositório. Como este é o único
repositório do MCP, não há mais como deployar a partir da cópia errada.

```bash
git clone https://github.com/Dooor-AI/dooor-os-mcp.git && cd dooor-os-mcp
npm test   # obrigatorio antes de deployar
REGION="$(gcloud run services list --project=dooor-core --platform=managed \
  --filter='metadata.name=dooor-mcp' --format='value(region)')"
gcloud run deploy dooor-mcp --source . --region "$REGION" --project dooor-core \
  --allow-unauthenticated --port 8080 --memory 512Mi --cpu 1 \
  --min-instances 0 --max-instances 4 \
  --set-env-vars DOOOR_BASE_URL=https://api.os.dooor.ai/v1
```

Depois do deploy, confirme `GET /health` em `https://mcp.dooor.ai/health` e que
o tráfego foi para a revisão nova:

```bash
gcloud run services describe dooor-mcp --project dooor-core \
  --region "$REGION" --format='value(status.traffic)'
```

Se o tráfego estiver fixado numa revisão anterior, por exemplo depois de um
rollback, o deploy cria a revisão sem servi-la; nesse caso rode
`gcloud run services update-traffic dooor-mcp --to-latest`.

No `package.json`, `private` fica `false` e há campos `repository`/`homepage`
apontando para este repositório.
