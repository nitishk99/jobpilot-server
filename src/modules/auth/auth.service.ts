import { OAuth2Client } from "google-auth-library";
import { AppDataSource } from "../../config/db.js";
import { getGoogleOAuthConfig } from "../../config/env.js";
import { ConnectedAccount } from "../../database/entities/ConnectedAccount.js";
import { User } from "../../database/entities/User.js";
import { AuthConfigurationError } from "./auth.session.js";

export * from "./auth.session.js";

const GOOGLE_OAUTH_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
];

const getGoogleOAuthConfiguration = () => {
  try {
    return getGoogleOAuthConfig();
  } catch {
    throw new AuthConfigurationError(
      "Google OAuth credentials and redirect URI must be configured",
    );
  }
};

const createOAuthClient = (): OAuth2Client => {
  const { clientId, clientSecret, redirectUri } =
    getGoogleOAuthConfiguration();
  return new OAuth2Client(clientId, clientSecret, redirectUri);
};

export const getGoogleAuthorizationUrl = (state: string): string => {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    include_granted_scopes: true,
    prompt: "consent",
    scope: GOOGLE_OAUTH_SCOPES,
    state,
  });
};

interface GoogleIdentity {
  sub: string;
  email: string;
  displayName: string;
  profilePicture: string | null;
}

const verifyGoogleIdentity = async (
  client: OAuth2Client,
  idToken: string,
): Promise<GoogleIdentity> => {
  const { clientId } = getGoogleOAuthConfiguration();
  const ticket = await client.verifyIdToken({
    idToken,
    audience: clientId,
  });
  const payload = ticket.getPayload();
  const issuerIsValid =
    payload?.iss === "https://accounts.google.com" ||
    payload?.iss === "accounts.google.com";
  const audienceIsValid =
    payload?.aud === clientId ||
    (Array.isArray(payload?.aud) && payload.aud.includes(clientId));

  if (
    !payload ||
    !issuerIsValid ||
    !audienceIsValid ||
    (payload.azp !== undefined && payload.azp !== clientId) ||
    (Array.isArray(payload.aud) &&
      payload.aud.length > 1 &&
      payload.azp !== clientId) ||
    typeof payload.sub !== "string" ||
    !payload.sub ||
    typeof payload.email !== "string" ||
    !payload.email ||
    payload.email_verified !== true
  ) {
    throw new Error("Google identity token claims are invalid");
  }

  return {
    sub: payload.sub,
    email: payload.email.toLowerCase(),
    displayName: payload.name?.trim() || payload.email,
    profilePicture: payload.picture ?? null,
  };
};

export const authenticateGoogleCode = async (
  code: string,
  sessionTokenHash: string,
  sessionExpiresAt: Date,
): Promise<string> => {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  const accessToken = tokens.access_token;
  const refreshToken = tokens.refresh_token;

  if (!tokens.id_token || !accessToken) {
    throw new Error("Google did not return the required OAuth tokens");
  }

  const identity = await verifyGoogleIdentity(client, tokens.id_token);
  const expiresAt =
    typeof tokens.expiry_date === "number" &&
    Number.isFinite(tokens.expiry_date)
      ? new Date(tokens.expiry_date)
      : null;

  return AppDataSource.transaction(async (manager) => {
    const connectedAccounts = manager.getRepository(ConnectedAccount);
    const users = manager.getRepository(User);
    const existingAccount = await connectedAccounts.findOneBy({
      provider: "GOOGLE",
      providerAccountId: identity.sub,
    });

    if (!refreshToken && !existingAccount?.refreshToken) {
      throw new Error("Google did not provide a refresh token for this account");
    }

    let user = await users.findOneBy({ googleSub: identity.sub });
    if (user && existingAccount && existingAccount.userId !== user.id) {
      throw new Error("Google account is linked to a different user");
    }

    if (!user) {
      user = users.create({
        googleSub: identity.sub,
        email: identity.email,
        displayName: identity.displayName,
        profilePicture: identity.profilePicture,
        sessionTokenHash,
        sessionExpiresAt,
      });
    } else {
      user.email = identity.email;
      user.displayName = identity.displayName;
      user.profilePicture = identity.profilePicture;
      user.sessionTokenHash = sessionTokenHash;
      user.sessionExpiresAt = sessionExpiresAt;
    }

    const savedUser = await users.save(user);
    const account =
      existingAccount ??
      connectedAccounts.create({
        provider: "GOOGLE",
        providerAccountId: identity.sub,
      });

    if (account.userId && account.userId !== savedUser.id) {
      throw new Error("Google account is linked to a different user");
    }

    account.userId = savedUser.id;
    account.email = identity.email;
    account.accessToken = accessToken;
    account.refreshToken =
      refreshToken ?? existingAccount?.refreshToken ?? null;
    account.tokenExpiresAt = expiresAt;
    account.scopes = tokens.scope ?? GOOGLE_OAUTH_SCOPES.join(" ");
    account.status = "ACTIVE";

    await connectedAccounts.save(account);
    return savedUser.id;
  });
};

export const validateOAuthConfiguration = (): void => {
  createOAuthClient();
};
