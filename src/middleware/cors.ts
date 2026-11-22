import cors from "cors";
import { getAllowedClientOrigins } from "../config/env.js";

export const corsMiddleware = cors({
  origin: (origin, callback) => {
    const allowedOrigins = new Set(getAllowedClientOrigins());
    callback(null, origin && allowedOrigins.has(origin) ? origin : false);
  },
  credentials: true,
  methods: ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
});
