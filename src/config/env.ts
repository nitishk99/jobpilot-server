export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

const DEFAULT_CLIENT_URL = "http://localhost:5173";
const DEFAULT_PORT = 5000;
const DEFAULT_OPENAI_MODEL = "gpt-6-luna";

const normalizeOrigin = (
  rawValue: string,
  variableName: string,
): string => {
  const trimmedValue = rawValue.trim();
  if (!trimmedValue) {
    throw new ConfigurationError(`${variableName} must not be empty`);
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmedValue);
  } catch {
    throw new ConfigurationError(`${variableName} must be a valid URL`);
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new ConfigurationError(`${variableName} must use http or https`);
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new ConfigurationError(`${variableName} must not contain credentials`);
  }

  return parsedUrl.origin;
};

const normalizeAllowedOrigin = (value: string): string => {
  const origin = normalizeOrigin(value, "ALLOWED_CLIENT_ORIGINS");
  const parsedUrl = new URL(value.trim());
  if (parsedUrl.pathname !== "/" || parsedUrl.search || parsedUrl.hash) {
    throw new ConfigurationError(
      "ALLOWED_CLIENT_ORIGINS entries must be origins without paths or query strings",
    );
  }
  return origin;
};

const getRequiredValue = (
  env: NodeJS.ProcessEnv,
  name: string,
): string => {
  const value = env[name]?.trim();
  if (!value) {
    throw new ConfigurationError(`${name} is required`);
  }
  return value;
};

export const getClientUrl = (env: NodeJS.ProcessEnv = process.env): string =>
  env.CLIENT_URL?.trim() || DEFAULT_CLIENT_URL;

export const getClientOrigin = (
  env: NodeJS.ProcessEnv = process.env,
): string => normalizeOrigin(getClientUrl(env), "CLIENT_URL");

export const getAllowedClientOrigins = (
  env: NodeJS.ProcessEnv = process.env,
): string[] => {
  const configuredOrigins = env.ALLOWED_CLIENT_ORIGINS?.trim();
  const origins = new Set<string>([getClientOrigin(env)]);

  if (configuredOrigins) {
    for (const value of configuredOrigins.split(",")) {
      origins.add(normalizeAllowedOrigin(value));
    }
  }

  return [...origins];
};

export const isAllowedClientOrigin = (
  origin: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  if (!origin) {
    return false;
  }
  return getAllowedClientOrigins(env).includes(origin);
};

export const getPort = (env: NodeJS.ProcessEnv = process.env): number => {
  const configuredPort = env.PORT?.trim();
  if (!configuredPort) {
    return DEFAULT_PORT;
  }

  const parsedPort = Number(configuredPort);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    throw new ConfigurationError("PORT must be an integer between 1 and 65535");
  }
  return parsedPort;
};

export const getDatabaseUrl = (
  env: NodeJS.ProcessEnv = process.env,
): string => getRequiredValue(env, "DATABASE_URL");

export const getDatabaseUrlIfConfigured = (
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => env.DATABASE_URL?.trim() || undefined;

export const getNodeEnvironment = (
  env: NodeJS.ProcessEnv = process.env,
): string => env.NODE_ENV ?? "development";

export const getRabbitMqUrl = (
  env: NodeJS.ProcessEnv = process.env,
): string => getRequiredValue(env, "RABBITMQ_URL");

export const getGoogleOAuthConfig = (
  env: NodeJS.ProcessEnv = process.env,
): { clientId: string; clientSecret: string; redirectUri: string } => ({
  ...getGoogleOAuthClientCredentials(env),
  redirectUri: getRequiredValue(env, "GOOGLE_REDIRECT_URI"),
});

export const getGoogleOAuthClientCredentials = (
  env: NodeJS.ProcessEnv = process.env,
): { clientId: string; clientSecret: string } => ({
  clientId: getRequiredValue(env, "GOOGLE_CLIENT_ID"),
  clientSecret: getRequiredValue(env, "GOOGLE_CLIENT_SECRET"),
});

export const getGmailPubSubTopic = (
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  const value = env.GMAIL_PUBSUB_TOPIC?.trim();
  return value || undefined;
};

export const getGmailPubSubAuthConfig = (
  env: NodeJS.ProcessEnv = process.env,
): { audience: string; serviceAccountEmail: string } | undefined => {
  const audience = env.GMAIL_PUBSUB_AUDIENCE?.trim();
  const serviceAccountEmail = env.GMAIL_PUBSUB_SERVICE_ACCOUNT_EMAIL
    ?.trim()
    .toLowerCase();

  if (!audience && !serviceAccountEmail) {
    return undefined;
  }
  if (!audience || !serviceAccountEmail) {
    throw new ConfigurationError(
      "GMAIL_PUBSUB_AUDIENCE and GMAIL_PUBSUB_SERVICE_ACCOUNT_EMAIL must both be set",
    );
  }

  return { audience, serviceAccountEmail };
};

export const getOpenAiApiKey = (
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  const value = env.OPENAI_API_KEY?.trim();
  return value || undefined;
};

export const getOpenAiModel = (
  env: NodeJS.ProcessEnv = process.env,
): string => env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
