import { sql } from "../src/db.js";
import { createSetupStartHandler } from "../src/intake-setup-handler.js";
export default createSetupStartHandler(sql);
