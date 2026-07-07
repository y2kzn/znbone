import * as crypto from "crypto";
import { BackboneUser, IBackboneUser } from "../../../Models/BackboneUser";
import { ITournament } from "../../../Models/Tournament";
import { TournamentMatchStatus, TournamentPhaseType, TournamentStatus } from "../../Config";
import { Match } from "../../../Models/Matches";
import { GetAllPartyMembers, QualifyPhase } from "./Phase";
import { GetRoundConfigs } from "../../Settings/Rules";
import { Qualify } from "../GetMatches";
import { CheckPhases } from "./Phase";
import { Tournament } from "../../../Models/Tournament";
import { generateMatchSecret } from "../../../Modules/Extensions";

interface TeamUser {
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

async function GetExpectedRoundCount(Tournament: ITournament, PhaseId: number, GroupId: number): Promise<number> {
  const PhaseConfig = Tournament.Phases[PhaseId - 1];
  if (!PhaseConfig) return 0;

  const TypeNum = Number(PhaseConfig.PhaseType) || TournamentPhaseType.SingleEliminationBracket;
  const PhaseType = TournamentPhaseType[TypeNum] as keyof typeof TournamentPhaseType;

  if (PhaseType === "RoundRobin" || PhaseType === "Arena") {
    return PhaseConfig.RoundCount || Tournament.RoundCount;
  }

  const AllMatches = await Match.find({
    tournamentid: Tournament.TournamentId.toString(),
    phaseid: PhaseId,
    groupid: GroupId,
  })
    .select("roundid")
    .lean();

  if (AllMatches.length === 0) return 0;
  return Math.max(...AllMatches.map((M) => M.roundid));
}

async function CreateNotPlayedMatch(
  UserId: string,
  Tournament: ITournament,
  PhaseId: number,
  GroupId: number,
  RoundId: number
): Promise<void> {
  const TournamentId = Tournament.TournamentId.toString();

  const User = await BackboneUser.findOne({ UserId }).lean();
  if (!User) return;

  const UserInfo = (User.Tournaments as any).get
    ? (User.Tournaments as any).get(TournamentId)
    : User.Tournaments[TournamentId];
  if (!UserInfo) return;

  const ExistingMatch = await Match.findOne({
    tournamentid: TournamentId,
    phaseid: PhaseId,
    groupid: GroupId,
    roundid: RoundId,
    "users.@user-id": UserId,
  }).lean();

  if (ExistingMatch) return;

  const AlreadyInHistory = UserInfo.UserMatches?.some(
    (M: any) => M.phaseid === PhaseId && M.groupid === GroupId && M.roundid === RoundId
  );
  if (AlreadyInHistory) return;

  const PartyIds = new Set<string>([UserId]);
  if (UserInfo.PartyMembers) {
    for (const Member of UserInfo.PartyMembers) {
      if (Member?.UserId) PartyIds.add(Member.UserId);
    }
  }

  const PhaseConfig = Tournament.Phases[PhaseId - 1];
  const TypeNum = Number(PhaseConfig.PhaseType) || TournamentPhaseType.SingleEliminationBracket;
  const PhaseType = TournamentPhaseType[TypeNum] as keyof typeof TournamentPhaseType;

  const ExistingRound = await Match.find({
    tournamentid: TournamentId,
    phaseid: PhaseId,
    groupid: GroupId,
    roundid: RoundId,
  })
    .select("matchid")
    .sort({ matchid: -1 })
    .limit(1)
    .lean();

  const NextMatchId = ExistingRound.length > 0 ? ExistingRound[0].matchid + 1 : 1;

  let MatchIdString = `${Tournament.TournamentId}${PhaseId}${RoundId}`;
  if (PhaseType === "RoundRobin" || PhaseType === "Arena") {
    MatchIdString += `${GroupId || 0}${NextMatchId}`;
  } else {
    MatchIdString += `0${NextMatchId}`;
  }

  const Users: TeamUser[] = Array.from(PartyIds).map((Id) => {
    const UserData = Id === UserId ? User : UserInfo.PartyMembers?.find((M: any) => M.UserId === Id);
    return {
      "@user-id": Id,
      "@team-id": "1",
      "@checked-in": "0",
      "@user-score": "0",
      "@team-score": "0",
      "@user-points": "0",
      "@team-points": "0",
      "@match-points": "0",
      "@match-winner": "0",
      "@nick": UserData?.Username || "",
    };
  });

  const Secret = await generateMatchSecret();
  const Deadline = new Date();

  try {
    const NewMatch = await Match.create({
      id: MatchIdString,
      matchid: NextMatchId,
      secret: Secret,
      deadline: Deadline,
      phaseid: PhaseId,
      groupid: GroupId,
      roundid: RoundId,
      playedgamecount: 0,
      status: TournamentMatchStatus.Closed,
      tournamentid: TournamentId,
      users: Users,
    });

    const MatchCopy = {
      id: NewMatch.id,
      secret: NewMatch.secret,
      deadline: NewMatch.deadline,
      matchid: NewMatch.matchid,
      phaseid: NewMatch.phaseid,
      groupid: NewMatch.groupid,
      roundid: NewMatch.roundid,
      playedgamecount: NewMatch.playedgamecount,
      status: NewMatch.status,
      tournamentid: NewMatch.tournamentid,
      users: NewMatch.users,
    };

    const AllPartyMembers = await GetAllPartyMembers(UserId, TournamentId);
    const UpdateOps = Array.from(AllPartyMembers).map((Id) => ({
      updateOne: {
        filter: { UserId: Id, [`Tournaments.${TournamentId}`]: { $exists: true } },
        update: {
          $push: { [`Tournaments.${TournamentId}.UserMatches`]: MatchCopy },
        },
      },
    }));

    if (UpdateOps.length > 0) {
      await BackboneUser.bulkWrite(UpdateOps, { ordered: false });
    }
  } catch (Err: any) {
    if (Err.code !== 11000) {
      console.error("Error creating not played match:", Err);
    }
  }
}

async function ProcessExpiredMatch(ExpiredMatch: any, Tournament: ITournament, PhaseType: string): Promise<void> {
  const PhaseConfig = Tournament.Phases[ExpiredMatch.phaseid - 1];
  if (!PhaseConfig) return;

  const Configs = GetRoundConfigs(Tournament);
  const Config = Configs.get(ExpiredMatch.roundid);
  if (!Config) return;

  const Deadline = new Date(ExpiredMatch.deadline);
  let MatchStartDeadline: Date;

  if (ExpiredMatch.status === TournamentMatchStatus.WaitingForOpponent) {
    MatchStartDeadline = Deadline;
  } else {
    const TotalGameTime = Config.MaxGameCount * Config.MinGameLength;
    const AdjustedTime = TotalGameTime === Config.MaxLength ? TotalGameTime - 1 : TotalGameTime;
    MatchStartDeadline = new Date(Deadline.getTime() - AdjustedTime * 60 * 1000 - 15000);
  }

  const GracePeriod = new Date(MatchStartDeadline.getTime() + 5000);
  const Now = new Date();

  if (Now < GracePeriod) return;

  const CheckedInTeams = new Map<string, boolean>();

  for (const MatchUser of ExpiredMatch.users) {
    const TeamId = MatchUser["@team-id"];
    if (!TeamId) continue;

    if (!CheckedInTeams.has(TeamId)) {
      CheckedInTeams.set(TeamId, false);
    }

    if (MatchUser["@checked-in"] === "1") {
      CheckedInTeams.set(TeamId, true);
    }
  }

  const FullyCheckedInTeams: string[] = [];
  const NotCheckedInTeams: string[] = [];

  for (const [TeamId, IsCheckedIn] of CheckedInTeams.entries()) {
    const TeamUsers = ExpiredMatch.users.filter((U: any) => U["@team-id"] === TeamId);
    const AllCheckedIn = TeamUsers.every((U: any) => U["@checked-in"] === "1");

    if (AllCheckedIn && TeamUsers.length > 0) {
      FullyCheckedInTeams.push(TeamId);
    } else if (!IsCheckedIn) {
      NotCheckedInTeams.push(TeamId);
    }
  }

  const UniqueTeams = new Set(ExpiredMatch.users.map((U: any) => U["@team-id"]).filter((T: string) => T)).size;
  const MaxTeams = Tournament.MaxPlayersPerMatch || 2;

  if (
    ExpiredMatch.status === TournamentMatchStatus.WaitingForOpponent &&
    FullyCheckedInTeams.length === 1 &&
    UniqueTeams < MaxTeams
  ) {
    const UpdatedUsers = ExpiredMatch.users.map((U: any) => {
      if (FullyCheckedInTeams.includes(U["@team-id"])) {
        return {
          ...U,
          "@match-winner": "1",
          "@match-points": "1",
          "@team-score": "1",
        };
      } else {
        return {
          ...U,
          "@match-winner": "0",
          "@match-points": "0",
          "@team-score": "0",
        };
      }
    });

    await Match.updateOne(
      { id: ExpiredMatch.id },
      { $set: { users: UpdatedUsers, status: TournamentMatchStatus.Closed } }
    );

    const WinnerUserIds = UpdatedUsers.filter((U: any) => U["@match-winner"] === "1").map((U: any) => U["@user-id"]);

    if (WinnerUserIds.length > 0) {
      const WinnerUser = await BackboneUser.findOne({ UserId: WinnerUserIds[0] });
      if (WinnerUser) {
        if (PhaseType === "RoundRobin" || PhaseType === "Arena") {
          await QualifyPhase(WinnerUser, Tournament);
        } else {
          await Qualify(WinnerUser, Tournament);
        }
      }
    }

    return;
  }

  if (ExpiredMatch.roundid === 1 && FullyCheckedInTeams.length === 0) {
    const UpdatedUsers = ExpiredMatch.users.map((U: any) => ({
      ...U,
      "@match-winner": "0",
      "@match-points": "0",
      "@team-score": "0",
    }));

    await Match.updateOne(
      { id: ExpiredMatch.id },
      { $set: { users: UpdatedUsers, status: TournamentMatchStatus.Closed } }
    );

    const MatchCopy = {
      id: ExpiredMatch.id,
      secret: ExpiredMatch.secret,
      deadline: ExpiredMatch.deadline,
      matchid: ExpiredMatch.matchid,
      phaseid: ExpiredMatch.phaseid,
      groupid: ExpiredMatch.groupid,
      roundid: ExpiredMatch.roundid,
      playedgamecount: ExpiredMatch.playedgamecount,
      status: TournamentMatchStatus.Closed,
      tournamentid: ExpiredMatch.tournamentid,
      users: UpdatedUsers,
    };

    const AllUserIds = ExpiredMatch.users.map((U: any) => U["@user-id"]);
    const AllPartyMembers = new Set<string>();

    for (const UserId of AllUserIds) {
      const Members = await GetAllPartyMembers(UserId, ExpiredMatch.tournamentid);
      Members.forEach((M) => AllPartyMembers.add(M));
    }

    const UpdateOps = Array.from(AllPartyMembers).map((Id) => ({
      updateOne: {
        filter: { UserId: Id, [`Tournaments.${ExpiredMatch.tournamentid}`]: { $exists: true } },
        update: {
          $set: { [`Tournaments.${ExpiredMatch.tournamentid}.UserMatch`]: null },
          $push: { [`Tournaments.${ExpiredMatch.tournamentid}.UserMatches`]: MatchCopy },
        },
      },
    }));

    if (UpdateOps.length > 0) {
      await BackboneUser.bulkWrite(UpdateOps, { ordered: false });
    }

    return;
  }

  if (FullyCheckedInTeams.length > 0 && NotCheckedInTeams.length > 0) {
    const UpdatedUsers = ExpiredMatch.users.map((U: any) => {
      if (FullyCheckedInTeams.includes(U["@team-id"])) {
        return {
          ...U,
          "@match-winner": "1",
          "@match-points": "1",
          "@team-score": "1",
        };
      } else {
        return {
          ...U,
          "@match-winner": "0",
          "@match-points": "0",
          "@team-score": "0",
        };
      }
    });

    await Match.updateOne(
      { id: ExpiredMatch.id },
      { $set: { users: UpdatedUsers, status: TournamentMatchStatus.Closed } }
    );

    const WinnerUserIds = UpdatedUsers.filter((U: any) => U["@match-winner"] === "1").map((U: any) => U["@user-id"]);

    if (WinnerUserIds.length > 0) {
      const WinnerUser = await BackboneUser.findOne({ UserId: WinnerUserIds[0] });
      if (WinnerUser) {
        if (PhaseType === "RoundRobin" || PhaseType === "Arena") {
          await QualifyPhase(WinnerUser, Tournament);
        } else {
          await Qualify(WinnerUser, Tournament);
        }
      }
    }
  }
}

async function HandleNotPlayedMatches(Tournament: ITournament, PhaseId: number, PhaseType: string): Promise<void> {
  if (PhaseType !== "RoundRobin" && PhaseType !== "Arena") return;

  const Now = new Date();
  const TournamentId = Tournament.TournamentId.toString();

  const SignedUpUsers = await BackboneUser.find({
    [`Tournaments.${TournamentId}.SignedUp`]: true,
    $or: [
      { [`Tournaments.${TournamentId}.KnockedOut`]: { $exists: false } },
      { [`Tournaments.${TournamentId}.KnockedOut`]: false },
    ],
  }).lean();

  const ProcessedLeaders = new Set<string>();

  for (const User of SignedUpUsers) {
    const UserInfo = (User.Tournaments as any).get
      ? (User.Tournaments as any).get(TournamentId)
      : User.Tournaments[TournamentId];

    if (!UserInfo) continue;

    let LeaderId = User.UserId;
    if (UserInfo.PartyMembers && Tournament.PartySize > 1) {
      const Leader = UserInfo.PartyMembers.find((M: any) => M.IsPartyLeader);
      if (Leader) LeaderId = Leader.UserId;
    }

    if (ProcessedLeaders.has(LeaderId)) continue;
    ProcessedLeaders.add(LeaderId);

    const UserPosition = UserInfo.UserPosition?.find((P: any) => P.phaseid === PhaseId);
    const GroupId = UserPosition?.groupid || 0;

    const HasActiveMatch = await Match.exists({
      tournamentid: TournamentId,
      phaseid: PhaseId,
      groupid: GroupId,
      "users.@user-id": User.UserId,
      status: {
        $in: [
          TournamentMatchStatus.GameInProgress,
          TournamentMatchStatus.GameReady,
          TournamentMatchStatus.WaitingForOpponent,
        ],
      },
    });

    if (HasActiveMatch) continue;

    const AllUserMatches = await Match.find({
      tournamentid: TournamentId,
      phaseid: PhaseId,
      groupid: GroupId,
      "users.@user-id": User.UserId,
    })
      .select("roundid status")
      .lean();

    const PlayedRounds = new Set(
      AllUserMatches.filter(
        (M) => M.status === TournamentMatchStatus.Closed || M.status === TournamentMatchStatus.GameFinished
      ).map((M) => M.roundid)
    );

    const ExpectedRounds = await GetExpectedRoundCount(Tournament, PhaseId, GroupId);
    const NextPhaseStart = Tournament.NextPhaseStarted || new Date(Date.now() + 24 * 60 * 60 * 1000);
    const PhaseStart = Tournament.CurrentPhaseStarted || new Date(Tournament.StartTime);
    const PhaseElapsed = Now.getTime() - PhaseStart.getTime();
    const TotalPhaseDuration = NextPhaseStart.getTime() - PhaseStart.getTime();

    let ExpectedCompletedRounds = 0;
    if (TotalPhaseDuration > 0) {
      const ProgressRatio = Math.min(1, PhaseElapsed / TotalPhaseDuration);
      ExpectedCompletedRounds = Math.floor(ExpectedRounds * ProgressRatio);
    }

    for (let RoundId = 2; RoundId <= ExpectedCompletedRounds; RoundId++) {
      if (!PlayedRounds.has(RoundId)) {
        await CreateNotPlayedMatch(LeaderId, Tournament, PhaseId, GroupId, RoundId);
      }
    }
  }
}

export async function ResolveMatches(Tournament: ITournament): Promise<void> {
  const Now = new Date();
  const PhaseId = Tournament.CurrentPhaseId || 1;
  const TournamentId = Tournament.TournamentId.toString();
  const PhaseConfig = Tournament.Phases[PhaseId - 1];

  if (!PhaseConfig) return;

  const TypeNum = Number(PhaseConfig.PhaseType) || TournamentPhaseType.SingleEliminationBracket;
  const PhaseType = TournamentPhaseType[TypeNum] as keyof typeof TournamentPhaseType;

  const AllExpiredMatches = await Match.find({
    tournamentid: TournamentId,
    phaseid: PhaseId,
    deadline: { $lt: Now },
    status: { $in: [TournamentMatchStatus.GameReady, TournamentMatchStatus.WaitingForOpponent] },
  }).lean();

  for (const ExpiredMatch of AllExpiredMatches) {
    await ProcessExpiredMatch(ExpiredMatch, Tournament, PhaseType);
  }

  await HandleNotPlayedMatches(Tournament, PhaseId, PhaseType);
}

let IsLoopRunning = false;

export async function StartLoop() {
  if (IsLoopRunning) return;
  IsLoopRunning = true;

  setInterval(async () => {
    try {
      const RunningTournaments = await Tournament.find({
        Status: TournamentStatus.Running,
      }).limit(10);

      for (const Tour of RunningTournaments) {
        try {
          await ResolveMatches(Tour);
          await CheckPhases(Tour);
        } catch (Err) {
          console.error(`Error resolving tournament ${Tour.TournamentId}:`, Err);
        }
      }
    } catch (Err) {
      console.error("Error in resolution loop:", Err);
    }
  }, 10000);
}