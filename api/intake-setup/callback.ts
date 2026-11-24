import { sql } from "../../src/db.js";
import { createSetupCallbackHandler } from "../../src/intake-setup-callback.js";
export default createSetupCallbackHandler(sql);
