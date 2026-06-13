// Fixture: a *manual* defineDag carrying the legacy request-carrier idiom — a
// transform whose sole input is DAG_INPUT and whose input/output schemas are the
// SAME reference. It is structurally valid (ok: true), but the B2 advisory
// (`redundant-passthrough`) must ride alongside in runLint's result.

import { z } from "zod";
import { defineDag, createTransformNode, ok } from "../../../index.js";
import { DAG_INPUT } from "../../../types/ids.js";

const Req = z.object({ region: z.string() });

const readRequest = createTransformNode({
  id: "read-request",
  inputSchema: Req,
  outputSchema: Req, // SAME reference — forwards its input unchanged
  transform: (req) => ok(req),
});

const consume = createTransformNode({
  id: "consume",
  inputSchema: Req,
  outputSchema: z.object({ ok: z.boolean() }),
  transform: () => ok({ ok: true }),
});

const dag = defineDag({
  id: "manual-redundant-passthrough",
  nodes: { "read-request": readRequest, consume },
  edges: [
    { from: DAG_INPUT, to: "read-request" },
    { from: "read-request", to: "consume" },
  ],
  outputNodeId: "consume",
});

export default {
  dag,
  inputSchema: Req,
  meta: { description: "Manual request-carrier — redundant-passthrough fixture", version: "1.0.0" },
};
