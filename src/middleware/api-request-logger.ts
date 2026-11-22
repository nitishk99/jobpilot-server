import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

type ApiLogEvent = {
  event: string;
  requestId: string;
  method: string;
  path: string;
  timestamp: string;
  statusCode?: number;
  durationMs?: number;
};

const writeLog = (event: ApiLogEvent) => {
  console.log(JSON.stringify(event));
};

export const apiRequestLogger = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const requestId = randomUUID();
  const startedAt = Date.now();
  let responseFinished = false;

  res.setHeader("X-Request-Id", requestId);

  const requestDetails = {
    requestId,
    method: req.method,
    path: req.path,
  };

  writeLog({
    event: "api.request.started",
    ...requestDetails,
    timestamp: new Date().toISOString(),
  });

  res.once("finish", () => {
    responseFinished = true;
    writeLog({
      event: "api.request.completed",
      ...requestDetails,
      timestamp: new Date().toISOString(),
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });

  res.once("close", () => {
    if (responseFinished) {
      return;
    }

    writeLog({
      event: "api.request.disconnected",
      ...requestDetails,
      timestamp: new Date().toISOString(),
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });

  next();
};
