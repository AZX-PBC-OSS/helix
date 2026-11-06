// Contracts for the edge's /_api/me routes (ADR-0054).
import { MeResponseSchema } from "../../auth.js";
import { jsonResponse } from "../define.js";
import { appRoute } from "./common.js";

const tags = ["Identity"] as const;

export const getMe = appRoute({
  id: "getMe",
  method: "GET",
  path: "/_api/me",
  auth: "session",
  tags,
  summary: "Read the signed-in user",
  description:
    "How a static app learns who is signed in: the principal id, display name and email " +
    "address, and nothing else. Use `id` to key data; never display it.",
  responses: {
    200: jsonResponse(MeResponseSchema, "The signed-in user."),
  },
});

export const meContracts = [getMe] as const;
