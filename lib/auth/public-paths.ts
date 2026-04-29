/**
 * Paths that bypass auth check in middleware.
 * Match precedence: array order. First match wins.
 */
export const PUBLIC_PATHS: RegExp[] = [
  /^\/$/,
  /^\/login(\/.*)?$/,
  /^\/403$/,
  /^\/404$/,
  /^\/api\/v1\/health$/,
  /^\/api\/v1\/webhooks\//,
  /^\/_next\//,
  /^\/favicon\.ico$/,
  /^\/team\/accept-invite\/.+$/,
];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((re) => re.test(pathname));
}
