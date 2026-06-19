import { app } from "./app.js";
import { startReaper } from "./sessions.js";

// Startup: the long-running entrypoint. app.ts builds the routes; here we start
// the idle-session reaper and bind the port (platforms like Fly inject PORT).
startReaper();
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`up on :${PORT}`));
