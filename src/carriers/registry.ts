import type { Carrier } from "../types.js";
import { MockCarrier } from "./mock.js";
import { AllstateCarrier } from "./allstate.js";
import { AssurantCarrier } from "./assurant.js";

// Carrier name -> factory. Add a real carrier here behind the same interface;
// the server and the frontend dropdown both read from this one place.
export const carriers: Record<string, () => Carrier> = {
    mock: () => new MockCarrier(),
    allstate: () => new AllstateCarrier(),
    assurant: () => new AssurantCarrier(),
};
