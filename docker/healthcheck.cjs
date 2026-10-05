// SPDX-License-Identifier: MIT
// Container healthcheck for the Perihelion service images (see Dockerfile).
//
// Each package serves /healthz on a different port, so the probe resolves the
// port from the same environment variable the selected service reads:
//
//   relayer  PERIHELION_HEALTH_PORT   (default 8080)
//   solver   PERIHELION_METRICS_PORT  (default 9090)
//   mempool  PORT                     (default 3000)
//
// Exits 0 on HTTP 200 and 1 on anything else, as HEALTHCHECK expects.
"use strict";

const http = require("node:http");

const PORTS = {
  relayer: () => process.env.PERIHELION_HEALTH_PORT || "8080",
  solver: () => process.env.PERIHELION_METRICS_PORT || "9090",
  mempool: () => process.env.PORT || "3000",
};

const pkg = process.env.PACKAGE;
const resolvePort = PORTS[pkg];
if (!resolvePort) {
  console.error(`healthcheck: unknown PACKAGE "${pkg}"`);
  process.exit(1);
}

// 127.0.0.1 rather than localhost: the services bind the IPv4 loopback by
// default, and Node may resolve localhost to ::1 first.
const req = http.get(
  { host: "127.0.0.1", port: Number(resolvePort()), path: "/healthz", timeout: 4000 },
  (res) => {
    res.resume();
    process.exit(res.statusCode === 200 ? 0 : 1);
  },
);
req.on("timeout", () => req.destroy(new Error("timeout")));
req.on("error", () => process.exit(1));
