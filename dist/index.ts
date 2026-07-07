import fs from "fs";
import path from "path";

const envCandidates = [
  path.join(__dirname, "Handlers", ".env"),
  path.join(process.cwd(), "Handlers", ".env"),
  path.join(__dirname, ".env"),
  path.join(process.cwd(), ".env"),
];
const envFile = envCandidates.find((p) => fs.existsSync(p));

const { config } = require("dotenv");
config({ path: envFile });

require("./Handlers/Server");
