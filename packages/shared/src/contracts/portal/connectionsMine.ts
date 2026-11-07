// Contracts for apps/portal/src/routes/connectionsMine.ts (ADR-0054).
import { z } from "zod";
import { DisconnectResponseSchema, MyConnectionsResponseSchema } from "../../connections.js";
import { jsonResponse } from "../define.js";
import { apiError, portalRoute } from "./common.js";

const tags = ["Connections"] as const;

export const listMyConnections = portalRoute({
  id: "listMyConnections",
  method: "GET",
  path: "/api/v1/connections/mine",
  tags,
  summary: "List the caller's connections",
  description:
    "The caller's own connected accounts, newest first, as metadata only. Each entry names " +
    "the apps that use the connection's provider.",
  responses: {
    200: jsonResponse(MyConnectionsResponseSchema, "The caller's connections."),
  },
});

export const disconnectMyConnection = portalRoute({
  id: "disconnectMyConnection",
  method: "DELETE",
  path: "/api/v1/connections/mine/:id",
  tags,
  summary: "Disconnect one of the caller's connections",
  description:
    "Invalidates the connection, cancels its pending consent attempts, and audits the " +
    "removal in one transaction. A repeat answers `already_removed`.",
  params: z.object({ id: z.string().meta({ description: "The connection's id." }) }),
  responses: {
    200: jsonResponse(DisconnectResponseSchema, "Whether this call removed the connection."),
    404: apiError("The caller has no connection with this id (`not_found`)."),
  },
});

export const connectionsMineContracts = [listMyConnections, disconnectMyConnection] as const;
