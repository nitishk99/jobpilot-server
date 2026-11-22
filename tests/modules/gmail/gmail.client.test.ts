import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

const mock = {
  getRepository: jest.fn(),
  findAccount: jest.fn(),
  updateAccount: jest.fn(),
  setCredentials: jest.fn(),
  getAccessToken: jest.fn(),
  gmail: {},
  createGmailClient: jest.fn(),
};

jest.mock("../../../src/config/db.js", () => ({
  AppDataSource: {
    getRepository: (...args) => mock.getRepository(...args),
  },
}));

jest.mock("google-auth-library", () => ({
  OAuth2Client: class {
    setCredentials(credentials: unknown) {
      mock.setCredentials(credentials);
    }

    getAccessToken() {
      return mock.getAccessToken();
    }
  },
}));

jest.mock("googleapis", () => ({
  google: {
    gmail: (...args) => mock.createGmailClient(...args),
  },
}));

import {
  createGmailClientForUser,
  GmailSyncError,
} from "../../../src/modules/gmail/gmail.client.js";

describe("Gmail API client", () => {
  const savedCredentials = {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
    mock.getRepository.mockReturnValue({
      findOneBy: mock.findAccount,
      update: mock.updateAccount,
    });
    mock.findAccount.mockResolvedValue({
      id: "account-1",
      userId: "user-1",
      provider: "GOOGLE",
      refreshToken: "refresh-token",
      scopes: "https://www.googleapis.com/auth/gmail.readonly",
      status: "ACTIVE",
    });
    mock.updateAccount.mockResolvedValue({ affected: 1 });
    mock.getAccessToken.mockResolvedValue({ token: "access-token" });
    mock.createGmailClient.mockReturnValue(mock.gmail);
  });

  afterEach(() => {
    jest.useRealTimers();
    if (savedCredentials.clientId === undefined) {
      delete process.env.GOOGLE_CLIENT_ID;
    } else {
      process.env.GOOGLE_CLIENT_ID = savedCredentials.clientId;
    }
    if (savedCredentials.clientSecret === undefined) {
      delete process.env.GOOGLE_CLIENT_SECRET;
    } else {
      process.env.GOOGLE_CLIENT_SECRET = savedCredentials.clientSecret;
    }
  });

  it("retries a transient token refresh failure before creating the Gmail client", async () => {
    jest.useFakeTimers();
    mock.getAccessToken
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValueOnce({ token: "access-token" });

    const client = createGmailClientForUser("user-1");
    await jest.advanceTimersByTimeAsync(250);

    await expect(client).resolves.toBe(mock.gmail);
    expect(mock.getAccessToken).toHaveBeenCalledTimes(2);
    expect(mock.setCredentials).toHaveBeenCalledWith({
      refresh_token: "refresh-token",
    });
  });

  it("marks the account for reconnection when Google rejects a refresh token", async () => {
    mock.getAccessToken.mockRejectedValueOnce({
      response: { data: { error: "invalid_grant" } },
    });

    await expect(createGmailClientForUser("user-1")).rejects.toMatchObject({
      code: "GOOGLE_REAUTH_REQUIRED",
      statusCode: 409,
    });
    expect(mock.updateAccount).toHaveBeenCalledWith(
      { id: "account-1" },
      { status: "REAUTH_REQUIRED" },
    );
  });

  it("maps insufficient Gmail authorization without marking the account revoked", async () => {
    mock.getAccessToken.mockRejectedValueOnce({
      response: {
        status: 403,
        data: {
          error: {
            errors: [{ reason: "insufficientPermissions" }],
          },
        },
      },
    });

    await expect(createGmailClientForUser("user-1")).rejects.toMatchObject({
      code: "GMAIL_ACCESS_DENIED",
      statusCode: 403,
    });
    expect(mock.updateAccount).not.toHaveBeenCalled();
  });

  it("rejects accounts without the Gmail read-only scope", async () => {
    mock.findAccount.mockResolvedValueOnce({
      id: "account-1",
      status: "ACTIVE",
      refreshToken: "refresh-token",
      scopes: "openid email",
    });

    await expect(createGmailClientForUser("user-1")).rejects.toBeInstanceOf(
      GmailSyncError,
    );
    expect(mock.updateAccount).toHaveBeenCalledWith(
      { id: "account-1" },
      { status: "REAUTH_REQUIRED" },
    );
    expect(mock.getAccessToken).not.toHaveBeenCalled();
  });
});
