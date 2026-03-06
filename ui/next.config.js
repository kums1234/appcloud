/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',

  // Proxy /api/* → the Fastify API container at build-time or runtime.
  // NEXT_PUBLIC_API_URL is used server-side only (in rewrites) so it can
  // be set at runtime via docker-compose env — it never gets baked into
  // the browser bundle. The browser always calls /api/* on the same origin.
  async rewrites() {
    // Default to the service host used in docker-compose when no env was
    // provided at build-time. Next's rewrites are evaluated during build,
    // so using localhost here can cause the running container to attempt
    // to proxy to 127.0.0.1 instead of the `api` service.
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://api:3000'
    return [
      {
        source: '/api/:path*',
        destination: `${apiUrl}/:path*`,
      },
    ]
  },
}

module.exports = nextConfig