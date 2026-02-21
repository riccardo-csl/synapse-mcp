export interface BrokerError extends Error {
  code: string;
  details: Record<string, unknown>;
}

export function brokerError(
  code: string,
  message: string,
  details: Record<string, unknown> = {}
): BrokerError {
  const err = new Error(message) as BrokerError;
  err.code = code;
  err.details = details;
  return err;
}
