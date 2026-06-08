cd chamber
    ( cd packages/appkit && npm install )
    ( cd apps/nutrition  && npm install )   # also builds better-sqlite3
    ( cd apps/notes      && npm install )
    ( cd apps/todo       && npm install )
    (macOS: if better-sqlite3 fails to build, run xcode-select --install first.)

    1. CLI (raw UI)

    cd apps/nutrition
    npm run cli -- log_meal --name "Chicken bowl" --components "grilled chicken:150" --components "broccoli:100"
    npm run cli -- list_meals
    npm run cli -- nutrition_for --meal_id <paste-id>

    cd ../notes
    npm run cli -- write hello.md "# Hi"
    npm run cli -- list
    npm run cli -- read hello.md

    cd ../todo
    npm run cli -- add "buy milk"
    npm run cli -- complete 1
    npm run cli -- list --filter incomplete
    Quote multi-word values so the shell doesn't split them.

    2. HTTP API + OpenAPI (any app)

    cd apps/nutrition && PORT=8080 npm run serve     # notes/todo identical; pick any PORT
    # another terminal:
    curl localhost:8080/
    curl localhost:8080/openapi.json
    curl -XPOST localhost:8080/log_meal -H 'content-type: application/json' \
      -d '{"name":"Salad","components":[{"component":"broccoli","qty_g":100}]}'

    3. MCP — direct

    cd apps/nutrition && npx @modelcontextprotocol/inspector npx tsx src/mcp.ts
    # or register in Claude Code:
    claude mcp add nutrition -- bash -lc 'cd /ABSOLUTE/PATH/chamber/apps/nutrition && npx tsx src/mcp.ts'

    4. MCP — via agentgateway (nutrition only, for now)

    gh release download v1.3.0-alpha.1 --repo agentgateway/agentgateway \
      --pattern agentgateway-linux-amd64 -O /tmp/agentgateway && chmod +x /tmp/agentgateway
    cd apps/nutrition
    npm run openapi > openapi.json
    PORT=8080 npm run serve &
    /tmp/agentgateway -f agentgateway.yaml &     # MCP on http://localhost:3000/mcp
    (macOS: use the agentgateway-darwin-arm64 asset instead.) The gateway nests args under a body field, e.g. { "body": { "name": ... } }.

    Tests

    cd apps/nutrition && npm test    # 69
    cd ../notes       && npm test    # 71
    cd ../todo        && npm test    # 82

    Caveats on the current tree: the openapi script + agentgateway.yaml exist only for nutrition so far (notes/todo are CLI/HTTP/MCP only), and the three apps' npm test commands differ slightly. Reset state between runs with rm -f
    apps/nutrition/nutrition.db*, rm -rf apps/notes/vault, rm -f apps/todo/todos.md.