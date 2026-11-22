import type { Response } from "express";

export interface ApiResponse<T = null> {
  success: boolean;
  message: string;
  data: T | null;
  error: string | null;
}

export const sendSuccess = <T>(
  res: Response,
  statusCode: number,
  message: string,
  data: T | null = null,
) =>
  res.status(statusCode).json({
    success: true,
    message,
    data,
    error: null,
  } satisfies ApiResponse<T>);

export const sendError = (
  res: Response,
  statusCode: number,
  error: string,
) =>
  res.status(statusCode).json({
    success: false,
    message: error,
    data: null,
    error,
  } satisfies ApiResponse);
