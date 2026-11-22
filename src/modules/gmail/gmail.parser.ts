import { gmail_v1 } from "googleapis";
import { Email } from "../../database/entities/Email.js";

export type ParsedGmailEmail = Omit<
  Pick<
    Email,
    | "userId"
    | "applicationId"
    | "gmailMessageId"
    | "gmailThreadId"
    | "fromEmail"
    | "toEmail"
    | "subject"
    | "bodyText"
    | "receivedAt"
  >,
  "bodyText"
> & { bodyText: string };

export class GmailMessageWithoutBodyError extends Error {
  constructor() {
    super("Gmail message has no readable body");
    this.name = "GmailMessageWithoutBodyError";
  }
}

const getHeader = (
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string | null =>
  headers?.find((header) => header.name?.toLowerCase() === name)?.value ?? null;

const getMailboxAddress = (headerValue: string | null): string | null => {
  if (!headerValue) {
    return null;
  }
  const angleBracketAddress = headerValue.match(/<([^<>]+)>/);
  return (angleBracketAddress?.[1] ?? headerValue).trim() || null;
};

const decodeBase64Url = (value: string): string =>
  Buffer.from(value, "base64url").toString("utf8");

const MAX_INLINE_URL_LENGTH = 180;
const CTA_ONLY_PATTERN =
  /^(?:apply now|proceed|click here|view job|view details|get app|get the app|scan to download|available on|download now|learn more)$/i;
const FOOTER_START_PATTERN =
  /^(?:do not share this email|this email was sent from a notification-only address|this is an? (?:automated|system-generated) (?:email|message)|unsubscribe(?:\s|$|\|)|manage (?:job )?(?:alerts|preferences)(?:\s|$|:)|you have received this mail because|the sender of this email is registered with|please do not pay any money|all rights reserved|privacy policy(?:\s|$|:)|terms (?:&|and) conditions(?:\s|$|:))/i;

const compactLongUrl = (url: string): string => {
  if (url.length <= MAX_INLINE_URL_LENGTH) {
    return url;
  }

  try {
    const parsed = new URL(url);
    const isIndeedRedirect =
      parsed.hostname.endsWith("indeed.com") &&
      parsed.searchParams.has("jk");
    if (!isIndeedRedirect) {
      return url;
    }
    return `${parsed.origin}${parsed.pathname}?jk=${encodeURIComponent(
      parsed.searchParams.get("jk")!,
    )}`;
  } catch {
    return url;
  }
};

const normalizeEmailText = (value: string): string =>
  value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\uFEFF\u00AD]/g, "")
    .replace(/\\([*_])/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/gm, "$1$2")
    .replace(/https?:\/\/[^\s<>]+/gi, compactLongUrl)
    .split("\n")
    .map((line) => line.trim())
    .filter((line, index, lines) =>
      line.length > 0 || (index > 0 && lines[index - 1].length > 0),
    )
    .filter((line) => !CTA_ONLY_PATTERN.test(line))
    .filter((line, index, lines) => line !== lines[index - 1])
    .map((line) =>
      line
        .replace(/^o[\t ]+/i, "- ")
        .replace(/^[•▪◦]\s*/, "- "),
    )
    .join("\n")
    .replace(/\n{2,}/g, "\n\n")
    .trim();

const removeEmailFooter = (value: string): string => {
  const lines = value.split("\n");
  const footerIndex = lines.findIndex((line, index) =>
    index > 0 && FOOTER_START_PATTERN.test(line),
  );
  return (footerIndex === -1 ? lines : lines.slice(0, footerIndex))
    .join("\n")
    .trim();
};

export const sanitizeEmailText = (value: string): string =>
  removeEmailFooter(normalizeEmailText(value));

const findBodyForMimeType = (
  part: gmail_v1.Schema$MessagePart | undefined,
  mimeType: string,
): string | null => {
  if (!part) {
    return null;
  }
  if (part.mimeType?.toLowerCase() === mimeType && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  for (const child of part.parts ?? []) {
    const text = findBodyForMimeType(child, mimeType);
    if (text !== null) {
      return text;
    }
  }
  return null;
};

const decodeHtmlEntities = (value: string): string =>
  value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_entity, decimal: string) => {
      const codePoint = Number(decimal);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : " ";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_entity, hexadecimal: string) => {
      const codePoint = Number.parseInt(hexadecimal, 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : " ";
    });

const htmlToText = (html: string): string =>
  decodeHtmlEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<(?:noscript|svg|img|video|audio)\b[^>]*>[\s\S]*?<\/(?:noscript|svg|video|audio)>/gi, " ")
      .replace(/<(?:img)\b[^>]*>/gi, " ")
      .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
        (_match, href: string, label: string) => {
          const text = label.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
          if (!text || text.toLowerCase() === href.toLowerCase()) {
            return ` ${href} `;
          }
          return ` ${text}: ${href} `;
        })
      .replace(/<br\b[^>]*>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<\/(?:li|td|th)>\s*/gi, "\n")
      .replace(/<\/tr\s*>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, "\n")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const bodyQualityScore = (body: string): number => {
  const lines = body.split("\n").filter((line) => line.trim());
  if (!lines.length) {
    return 0;
  }
  const meaningfulLines = lines.filter((line) =>
    line.length > 2 && !CTA_ONLY_PATTERN.test(line),
  ).length;
  const blankLineCount = (body.match(/\n\n/g) ?? []).length;
  return body.length + meaningfulLines * 20 - blankLineCount * 20;
};

const selectBestEmailBody = (
  plainTextBody: string | null,
  htmlBody: string | null,
): string => {
  const candidates = [
    plainTextBody ? sanitizeEmailText(plainTextBody) : "",
    htmlBody ? sanitizeEmailText(htmlToText(htmlBody)) : "",
  ].filter(Boolean);
  return candidates.sort(
    (left, right) => bodyQualityScore(right) - bodyQualityScore(left),
  )[0] ?? "";
};

export const parseGmailMessage = (
  message: gmail_v1.Schema$Message,
  userId: string,
): ParsedGmailEmail => {
  const messageId = message.id;
  const threadId = message.threadId;
  const headers = message.payload?.headers;
  const fromEmail = getMailboxAddress(getHeader(headers, "from"));

  if (!messageId || !threadId || !fromEmail) {
    throw new Error("Gmail message is missing required fields");
  }

  const internalDate =
    typeof message.internalDate === "string"
      ? Number(message.internalDate)
      : Number.NaN;
  const dateHeader = getHeader(headers, "date");
  const headerDate = dateHeader ? new Date(dateHeader) : null;
  const receivedAt =
    Number.isFinite(internalDate) && internalDate > 0
      ? new Date(internalDate)
      : headerDate && Number.isFinite(headerDate.getTime())
        ? headerDate
        : null;

  if (!receivedAt) {
    throw new Error("Gmail message is missing a valid received date");
  }

  const plainTextBody = findBodyForMimeType(message.payload, "text/plain");
  const htmlBody = findBodyForMimeType(message.payload, "text/html");
  const bodyText = selectBestEmailBody(plainTextBody, htmlBody);
  if (!bodyText) {
    throw new GmailMessageWithoutBodyError();
  }

  return {
    userId,
    applicationId: null,
    gmailMessageId: messageId,
    gmailThreadId: threadId,
    fromEmail,
    toEmail: getMailboxAddress(getHeader(headers, "to")),
    subject: getHeader(headers, "subject"),
    bodyText,
    receivedAt,
  };
};
