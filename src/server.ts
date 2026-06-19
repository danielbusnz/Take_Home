import express from "express";
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import type { Carrier, SessionState } from "./types.js";
import { MockCarrier } from "./carriers/mock.js";
import {
  CarrierError,
  InvalidCredentialsError,
  InvalidMfaError,
  AntiBotError,
  CarrierTimeoutError,
  DocumentsUnavailableError,
} from "./errors.js";

const app = express();
app.use(express.json());

// sessionId -> the live session. This Map is the entire "database".
type Session = { state: SessionState; carrier: Carrier };
const sessions = new Map<string, Session>();

// Carrier name -> factory. Add real carriers here behind the same interface.
const carriers: Record<string, () => Carrier> = {
  mock: () => new MockCarrier(),
};

app.post("/login", async (req, res) => {
  const { carrier: carrierName, username, password } = req.body;
  const make = carriers[carrierName];
  if (!make) return res.status(400).json({ error: "unknown carrier" });

  const sessionId = randomUUID();
  const session: Session = { state: "LOGGING_IN", carrier: make() };
  sessions.set(sessionId, session);

  try {
    const { mfaRequired } = await session.carrier.login(username, password);
    if (mfaRequired) {
      session.state = "AWAITING_MFA";
      return res.json({ status: "mfa_needed", sessionId });
    }
    // trusted device, no MFA: go straight to documents
    const documents = await fetchAndFinish(sessionId, session);
    return res.json({ status: "done", sessionId, documents });
  } catch (e) {
    await cleanup(sessionId);
    return sendError(res, e);
  }
});

app.post("/mfa", async (req, res) => {
  const { sessionId, code } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "no such session" });
  if (session.state !== "AWAITING_MFA")
    return res.status(409).json({ error: `session is ${session.state}, not awaiting MFA` });

  try {
    session.state = "SUBMITTING_MFA";
    await session.carrier.submitMfa(code);
    const documents = await fetchAndFinish(sessionId, session);
    return res.json({ status: "done", documents });
  } catch (e) {
    await cleanup(sessionId);
    return sendError(res, e);
  }
});

// Fetch docs, close the browser, drop the session. Shared by both endpoints.
async function fetchAndFinish(sessionId: string, session: Session) {
  session.state = "FETCHING_DOCS";
  const documents = await session.carrier.fetchDocuments();
  session.state = "DONE";
  await session.carrier.close();
  sessions.delete(sessionId);
  return documents;
}

// Close the browser and drop the session after a failure. Never throws.
async function cleanup(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;
  try {
    await session.carrier.close();
  } catch {}
  sessions.delete(sessionId);
}

// Map a thrown error to a status code. Unknown errors are a 500.
function sendError(res: Response, e: unknown) {
  if (e instanceof InvalidCredentialsError || e instanceof InvalidMfaError)
    return res.status(401).json({ error: e.message });
  if (e instanceof AntiBotError) return res.status(503).json({ error: e.message });
  if (e instanceof CarrierTimeoutError) return res.status(504).json({ error: e.message });
  if (e instanceof DocumentsUnavailableError) return res.status(502).json({ error: e.message });
  if (e instanceof CarrierError) return res.status(500).json({ error: e.message });
  console.error(e);
  return res.status(500).json({ error: "internal error" });
}

app.listen(3000, () => console.log("up on :3000"));
