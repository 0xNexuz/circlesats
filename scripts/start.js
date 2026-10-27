// The desktop shell may export NODE_TLS_REJECT_UNAUTHORIZED=0. Never inherit
// that bypass into the app: restore Node's default certificate verification.
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  console.warn('Ignored NODE_TLS_REJECT_UNAUTHORIZED=0; TLS certificate verification is enabled.');
}
await import('../src/server.js');
