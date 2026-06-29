// Small shared helpers over the queue board's lane model.
import { Lane } from "../types";

/** The live terminal a lane runs in: an existing session, or the one a spawn
 *  lane created on first run. Undefined for a spawn lane not yet started. */
export const laneLiveTerm = (lane: Lane): string | undefined =>
  lane.target.kind === "session" ? lane.target.termId : lane.boundTermId;
