import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { app } from "../src/app.js";

// Endpoint integration tests driven by the mock carrier: no Browserbase, no live
// portal, deterministic. Exercises the server wiring the real carriers can't test
// in CI, the state machine, error-to-HTTP mapping, 400/404 guards, warm reuse.
// (The mock picks its outcome from the username: "baduser" / "nomfa" / else MFA.)

let base: string;
let server: Server;

before(async () => {
    await new Promise<void>((resolve) => {
        server = app.listen(0, () => {
            const { port } = server.address() as AddressInfo;
            base = `http://127.0.0.1:${port}`;
            resolve();
        });
    });
});

after(() => server.close());

async function post(path: string, body: unknown) {
    const res = await fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
}

test("GET /carriers lists the registered carriers", async () => {
    const res = await fetch(base + "/carriers");
    const body = (await res.json()) as { carriers: string[] };
    assert.equal(res.status, 200);
    assert.ok(body.carriers.includes("mock"));
    assert.ok(body.carriers.includes("allstate"));
    assert.ok(body.carriers.includes("assurant"));
});

test("POST /login rejects missing fields with 400", async () => {
    const { status } = await post("/login", { carrier: "mock" });
    assert.equal(status, 400);
});

test("POST /login rejects an unknown carrier with 400", async () => {
    const { status } = await post("/login", { carrier: "nope", username: "u", password: "p" });
    assert.equal(status, 400);
});

test("POST /login bad credentials maps to 401", async () => {
    const { status, body } = await post("/login", { carrier: "mock", username: "baduser", password: "p" });
    assert.equal(status, 401);
    assert.ok(body.error);
});

test("POST /login with no MFA goes straight to documents", async () => {
    const { status, body } = await post("/login", { carrier: "mock", username: "nomfa", password: "p" });
    assert.equal(status, 200);
    assert.equal(body.status, "done");
    assert.equal(body.documents.length, 1);
    assert.equal(body.documents[0].name, "declarations.pdf");
    assert.equal(body.documents[0].contentType, "application/pdf");
});

test("full MFA flow: login -> mfa_needed -> correct code -> documents", async () => {
    const login = await post("/login", { carrier: "mock", username: "alice", password: "p" });
    assert.equal(login.status, 200);
    assert.equal(login.body.status, "mfa_needed");
    assert.ok(login.body.sessionId);

    const mfa = await post("/mfa", { sessionId: login.body.sessionId, code: "123456" });
    assert.equal(mfa.status, 200);
    assert.equal(mfa.body.status, "done");
    assert.equal(mfa.body.documents.length, 1);
});

test("POST /mfa wrong code maps to 401", async () => {
    const login = await post("/login", { carrier: "mock", username: "bob", password: "p" });
    const mfa = await post("/mfa", { sessionId: login.body.sessionId, code: "000000" });
    assert.equal(mfa.status, 401);
});

test("a document-fetch failure after login maps to 502", async () => {
    const { status, body } = await post("/login", { carrier: "mock", username: "docfail", password: "p" });
    assert.equal(status, 502); // DocumentsUnavailableError
    assert.ok(body.error);
});

test("POST /mfa for an unknown session is 404", async () => {
    const { status } = await post("/mfa", { sessionId: "does-not-exist", code: "123456" });
    assert.equal(status, 404);
});

test("POST /mfa missing fields is 400", async () => {
    const { status } = await post("/mfa", { sessionId: "x" });
    assert.equal(status, 400);
});

test("POST /mfa on a session not awaiting MFA is 409", async () => {
    // a pre-warmed session is WARM, not AWAITING_MFA
    const warm = await post("/prepare", { carrier: "mock" });
    assert.equal(warm.status, 200);
    const { status } = await post("/mfa", { sessionId: warm.body.warmId, code: "123456" });
    assert.equal(status, 409);
});

test("pre-warm then login reuses the warm session", async () => {
    const warm = await post("/prepare", { carrier: "mock" });
    assert.equal(warm.status, 200);
    assert.ok(warm.body.warmId);
    const login = await post("/login", {
        carrier: "mock",
        username: "nomfa",
        password: "p",
        warmId: warm.body.warmId,
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.status, "done");
    assert.equal(login.body.sessionId, warm.body.warmId); // same session, reused
});

// --- errors that happen outside a route handler must still return JSON, no stack ---

const leak = /node_modules|\/home\/|SyntaxError|\bat /; // signs of a leaked stack trace

test("unknown route returns a JSON 404, not HTML", async () => {
    const res = await fetch(base + "/does-not-exist");
    const text = await res.text();
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    assert.equal(JSON.parse(text).error, "not found");
    assert.doesNotMatch(text, leak);
});

test("wrong method on a known route returns a JSON 404", async () => {
    const res = await fetch(base + "/carriers", { method: "POST" });
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
});

test("malformed JSON body returns a JSON 400 with no stack leak", async () => {
    const res = await fetch(base + "/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{ this is not json",
    });
    const text = await res.text();
    assert.equal(res.status, 400);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    assert.ok(JSON.parse(text).error);
    assert.doesNotMatch(text, leak);
});

test("oversized body returns a JSON 413 with no stack leak", async () => {
    const res = await fetch(base + "/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ carrier: "mock", x: "A".repeat(200_000) }),
    });
    const text = await res.text();
    assert.equal(res.status, 413);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    assert.doesNotMatch(text, leak);
});
