import { Hono } from "hono";
import type { Hub } from "../hub.js";
import { readJsonObject } from "../http.js";
import { answerInvitation, listInvitations, retryAnswer, undoAnswer } from "../invitations.js";

/**
 * Invitations (invitations.ts, CONTRACT.md section 3): the list, and the owner's Accept, Maybe and Decline, each
 * answered through where the invitation came from; Undo and Try again for an answer that goes by mail.
 */
export function invitationRoutes() {
  const r = new Hono<{ Variables: { hub: Hub } }>();
  r.get("/invitations", (c) => {
    const { pending, answered } = listInvitations(c.get("hub"));
    return c.json({ pending, answered });
  });
  r.post("/invitations/:id/answer", async (c) => {
    const body = await readJsonObject(c);
    return c.json(await answerInvitation(c.get("hub"), c.req.param("id"), body.answer));
  });
  r.post("/invitations/:id/undo", (c) => c.json(undoAnswer(c.get("hub"), c.req.param("id"))));
  r.post("/invitations/:id/retry", (c) => c.json(retryAnswer(c.get("hub"), c.req.param("id"))));
  return r;
}
