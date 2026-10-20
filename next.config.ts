import type { NextConfig } from "next";

const config: NextConfig = {
  // Authentication URLs can contain sensitive verification parameters.
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
    }, {
      source: "/sign-in/:path*",
      headers: [
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Cache-Control", value: "no-store" },
      ],
    }, {
      source: "/sign-up/:path*",
      headers: [
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Cache-Control", value: "no-store" },
      ],
    }];
  },
};

export default config;
