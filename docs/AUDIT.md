# CodeRabbit Baseline Audit

Please do a deep review of this repo focusing on:
- MCP Streamable HTTP session lifecycle (init, reuse, TTL/cleanup)
- Mcp-Session-Id header behavior
- CORS policy / public exposure (ngrok)
- Zod input shapes vs @modelcontextprotocol/sdk 1.19.1
- Canvas API error handling + pagination (`Link:` header parsing)
- CI safety (public_smoke; secrets handling)
- Testability: suggest unit/integration tests for echo & Canvas tools
