type ErrorRecord = Record<string, unknown>;

const asRecord = (value: unknown): ErrorRecord | undefined =>
  typeof value === "object" && value !== null
    ? (value as ErrorRecord)
    : undefined;

export const safeErrorDetails = (error: unknown): Record<string, string> => {
  const record = asRecord(error);
  const driverError = asRecord(record?.driverError);
  const details: Record<string, string> = {
    errorName:
      typeof record?.name === "string" ? record.name : "UnknownError",
  };

  if (typeof driverError?.code === "string") {
    details.databaseCode = driverError.code;
  }
  if (typeof driverError?.message === "string") {
    details.databaseMessage = driverError.message;
  }
  if (typeof driverError?.table === "string") {
    details.table = driverError.table;
  }
  if (typeof driverError?.column === "string") {
    details.column = driverError.column;
  }
  if (typeof driverError?.constraint === "string") {
    details.constraint = driverError.constraint;
  }

  return details;
};
