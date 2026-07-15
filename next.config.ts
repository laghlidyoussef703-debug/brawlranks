import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* Minimal infrastructure proof-of-concept config.
     Full BrawlRanks configuration (image domains, redirects, etc.)
     will be added when the real platform is implemented. */
  turbopack: {
    // Pin the workspace root explicitly — a stray lockfile in the parent
    // user directory otherwise makes Next.js guess the wrong root.
    root: path.resolve(__dirname),
  },
  experimental: {
    // Hostinger's build container cannot sustain Next's normal worker
    // concurrency: both a Turbopack build (packet-length/IPC failure from
    // its persistent worker process) and a Webpack build
    // (ThreadPoolBuildError / OS error 11 "Resource temporarily
    // unavailable" / SIGABRT spawning the webpack build worker) fail there
    // with process/thread-spawn errors, even with RAYON_NUM_THREADS=1 and
    // UV_THREADPOOL_SIZE=1 set (those only pin Rust/libuv thread pools —
    // they don't reach Next's own jest-worker/webpack-build-worker process
    // spawning, which is the layer actually failing). These two typed,
    // documented options cap that layer to a single worker / the main
    // process instead of forking an additional one, matching the exact
    // failure mode observed (see npm run build:hostinger).
    cpus: 1,
    webpackBuildWorker: false,
  },
};

export default nextConfig;
