# Bitar Fashion MCP server (read-only)

Lets an assistant such as Claude answer questions about the business and write reports ("the weekly report", "what should we reorder for Tripoli?") by calling the **same API** the web app uses, with the permissions and the branch scope of one account.

## What it can and cannot do
- **Read only.** It uses GET requests on an allow-list of paths (branches, reports, costs/profit, stock, replenishment, transfers, cash sessions, returns, settings). Everything else is refused **before** any request is made. It cannot sell, move stock, approve a return or change a setting.
- **The account decides.** It signs in with `BITAR_EMAIL` and `BITAR_PASSWORD`. A manager sees only their branches; an employee is told "not allowed" for finances. Use a manager (profit and costs are for managers).
- **The token and the password stay inside the process**: never printed, never logged, never part of an answer (tested).
- Anything a tool returns becomes part of the chat with the assistant. Use the demo data for the demo; for the real business, the owners should decide first.

## Tools
`list_branches`, `sales_summary` (all branches + each branch + each day, shop vs online, cash vs Whish, refunds, net), `top_products`, `profit_report` (net of returns, unknown costs shown apart), `stock_levels`, `reorder_suggestions`, `transfers`, `cash_drawers` (use `review: "flagged"`), `returns`.
Branches are given by name ("Hamra"), code, or part of the name. Dates are `YYYY-MM-DD`; without dates: today.
Prompt: `weekly_report` (one click asks for the whole picture).

## Run it (Windows, Claude Desktop)
1. In the repo: `npm ci` then `npm run build` (makes `build/mcp/server.js`).
2. Claude Desktop: **Settings > Developer > Edit Config** (the file is usually `%APPDATA%\Claude\claude_desktop_config.json`). Add:
```json
{
  "mcpServers": {
    "bitar": {
      "command": "node",
      "args": ["C:\\Users\\YOU\\Desktop\\Bitar_Store_clean\\build\\mcp\\server.js"],
      "env": {
        "BITAR_API_URL": "https://YOUR-API.onrender.com",
        "BITAR_EMAIL": "manager@bitar.demo",
        "BITAR_PASSWORD": "THE-PASSWORD"
      }
    }
  }
}
```
3. **Quit Claude Desktop completely and open it again.** The tools should appear (the tools / plug icon in the chat box). Then ask: *"Give me the weekly report"* or pick the `weekly_report` prompt.
- Without a build: `"command": "npx", "args": ["tsx", "C:\\...\\src\\mcp\\server.ts"]`.
- Locally against your own API: `BITAR_API_URL=http://localhost:3000`.
- If the tools do not appear: check the MCP log of Claude Desktop (usually in `%APPDATA%\Claude\logs`), and run the server by hand to see its errors: `BITAR_API_URL=... BITAR_EMAIL=... BITAR_PASSWORD=... npm run mcp` (it prints "Bitar MCP server ready" on stderr).

## Questions for the demo
- "Give me the weekly report." (the prompt)
- "Which 5 products sold the most this week, and in which branch?"
- "How much did we sell online versus in the shops? What is the net after returns?"
- "What should we reorder for Tripoli, and can the warehouse cover it?"
- "Is any cash drawer waiting for review? Any return waiting for a decision?"
- "What is on the road between branches right now?"

## Tests
`src/test/mcp.http.test.ts` starts the real server over stdio (the way Claude Desktop does) against the real API and checks every tool against the API's own numbers, the read-only rules, the scope, and that no answer carries the token or the password. It was NOT tested inside Claude Desktop itself.
