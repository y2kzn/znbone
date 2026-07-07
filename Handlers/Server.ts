import { config as loadEnv } from "dotenv";
import fsSync from "fs";
import path from "path";

// Must use require-style execution order: dotenv BEFORE any module that reads process.env
// ESM imports are hoisted, so we force dotenv to run first via side-effect
const _envCandidates = [
  path.join(__dirname, ".env"),
  path.join(__dirname, "..", "Handlers", ".env"),
  path.join(process.cwd(), "Handlers", ".env"),
  path.join(process.cwd(), ".env"),
];
const _envFile = _envCandidates.find((p) => fsSync.existsSync(p));
loadEnv({ path: _envFile });

import e, { NextFunction, Request, Response } from "express";
import fs from "fs/promises";
import cors from "cors";
import { BODY_SIZE_LIMIT, IS_DEBUG, PORT, PROJECT_NAME } from "../Modules/Constants";
import { msg, warn, toGradient, err } from "../Modules/Logger";
import { gray, italic, magenta, red } from "colorette";
import { E_NotFound, E_ServerError } from "../Modules/Errors";
import { GeneratePrizepoolId, Register } from "../Modules/Extensions";
import mongoose from "mongoose";
import { CreateSignedUpUser, CreateTournament } from "./Database";
import { Emotes, IS_MAINTENANCE, Scenes, TournamentPhaseType } from "../Backbone/Config";
import { Qualify } from "../Backbone/Logic/GetMatches";
import { Tournament } from "../Models/Tournament";
import { BackboneUser } from "../Models/BackboneUser";
import { StartLoop } from "../Backbone/Logic/Internal/Resolving";
import { TournamentBot } from "./Bot";
import { TournamentScheduler } from "./Scheduler";
import { TournamentCleaner } from "./Deleter";
import { Db, MongoClient } from "mongodb";

export const App = e()
  .disable("etag")
  .disable("x-powered-by")
  .use(e.json({ limit: BODY_SIZE_LIMIT }))
  .use(e.urlencoded({ limit: BODY_SIZE_LIMIT, extended: false }))
  .use(cors({ origin: "*" }));

const requestTracker = new Map();
const cleanupTracker = () => {
  const now = Date.now();
  for (const [key, data] of requestTracker.entries()) {
    if (now - data.time > 10000) requestTracker.delete(key);
  }
};
setInterval(cleanupTracker, 30000);

