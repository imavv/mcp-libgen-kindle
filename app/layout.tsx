export const metadata = {
  title: "mcp-libgen",
  description: "MCP server for fetching EPUBs and sending them to Kindle",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
