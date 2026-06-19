import type { Carrier } from "../types.js";
import { MockCarrier } from "./mock.js";
import { AllstateCarrier } from "./allstate.js";

// Carrier name -> factory. Add a real carrier here behind the same interface;
// the server and the frontend dropdown both read from this one place.
export const carriers: Record<string, (contextId?: string) => Carrier> = {
    mock: (contextId) => new MockCarrier(contextId),
    allstate: (contextId) => new AllstateCarrier(contextId),
};
