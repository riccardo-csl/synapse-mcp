export interface SynapseError extends Error {
  code: string;
  details: Record<string, unknown>;
}

export function synapseError(
  code: string,
  message: string,
  details: Record<string, unknown> = {}
): SynapseError {
  const err = new Error(message) as SynapseError;
  err.code = code;
  err.details = details;
  return err;
}

export function schemaError(
  message: string,
  issues: Array<Record<string, unknown>> = []
): SynapseError {
  return synapseError("SCHEMA_INVALID", message, { issues });
}
