#!/usr/bin/env node
/**
 * A TCP proxy in front of a LOCAL PostgreSQL that adds network delay and counts round trips,
 * so the load test can show how a code path behaves against a remote database (production is
 * Supabase behind a pooler) without touching one.
 *
 *   node tests/load/pg-latency-proxy.mjs <listenPort> <targetPort> <rttMs> [statsFile]
 *
 * Each chunk is delayed by rtt/2 in each direction (order preserved), so a request/response
 * costs one RTT. A round trip is counted per Sync ('S') or simple Query ('Q') message the client
 * sends — one per statement for Prisma's extended protocol. Stats are written to statsFile (JSON)
 * every 200 ms and on SIGTERM. Local targets only.
 */
import net from "node:net";
import fs from "node:fs";

const [listenPort, targetPort, rttArg, statsFile] = process.argv.slice(2);
const half = Number(rttArg) / 2;
if (!listenPort || !targetPort || !Number.isFinite(half)) {
  console.error("usage: pg-latency-proxy.mjs <listenPort> <targetPort> <rttMs> [statsFile]");
  process.exit(2);
}

const stats = { rttMs: Number(rttArg), connections: 0, roundTrips: 0 };
const flush = () => statsFile && fs.writeFileSync(statsFile, JSON.stringify(stats));
setInterval(flush, 200).unref();
process.on("SIGTERM", () => { flush(); process.exit(0); });

function delayed(dst) {
  // Timers with the same delay fire in creation order, so chunks keep their order.
  return (chunk) => (half > 0 ? setTimeout(() => dst.writable && dst.write(chunk), half) : dst.write(chunk));
}

net.createServer((client) => {
  stats.connections++;
  const server = net.connect({ host: "127.0.0.1", port: Number(targetPort) });
  let buf = Buffer.alloc(0);
  let startup = true;
  client.on("data", (chunk) => {
    // Frame the client stream: startup/SSL messages have no type byte; the rest are type + int32 length.
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (startup) {
        if (buf.length < 8) break;
        const len = buf.readInt32BE(0);
        if (buf.length < len) break;
        const code = buf.readInt32BE(4);
        buf = buf.subarray(len);
        if (code === 196608) startup = false; // protocol 3.0 startup; SSL/GSS requests keep us in startup
        continue;
      }
      if (buf.length < 5) break;
      const len = buf.readInt32BE(1);
      if (buf.length < len + 1) break;
      const type = String.fromCharCode(buf[0]);
      if (type === "S" || type === "Q") stats.roundTrips++;
      buf = buf.subarray(len + 1);
    }
    delayed(server)(chunk);
  });
  server.on("data", delayed(client));
  const close = () => { client.destroy(); server.destroy(); };
  client.on("error", close);
  server.on("error", close);
  client.on("close", () => setTimeout(() => server.end(), half));
  server.on("close", () => setTimeout(() => client.end(), half));
}).listen(Number(listenPort), "127.0.0.1", () => console.log(`pg-latency-proxy :${listenPort} -> :${targetPort} rtt=${rttArg}ms`));
