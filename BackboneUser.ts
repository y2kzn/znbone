import mongoose, { Schema, Document } from "mongoose";

export interface IPartyMember {
    UserId: string;
    Username: string;
    Status: number;
    IsPartyLeader: boolean;
    IsKicked: boolean;
}

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

export interface IUserMatch {
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

export interface IUserPosition {
    groupid: number;
    matchloses: number;
    phaseid: number;
    rankposition: number;
    sameposition: number;
    totalpoints: number;
    totalrounds: number;
}

export interface ITournamentData {
    SignedUp: boolean;
    InviteId: string;
    Status: number;
    AcceptedAt: Date;
    PartyCode: string;
    PartyMembers: IPartyMember[];
    KnockedOut?: boolean;
    UserMatch: IUserMatch | null;
    UserMatches: IUserMatch[];
    UserPosition: IUserPosition[];
    FinalPlace: number;
}

export interface IBackboneUser extends Document {
    Username: string;
    UserId: string;
    TournamentsWon: number;
    Tournaments: Map<string, ITournamentData>;
}

const PartyMemberSchema = new Schema<IPartyMember>(
    {
        UserId: { type: String, required: true },
        Username: { type: String, required: true },
        Status: { type: Number, required: true },
        IsPartyLeader: { type: Boolean, required: true, default: false },
        IsKicked: { type: Boolean, required: true, default: false },
    },
    { _id: false }
);

const MatchUserSchema = new Schema<IMatchUser>(
    {
        "@user-id": { type: String, required: true },
        "@team-id": { type: String, required: true },
        "@checked-in": { type: String, required: true },
        "@user-score": { type: String, required: true },
        "@team-score": { type: String, required: true },
        "@user-points": { type: String, required: true },
        "@team-points": { type: String, required: true },
        "@match-points": { type: String, required: true },
        "@match-winner": { type: String, required: true },
        "@nick": { type: String, required: true },
    },
    { _id: false }
);

const UserMatchSchema = new Schema<IUserMatch>(
    {
        id: { type: String, required: true },
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
    },
    { _id: false }
);

const UserPositionSchema = new Schema<IUserPosition>(
    {
        groupid: { type: Number, required: true, default: 0 },
        matchloses: { type: Number, required: true, default: 0 },
        phaseid: { type: Number, required: true },
        rankposition: { type: Number, required: true, default: 0 },
        sameposition: { type: Number, required: true, default: 0 },
        totalpoints: { type: Number, required: true, default: 0 },
        totalrounds: { type: Number, required: true, default: 0 }
    },
    { _id: false }
);

const BackboneUserSchema = new Schema<IBackboneUser>({
    Username: { type: String, required: true, unique: true },
    UserId: { type: String, required: true, unique: true },
    TournamentsWon: { type: Number, required: true, unique: false, default: 0 },
    Tournaments: {
        type: Map,
        of: new Schema(
            {
                SignedUp: { type: Boolean, required: true, default: false },
                InviteId: { type: String, required: true },
                Status: { type: Number, required: true },
                AcceptedAt: { type: Date, required: true },
                PartyCode: { type: String, required: false, default: "" },
                KnockedOut: { type: Boolean, required: false, default: false },
                PartyMembers: { type: [PartyMemberSchema], default: [] },
                UserMatch: { type: UserMatchSchema, default: null, required: false },
                UserMatches: { type: [UserMatchSchema], default: [] },
                UserPosition: { type: [UserPositionSchema], default: [] },
                FinalPlace: { type: Number, required: false, default: 0 },
            },
            { _id: false }
        ),
        default: {},
    },
});

BackboneUserSchema.index({ "Tournaments.SignedUp": 1 });
BackboneUserSchema.index({ "Tournaments.UserPosition.phaseid": 1 });
BackboneUserSchema.index({ "Tournaments.UserPosition.groupid": 1 });
BackboneUserSchema.index({ "Tournaments.KnockedOut": 1 });
BackboneUserSchema.index({ "Tournaments.UserMatch.id": 1 });
BackboneUserSchema.index({ "Tournaments.PartyMembers.UserId": 1 });
BackboneUserSchema.index({ "Tournaments.InviteId": 1 });
BackboneUserSchema.index({ TournamentsWon: 1 });
BackboneUserSchema.index({ "Tournaments.SignedUp": 1, "Tournaments.KnockedOut": 1 });
BackboneUserSchema.index({ "Tournaments.UserPosition.phaseid": 1, "Tournaments.UserPosition.groupid": 1 });
BackboneUserSchema.index({ "Tournaments.UserMatch.id": 1, "Tournaments.UserMatch.status": 1 });
BackboneUserSchema.index({ "Tournaments.PartyMembers.UserId": 1, "Tournaments.PartyMembers.Status": 1 });
BackboneUserSchema.index({ "Tournaments.FinalPlace": 1 });
BackboneUserSchema.index({ "Tournaments.UserMatches.id": 1 });
BackboneUserSchema.index({ "Tournaments.AcceptedAt": 1 });

export const BackboneUser = mongoose.model<IBackboneUser>("BackboneUser", BackboneUserSchema, "Backbone Users");
