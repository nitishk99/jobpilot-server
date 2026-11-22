import { BaseMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { getOpenAiModel } from "../../config/env.js";
import { emailExtractionSchema, type EmailExtraction } from "./extraction.js";
import { EmailProcessingError } from "./errors.js";

const MAX_OPENAI_ATTEMPTS = 2;
const OPENAI_RETRY_DELAY_MS = 100;
const REQUEST_TIMEOUT_MS = 30_000;

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | undefined =>
  typeof value === "object" && value !== null
    ? (value as UnknownRecord)
    : undefined;

const isRetryableNetworkError = (error: unknown): boolean => {
  if (error instanceof TypeError) {
    return true;
  }
  const name = asRecord(error)?.name;
  return (
    name === "AbortError" ||
    name === "TimeoutError" ||
    name === "APIConnectionError"
  );
};

const statusFromError = (error: unknown): number | undefined => {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const record = asRecord(current);
    const status = record?.status ?? record?.statusCode;
    if (typeof status === "number") {
      return status;
    }
    current = record?.cause ?? record?.error;
  }
  return undefined;
};

const providerMetadata = (error: unknown): {
  name?: string;
  code?: string;
} => {
  let current: unknown = error;
  let result: { name?: string; code?: string } = {};
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const record = asRecord(current);
    const name = record?.name ?? (current instanceof Error ? current.name : undefined);
    const code = record?.code ?? record?.type ?? record?.lc_error_code;
    result = {
      name: typeof name === "string" ? name : result.name,
      code: typeof code === "string" ? code : result.code,
    };
    current = record?.cause ?? record?.error;
  }
  return result;
};

const isOutputParsingFailure = (error: unknown): boolean =>
  providerMetadata(error).code === "OUTPUT_PARSING_FAILURE";

const waitBeforeRetry = async (attempt: number): Promise<void> => {
  await new Promise((resolve) =>
    setTimeout(resolve, OPENAI_RETRY_DELAY_MS * 2 ** attempt),
  );
};

const openAIRequestErrorCode = (status: number): string => {
  if (status === 400) {
    return "OPENAI_HTTP_400_INVALID_REQUEST";
  }
  if (status === 401 || status === 403) {
    return `OPENAI_HTTP_${status}_AUTH_OR_PERMISSION`;
  }
  if (status === 404) {
    return "OPENAI_HTTP_404_MODEL_NOT_FOUND";
  }
  return `OPENAI_HTTP_${status}`;
};

export const resolveOpenAIModel = (configuredModel: string | undefined) =>
  configuredModel?.trim() || getOpenAiModel();

export const invokeOpenAiEmailExtraction = async (
  apiKey: string,
  messages: BaseMessage[],
): Promise<EmailExtraction> => {
  const model = new ChatOpenAI({
    model: resolveOpenAIModel(getOpenAiModel()),
    apiKey,
    maxRetries: 0,
    maxTokens: 768,
    reasoning: { effort: "low" },
    timeout: REQUEST_TIMEOUT_MS,
    useResponsesApi: true,
  });
  const structuredModel = model.withStructuredOutput(emailExtractionSchema, {
    name: "email_extraction",
    method: "jsonSchema",
    strict: true,
  });

  for (let attempt = 0; attempt < MAX_OPENAI_ATTEMPTS; attempt += 1) {
    try {
      const output = await structuredModel.invoke(messages);
      const parsed = emailExtractionSchema.safeParse(output);
      if (!parsed.success) {
        throw new EmailProcessingError(
          502,
          "OPENAI_INVALID_EXTRACTION",
          "OpenAI output did not match the required email extraction format.",
        );
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof EmailProcessingError) {
        throw error;
      }

      const status = statusFromError(error);
      const retryableStatus = status === 429 ||
        (status !== undefined && status >= 500);
      const retryableNetworkError = isRetryableNetworkError(error);
      const retryableParsingError = isOutputParsingFailure(error);
      if (
        attempt + 1 < MAX_OPENAI_ATTEMPTS &&
        (retryableStatus || retryableNetworkError || retryableParsingError)
      ) {
        await waitBeforeRetry(attempt);
        continue;
      }

      if (retryableStatus) {
        const metadata = providerMetadata(error);
        throw new EmailProcessingError(
          503,
          status === 429
            ? "OPENAI_RATE_LIMITED"
            : `OPENAI_HTTP_${status}_UNAVAILABLE`,
          "OpenAI is temporarily unavailable. Try processing again.",
          metadata.name,
          metadata.code,
        );
      }

      if (retryableNetworkError) {
        const metadata = providerMetadata(error);
        throw new EmailProcessingError(
          503,
          "OPENAI_NETWORK_ERROR",
          "OpenAI could not be reached. Try processing again.",
          metadata.name,
          metadata.code,
        );
      }

      if (status !== undefined) {
        const metadata = providerMetadata(error);
        throw new EmailProcessingError(
          502,
          openAIRequestErrorCode(status),
          "OpenAI rejected the email processing request.",
          metadata.name,
          metadata.code,
        );
      }

      const metadata = providerMetadata(error);
      if (retryableParsingError) {
        throw new EmailProcessingError(
          502,
          "OPENAI_INVALID_EXTRACTION",
          "OpenAI output did not match the required email extraction format.",
          metadata.name,
          metadata.code,
        );
      }
      throw new EmailProcessingError(
        502,
        "OPENAI_REQUEST_FAILED",
        "OpenAI could not process the email request.",
        metadata.name,
        metadata.code,
      );
    }
  }

  throw new EmailProcessingError(
    503,
    "OPENAI_UNAVAILABLE",
    "OpenAI is temporarily unavailable. Try processing again.",
  );
};
