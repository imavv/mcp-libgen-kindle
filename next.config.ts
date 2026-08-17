import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["googleapis", "nodemailer"],
};

export default nextConfig;
