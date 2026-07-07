import mongoose, { Schema, Document } from "mongoose";

export interface IMatchUser {
  "@user-id": string;
  "@team-id": string;
  "@checked-in": string;
  "@user-score": string;
  "@team-score": string;
  "@user-points": string;
  "@team-points": string;
  "@match-points": string;
  "@match-winner": string;
  "@nick": string;
}

export interface IMatch extends Document {
  id: string;
  secret: string;
  deadline: Date;
  matchid: number;
  phaseid: number;
  groupid: number;
  roundid: number;
  playedgamecount: number;
  status: number;
  users: IMatchUser[];
  tournamentid: string;
}

const MatchUserSchema = new Schema<IMatchUser>(
  {
    "@user-id": { type: String, required: true },
    "@team-id": { type: String, required: true },
    "@checked-in": { type: String, required: true, default: "0" },
    "@user-score": { type: String, required: true, default: "0" },
    "@team-score": { type: String, required: true, default: "0" },
    "@user-points": { type: String, required: true, default: "0" },
    "@team-points": { type: String, required: true, default: "0" },
    "@match-points": { type: String, required: true, default: "0" },
    "@match-winner": { type: String, required: true, default: "0" },
    "@nick": { type: String, required: true },
  },
  { _id: false }
);

const MatchSchema = new Schema<IMatch>({
  id: { type: String, required: true, unique: true },
  secret: { type: String, required: true },
  deadline: { type: Date, required: true },
  matchid: { type: Number, required: true },
  phaseid: { type: Number, required: true },
  groupid: { type: Number, required: true },
  roundid: { type: Number, required: true },
  playedgamecount: { type: Number, required: true, default: 0 },
  status: { type: Number, required: true },
  users: { type: [MatchUserSchema], required: true, default: [] },
  tournamentid: { type: String, required: true },
});

MatchSchema.index({ tournamentid: 1 });
MatchSchema.index({ phaseid: 1 });
MatchSchema.index({ groupid: 1 });
MatchSchema.index({ roundid: 1 });
MatchSchema.index({ status: 1 });
MatchSchema.index({ deadline: 1 });
MatchSchema.index({ "users.@user-id": 1 });
MatchSchema.index({ tournamentid: 1, phaseid: 1, groupid: 1 });
MatchSchema.index({ tournamentid: 1, phaseid: 1, roundid: 1 });
MatchSchema.index({ tournamentid: 1, phaseid: 1, status: 1 });
MatchSchema.index({ "users.@user-id": 1, tournamentid: 1 });
MatchSchema.index({ status: 1, deadline: 1 });
MatchSchema.index({ tournamentid: 1, phaseid: 1, groupid: 1, roundid: 1 });
MatchSchema.index({ matchid: 1 });
MatchSchema.index({ secret: 1 });
MatchSchema.index({ playedgamecount: 1 });
MatchSchema.index({ "users.@team-id": 1 });
MatchSchema.index({ "users.@checked-in": 1 });
MatchSchema.index({ "users.@match-winner": 1 });

export const Match = mongoose.model<IMatch>("Matches", MatchSchema, "Matches");