App.use((req: Request, res: Response, next: NextFunction) => {
  const ip = req.ip || req.socket.remoteAddress || '';
  const path = req.path.toLowerCase();
  const now = Date.now();
  
  const key = `${ip}:${path}`;
  const data = requestTracker.get(key) || { count: 0, time: now };
  
  if (now - data.time < 1000 && data.count > 30) {
    warn(`RateLimit 429 ip=${ip} path=${req.originalUrl} count=${data.count}`);
    return res.status(429).json({});
  }
  
  if (now - data.time > 1000) {
    data.count = 1;
    data.time = now;
  } else {
    data.count++;
  }
  
  requestTracker.set(key, data);
  
  const size = parseInt(req.headers['content-length'] || '0');
  if (size > 10 * 1024 * 1024) {
    warn(`PayloadTooLarge 413 ip=${ip} path=${req.originalUrl} size=${size}`);
    return res.status(413).json({});
  }
  
  const badPatterns = [
    /union.*select/i, /select.*from/i, /insert.*into/i, /update.*set/i,
    /delete.*from/i, /drop.*table/i, /create.*table/i, /exec.*\(/i,
    /eval.*\(/i, /script.*>/i, /onload=.*/i, /onerror=.*/i,
    /javascript:/i, /data:/i
  ];
  
  for (const pattern of badPatterns) {
    if (pattern.test(req.url) || pattern.test(JSON.stringify(req.body))) {
      warn(`BadPattern 400 ip=${ip} path=${req.originalUrl} pattern=${pattern}`);
      return res.status(400).json({});
    }
  }
  
  next();
});

App.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

process.on("uncaughtException", (Error) => {
  err(`Unhandled exception: ${(Error as Error).stack || (Error as Error).message}`);
});

process.on("unhandledRejection", (Reason) => {
  const Message = Reason instanceof Error ? Reason.stack || Reason.message : String(Reason);
  if (Message.includes("MongoNetworkTimeoutError") || Message.includes("MongoNetworkError") || Message.includes("connection timed out")) return;
  err(`Unhandled rejection: ${Message}`);
});
let StarDb: Db;
const STAR_DB_NAME = process.env.STAR_DB_NAME || process.env.DB_NAME || "StumbleStar";

function createDate(year: number, month: number, day: number, hours: number, minutes: number = 0): Date {
  return new Date(year, month - 1, day, hours, minutes, 0, 0);
}

function MakeGradient(): [string, string] {
  const BaseHue = Math.floor(Math.random() * 360);
  const BaseSaturation = 70 + Math.random() * 20;
  const BaseLightness = 50 + Math.random() * 15;

  const EndHue = (BaseHue + 15 + Math.random() * 30) % 360;
  const EndSaturation = BaseSaturation + (Math.random() * 10 - 5);
  const EndLightness = BaseLightness + (Math.random() * 20 - 10);

  return [ConvertToHex(BaseHue, BaseSaturation, BaseLightness), ConvertToHex(EndHue, EndSaturation, EndLightness)];
}

function ConvertToHex(H: number, S: number, L: number): string {
  const Saturation = S / 100;
  const Lightness = L / 100;

  const C = (1 - Math.abs(2 * Lightness - 1)) * Saturation;
  const X = C * (1 - Math.abs(((H / 60) % 2) - 1));
  const M = Lightness - C / 2;

  let R = 0,
    G = 0,
    B = 0;

  if (H >= 0 && H < 60) {
    R = C;
    G = X;
    B = 0;
  } else if (H >= 60 && H < 120) {
    R = X;
    G = C;
    B = 0;
  } else if (H >= 120 && H < 180) {
    R = 0;
    G = C;
    B = X;
  } else if (H >= 180 && H < 240) {
    R = 0;
    G = X;
    B = C;
  } else if (H >= 240 && H < 300) {
    R = X;
    G = 0;
    B = C;
  } else {
    R = C;
    G = 0;
    B = X;
  }

  const ToHex = (V: number) =>
    Math.round((V + M) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${ToHex(R)}${ToHex(G)}${ToHex(B)}`;
}

async function LoadRoutes(
  Dir: string,
  Routes: Array<{ Path: string; Module: any }> = []
): Promise<Array<{ Path: string; Module: any }>> {
  const Entries = await fs.readdir(Dir, { withFileTypes: true });

  await Promise.all(
    Entries.map(async (Entry) => {
      const FullPath = path.join(Dir, Entry.name);

      if (Entry.isDirectory()) {
        await LoadRoutes(FullPath, Routes);
      } else if (Entry.isFile() && (Entry.name.endsWith(".ts") || Entry.name.endsWith(".js"))) {
        try {
          msg(`LoadRoutes: importing ${FullPath}`);
          const Module = await import(path.resolve(FullPath));
          if (Module.default?.App) {
            Routes.push({ Path: Entry.name, Module: Module.default });
          }
        } catch (Err) {
          warn(
            `Failed loading ${italic(Entry.name)} (${FullPath}): ${(Err as Error).message}`,
          );
        }
      }
    })
  );

  return Routes;
}

async function Start() {
  const isTranspiling =
    Symbol.for("ts-node.register.instance") in process ||
    process.argv.some((a) => a.endsWith(".ts")) ||
    !!process.env.TSX_TSCONFIG_PATH;

  const RoutesDir = isTranspiling
    ? path.join(".", "Routes")
    : path.join(".", "dist", "Routes");

  const dbUri = process.env.DATABASE_URI;
  if (!dbUri) throw new Error("DATABASE_URI is not defined. Check that Handlers/.env is loaded.");

  let client: MongoClient;
  const [DbConnection, RoutesList] = await Promise.all([
    mongoose.connect(dbUri, {
      dbName: STAR_DB_NAME,
      tls: true,
      tlsAllowInvalidCertificates: true,
      rejectUnauthorized: false,
      maxPoolSize: 20,
      minPoolSize: 2,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 15000,
      serverSelectionTimeoutMS: 15000,
      heartbeatFrequencyMS: 30000,
      family: 4,
      retryWrites: true,
      retryReads: true,
    }),
    LoadRoutes(RoutesDir),
    (async () => {
      client = new MongoClient(dbUri);
      await client.connect();
      StarDb = client.db(STAR_DB_NAME);
    })(),
  ]);

  App.use((Req: Request, Res: Response, Next: NextFunction) => {
    if (IS_MAINTENANCE) {
      return Res.status(503).json({});
    }
    Next();
  });

  App.use(Register);

  for (const { Path, Module } of RoutesList) {
    const MountPath = Module.DefaultAPI || "/";
    App.use(MountPath, Module.App);
    const [Start, End] = MakeGradient();
    msg(`Loaded ${italic(toGradient(Path, Start, End))}`);
  }

  App.use((Req, Res) => {
    warn(`NotFound 404 ${Req.method} ${Req.originalUrl}`);
    Res.error(E_NotFound, Req.path);
  });
  App.use((Err: Error, Req: Request, Res: Response, Next: NextFunction) => {
    console.error(Err);
    Res.send(E_ServerError);
  });

  msg(`Connected to ${gray(PROJECT_NAME)} database (${STAR_DB_NAME})`);

  mongoose.connection.on("disconnected", () => warn("MongoDB disconnected, attempting to reconnect..."));
  mongoose.connection.on("reconnected", () => msg("MongoDB reconnected"));
  mongoose.connection.on("error", (e) => {
    if (e.message?.includes("timed out") || e.name === "MongoNetworkTimeoutError") return;
    warn(`MongoDB connection error: ${e.message}`);
  });
  App.listen(PORT, () => {
    const [Start, End] = MakeGradient();
    StartLoop();
    msg(
      `${toGradient(PROJECT_NAME, Start, End)} running on port ${magenta(PORT.toString())} ${
        IS_DEBUG ? red("(debug)") : ""
      }`
    );
  });

  const StartTime = new Date(new Date().getTime() + 10 * 60 * 1000);
  const TourId = new Date().getTime().toString();

  TournamentBot.Start();
  TournamentScheduler.Start();
  TournamentCleaner.Start();
}

export function GetStarDatabase(): Db {
  if (!StarDb) {
    return null;
  }
  return StarDb;
}

Start().catch((Err) => {
  err(`Initialization failed: ${(Err as Error).stack || (Err as Error).message}`);
});

export { mongoose };
