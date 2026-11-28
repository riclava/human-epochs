import type { FastifyInstance } from "fastify";

// The page loads only its own scripts and styles. React sets some inline style attributes, and the PDF reader runs
// its worker from the same origin.
const contentSecurityPolicy = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "font-src 'self'", "connect-src 'self'", "worker-src 'self' blob:", "object-src 'none'", "base-uri 'self'",
  "form-action 'self'", "frame-ancestors 'none'",
].join("; ");

export function addSecurityHeaders(app: FastifyInstance, production: boolean) {
  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (String(reply.getHeader("content-type") ?? "").startsWith("text/html")) reply.header("Content-Security-Policy", contentSecurityPolicy);
    if (production) reply.header("Strict-Transport-Security", "max-age=31536000");
  });
}
