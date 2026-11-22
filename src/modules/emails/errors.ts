export class EmailProcessingError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly providerErrorName?: string,
    readonly providerErrorCode?: string,
  ) {
    super(message);
    this.name = "EmailProcessingError";
  }
}
