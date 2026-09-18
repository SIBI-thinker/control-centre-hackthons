/** @type {import('next').NextConfig} */
const nextConfig = {
  // Overridable so a verification build can run without overwriting the
  // .next directory of a dev server that's already running.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    // pdf-parse pulls in pdfjs, which resolves files dynamically at runtime.
    // Bundling it produces "critical dependency" warnings and can break the
    // parser, so it is required from node_modules instead.
    serverComponentsExternalPackages: ['pdf-parse'],
  },
  images: { unoptimized: true },
};

module.exports = nextConfig;
