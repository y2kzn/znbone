import { Request, Response, NextFunction } from "express";
import { ApiError } from "./Errors";
import { ServiceType } from "./Service";
import * as crypto from "crypto";
import { Match } from "../Models/Matches";
import { Encrypt } from "./Cryptography";

declare global {
  namespace Express {
    interface Request {
      service: ServiceType;
    }

    interface Response {
      error(err: ApiError, ...vars: string[]): void;
    }
  }
}

export function Register(req: Request, res: Response, next: NextFunction) {
  res.error = function (Err: ApiError, ...Vars: string[]) {
    if (this.statusCode === 200) this.status(Err._statusCode);

    this.json(Err.package(...Vars));
  };

  next();
}

export function GenerateInviteId(): number {
  const time = Date.now();
  const timeComponent = time % 10000000000;
  const randomComponent = Math.floor(Math.random() * 100000);
  return timeComponent * 100000 + randomComponent;
}

export function GeneratePrizepoolId(): bigint {
  const maxLong = 9223372036854775807n;
  const timestamp = BigInt(Date.now());
  const randomBytes = crypto.randomBytes(6);
  const random = BigInt(`0x${randomBytes.toString("hex")}`);
  const combined = timestamp * 1000000n + (random % 1000000n);
  return combined % maxLong;
}

export async function generateMatchSecret(): Promise<string> {
  const invisibleChars = [
    "ㅤㅤㅤㅤㅤ",
    "ㅤㅤㅤㅤㅤㅤㅤㅤㅤㅤㅤㅤㅤㅤㅤ",
    "ㅤㅤㅤㅤㅤ ㅤㅤㅤㅤㅤ",
    "ㅤㅤㅤㅤㅤ",
    "ㅤㅤㅤㅤㅤ"
  ];

  const randomValues = new Uint32Array(64);
  crypto.getRandomValues(randomValues);

  const length = 10 + (randomValues[0] % 91);

  let result = "";

  for (let i = 0; i < length; i++) {
    result += invisibleChars[randomValues[i + 1] % invisibleChars.length];
  }

  return result;
}

