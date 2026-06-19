// Errors a carrier can throw. The server catches CarrierError and maps each
// subclass to an HTTP status (see server.ts). Anything else is a 500.

export class CarrierError extends Error {}

export class InvalidCredentialsError extends CarrierError {} // 401
export class InvalidMfaError extends CarrierError {} // 401
export class AntiBotError extends CarrierError {} // 503
export class CarrierTimeoutError extends CarrierError {} // 504
export class DocumentsUnavailableError extends CarrierError {} // 502, retryable
