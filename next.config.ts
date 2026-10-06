import type { NextConfig } from "next";

const config: NextConfig = {
  // Incoming auth URLs can contain single-use bearer tokens.
  logging: { incomingRequests: false },
  async headers() {
    return [{
      source: "/api/auth/:path*",
      headers: [
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Cache-Control", value: "no-store" },
      ],
    }, {
      source: "/auth/:path*",
      headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
    }];
  },
};

export default config;
