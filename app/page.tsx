export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "3rem", lineHeight: 1.6 }}>
      <h1>mcp-libgen</h1>
      <p>
        MCP server. The endpoint is <code>/api/mcp</code> and is protected by OAuth 2.1;
        connect a client to it and it will walk you through authorizing.
      </p>
    </main>
  );
}
