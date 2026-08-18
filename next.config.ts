import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["googleapis", "nodemailer"],

  /**
   * The OAuth discovery documents have to be served from /.well-known/, but
   * the route handlers live under app/api/oauth/ — a directory whose name
   * starts with a dot is not somewhere to rely on a bundler's behaviour.
   * These rewrites map one to the other.
   *
   * The :path* variants exist because RFC 8414 and RFC 9728 both insert the
   * well-known segment *before* the resource path, so a client looking for
   * metadata about https://host/api/mcp asks for
   * /.well-known/oauth-protected-resource/api/mcp. This server has exactly
   * one protected resource, so every such path answers with the same
   * document.
   */
  async rewrites() {
    return [
      {
        source: "/.well-known/oauth-protected-resource",
        destination: "/api/oauth/protected-resource",
      },
      {
        source: "/.well-known/oauth-protected-resource/:path*",
        destination: "/api/oauth/protected-resource",
      },
      {
        source: "/.well-known/oauth-authorization-server",
        destination: "/api/oauth/authorization-server",
      },
      {
        source: "/.well-known/oauth-authorization-server/:path*",
        destination: "/api/oauth/authorization-server",
      },
      // Some clients probe the OpenID Connect document first. This server is
      // not an OIDC provider — it issues no id_token — but answering with the
      // OAuth metadata is closer to useful than a 404.
      {
        source: "/.well-known/openid-configuration",
        destination: "/api/oauth/authorization-server",
      },
    ];
  },
};

export default nextConfig;
