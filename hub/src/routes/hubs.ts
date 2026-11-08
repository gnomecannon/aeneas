import { Hono } from "hono";
import type { Hub } from "../hub.js";
import { readJsonObject } from "../http.js";
import { ADMIN_NOTE, SETUP_COMMAND, addPerson, hubsState, listHubs, pairPerson, requestResult, stopPerson } from "../hubs.js";

/** Other people's hubs on this machine (hubs.ts): Settings, People on this machine. */
export function hubsRoutes() {
  const r = new Hono<{ Variables: { hub: Hub } }>();
  r.get("/hubs", async (c) => {
    const state = hubsState();
    return c.json({ ...state, setup_command: SETUP_COMMAND, admin_note: ADMIN_NOTE, hubs: state.available ? await listHubs() : [] });
  });
  r.post("/hubs", async (c) => c.json(addPerson(await readJsonObject(c)), 202));
  r.get("/hubs/requests/:id", (c) => c.json(requestResult(c.req.param("id"))));
  r.post("/hubs/:account/pair", (c) => c.json(pairPerson(c.req.param("account")), 202));
  r.post("/hubs/:account/stop", (c) => c.json(stopPerson(c.req.param("account")), 202));
  return r;
}
