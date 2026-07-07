import { BackboneUser, IBackboneUser, IUserMatch } from "../../Models/BackboneUser";
import { IMatch, Match } from "../../Models/Matches";
import { ITournament, Tournament } from "../../Models/Tournament";
import { TournamentMatchStatus, TournamentStatus, TournamentPhaseType } from "../Config";
import { GetRoundConfigs, RoundConfig } from "../Settings/Rules";
import * as crypto from "crypto";
import { CreateOrAssignMatch, GetAllPartyMembers, QualifyPhase } from "./Internal/Phase";
import { generateMatchSecret } from "../../Modules/Extensions";

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

const ActiveGenerations = new Map<string, Promise<void>>();
const ProcessedMatches = new Set<string>();
const BracketAssignmentLocks = new Map<string, Promise<IMatch | null>>();
const MatchModificationLocks = new Map<string, Promise<void>>();


function ShuffleArray<T>(Array: T[]): T[] {
  const Result = [...Array];
  for (let I = Result.length - 1; I > 0; I--) {
    const J = Math.floor(Math.random() * (I + 1));
    [Result[I], Result[J]] = [Result[J], Result[I]];
  }
  return Result;
}

function CalculateTotalRounds(TotalTeams: number, MinPerMatch: number, MaxPerMatch: number): number {
  if (MinPerMatch === 2 && MaxPerMatch === 2) {
    return Math.ceil(Math.log2(TotalTeams));
  }

  let Rounds = 0;
  let Remaining = TotalTeams;

  while (Remaining > 1) {
    Rounds++;
    const MatchesNeeded = Math.ceil(Remaining / MaxPerMatch);
    if (MatchesNeeded === 1) break;
    Remaining = MatchesNeeded * MinPerMatch;
  }

  return Rounds;
}

function CalculateDeadline(
  PhaseStart: Date,
  RoundNumber: number,
  Config: RoundConfig,
  HasFullMatch: boolean,
  PreviousDeadline?: Date
): Date {
  const Minutes = RoundNumber === 1 ? (HasFullMatch ? 15 : Config.MaxLength) : Config.MaxLength;
  const BaseTime = RoundNumber === 1 ? PhaseStart : PreviousDeadline || PhaseStart;
  return new Date(BaseTime.getTime() + Minutes * 60 * 1000);
}

export function GetMatchDeadline(
  CurrentMatch: any,
  Tournament: ITournament,
  RoundConfigs: Map<number, RoundConfig>
): Date {
  const Config = RoundConfigs.get(CurrentMatch.roundid);
  if (!Config) return new Date(CurrentMatch.deadline);

  const Deadline = new Date(CurrentMatch.deadline);
  if (CurrentMatch.status === TournamentMatchStatus.WaitingForOpponent) return Deadline;

  const GameCount = Config.MaxGameCount;
  const TotalMinutes = GameCount * Config.MinGameLength;
  const AdjustedMinutes = TotalMinutes === Config.MaxLength ? TotalMinutes - 1 : TotalMinutes;

  return new Date(Deadline.getTime() - AdjustedMinutes * 60 * 1000 - 15000);
}

export function GetTournamentData(User: any, TournamentId: string): any {
  return (User.Tournaments as any).get ? (User.Tournaments as any).get(TournamentId) : User.Tournaments[TournamentId];
}

async function BuildTeams(
  Users: any[],
  TournamentId: string,
  PartySize: number,
  MaxTeams?: number
): Promise<TeamUser[][]> {
  const Shuffled = ShuffleArray(Users);
  const Teams: TeamUser[][] = [];
  const Processed = new Set<string>();

  for (const User of Shuffled) {
    if (Processed.has(User.UserId)) continue;

    const TournamentData = GetTournamentData(User, TournamentId);
    if (!TournamentData?.PartyMembers || TournamentData.PartyMembers.length !== PartySize) continue;

    const IsLeader = TournamentData.PartyMembers.some(
      (M: any) => M.UserId === User.UserId && M.IsPartyLeader
    );
    if (!IsLeader) continue;

    const Team: TeamUser[] = [];

    for (const Member of TournamentData.PartyMembers) {
      if (Processed.has(Member.UserId) || Team.length >= PartySize) continue;

      Team.push({
        "@user-id": Member.UserId,
        "@team-id": "",
        "@checked-in": "0",
        "@user-score": "0",
        "@team-score": "0",
        "@user-points": "0",
        "@team-points": "0",
        "@match-points": "0",
        "@match-winner": "0",
        "@nick": Member.Username,
      });
      Processed.add(Member.UserId);
    }

    if (Team.length === PartySize) {
      Teams.push(Team);
      if (MaxTeams && Teams.length >= MaxTeams) break;
    }
  }

  return Teams;
}

async function InitializePositions(
  TournamentId: string,
  PhaseId: number,
  PartySize: number,
  UserIds: Set<string>,
  GroupId: number = 0
): Promise<void> {
  const Users = await BackboneUser.find({ UserId: { $in: Array.from(UserIds) } }).lean();
  const Updates: any[] = [];

  for (const User of Users) {
    const TournamentData = GetTournamentData(User, TournamentId);
    if (!TournamentData) continue;

    if (!TournamentData.UserPosition) TournamentData.UserPosition = [];

    let Position = TournamentData.UserPosition.find((P: any) => P.phaseid === PhaseId && P.groupid === GroupId);

    if (!Position) {
      Position = {
        phaseid: PhaseId,
        rankposition: 0,
        sameposition: 0,
        matchloses: 0,
        totalpoints: 0,
        totalrounds: 0,
        groupid: GroupId,
      };
      TournamentData.UserPosition.push(Position);
    } else {
      Object.assign(Position, {
        rankposition: 0,
        sameposition: 0,
        matchloses: 0,
        totalpoints: 0,
        totalrounds: 0,
      });
    }

    Updates.push({
      updateOne: {
        filter: { UserId: User.UserId },
        update: { $set: { [`Tournaments.${TournamentId}`]: TournamentData } },
      },
    });

    if (PartySize > 1 && TournamentData.PartyMembers) {
      const IsLeader = TournamentData.PartyMembers.some((M: any) => M.IsPartyLeader && M.UserId === User.UserId);
      if (!IsLeader) continue;

      for (const Member of TournamentData.PartyMembers) {
        if (Member.UserId === User.UserId) continue;

        const MemberUser = Users.find((U) => U.UserId === Member.UserId);
        if (!MemberUser) continue;

        const MemberData = GetTournamentData(MemberUser, TournamentId);
        if (!MemberData) continue;

        if (!MemberData.UserPosition) MemberData.UserPosition = [];

        let MemberPosition = MemberData.UserPosition.find((P: any) => P.phaseid === PhaseId && P.groupid === GroupId);

        if (!MemberPosition) {
          MemberPosition = {
            phaseid: PhaseId,
            rankposition: 0,
            sameposition: 0,
            matchloses: 0,
            totalpoints: 0,
            totalrounds: 0,
            groupid: GroupId,
          };
          MemberData.UserPosition.push(MemberPosition);
        } else {
          Object.assign(MemberPosition, {
            rankposition: 0,
            sameposition: 0,
            matchloses: 0,
            totalpoints: 0,
            totalrounds: 0,
          });
        }

        Updates.push({
          updateOne: {
            filter: { UserId: Member.UserId },
            update: { $set: { [`Tournaments.${TournamentId}`]: MemberData } },
          },
        });
      }
    }
  }

  if (Updates.length > 0) {
    await BackboneUser.bulkWrite(Updates, { ordered: false });
  }
}

async function SaveMatchesToDatabase(Matches: IMatch[], TournamentId: string): Promise<void> {
  if (Matches.length === 0) return;

  try {
    await Match.insertMany(Matches, { ordered: false });

    const FirstRoundMatches = Matches.filter((M) => M.roundid === 1 && M.users.length > 0);
    if (FirstRoundMatches.length === 0) return;

    const UserMatchMap = new Map<string, IMatch>();

    for (const MatchDoc of FirstRoundMatches) {
      for (const User of MatchDoc.users) {
        const UserId = User["@user-id"];
        if (!UserMatchMap.has(UserId)) {
          UserMatchMap.set(UserId, MatchDoc);
        }
      }
    }

    const UserUpdates = Array.from(UserMatchMap.entries()).map(([UserId, MatchDoc]) => ({
      updateOne: {
        filter: { UserId, [`Tournaments.${TournamentId}`]: { $exists: true } },
        update: {
          $set: {
            [`Tournaments.${TournamentId}.UserMatch`]: JSON.parse(JSON.stringify(MatchDoc.toObject())),
          },
        },
      },
    }));

    if (UserUpdates.length > 0) {
      await BackboneUser.bulkWrite(UserUpdates, { ordered: false });
    }
  } catch (Error: any) {
    if (Error.code !== 11000) throw Error;
  }
}

async function GenerateSingleElimination(
  Tournament: ITournament,
  Teams: TeamUser[][],
  PhaseId: number,
  TournamentId: string,
  RoundConfigs: Map<number, RoundConfig>,
  PhaseStart: Date
): Promise<IMatch[]> {
  const FilledTeams = Teams.filter((T) => T.length === Tournament.PartySize);
  const EmptyTeams = Teams.filter((T) => T.length === 0);
  const AllTeams = [...FilledTeams, ...EmptyTeams];

  const TotalRounds = CalculateTotalRounds(
    AllTeams.length,
    Tournament.MinPlayersPerMatch,
    Tournament.MaxPlayersPerMatch
  );
  const CreatedMatches: IMatch[] = [];
  const FirstRoundUsers = new Set<string>();
  let LastDeadline: Date | undefined;
  let TeamsRemaining = AllTeams.length;

  for (let Round = 1; Round <= TotalRounds; Round++) {
    const MatchCount = Math.ceil(TeamsRemaining / Tournament.MaxPlayersPerMatch);
    const Config = RoundConfigs.get(Round) || { MinGameLength: 8, MaxLength: 12, MaxGameCount: 1 };

    for (let MatchNum = 1; MatchNum <= MatchCount; MatchNum++) {
      const MatchId = `${TournamentId}${PhaseId}${Round}0${MatchNum}`;
      const Secret = await generateMatchSecret();
      const Users: TeamUser[] = [];
      let Status = TournamentMatchStatus.Created;

      if (Round === 1) {
        const TeamsInMatch: TeamUser[][] = [];
        for (let Slot = 0; Slot < Tournament.MaxPlayersPerMatch; Slot++) {
          const TeamIndex = (MatchNum - 1) * Tournament.MaxPlayersPerMatch + Slot;
          TeamsInMatch.push(TeamIndex < AllTeams.length ? AllTeams[TeamIndex] : []);
        }

        const ValidTeams = TeamsInMatch.filter((T) => T.length === Tournament.PartySize).length;
        const SeenUserIds = new Set<string>();

        for (let Slot = 0; Slot < TeamsInMatch.length; Slot++) {
          const TeamId = (Slot + 1).toString();
          const TeamWithIds = TeamsInMatch[Slot].filter((U) => {
            if (SeenUserIds.has(U["@user-id"])) return false;
            SeenUserIds.add(U["@user-id"]);
            return true;
          }).map((U) => ({ ...U, "@team-id": TeamId }));
          Users.push(...TeamWithIds);
        }

        Users.forEach((U) => FirstRoundUsers.add(U["@user-id"]));

        if (ValidTeams === Tournament.MaxPlayersPerMatch) {
          Status = TournamentMatchStatus.GameReady;
        } else if (ValidTeams >= 1) {
          Status = TournamentMatchStatus.WaitingForOpponent;
        }
      }

      let Deadline: Date;
      const GameCount = Config.MaxGameCount;
      const TotalMinutes = GameCount * Config.MinGameLength;
      const AdjustedMinutes = TotalMinutes === Config.MaxLength ? TotalMinutes - 1 : TotalMinutes;
      const SubtractedTime = AdjustedMinutes * 60 * 1000 + 15000;
      const CheckInTime = 5 * 60 * 1000;

      if (Round === 1) {
        Deadline = new Date(PhaseStart.getTime() + CheckInTime + SubtractedTime);
      } else {
        const BaseTime = LastDeadline || PhaseStart;
        Deadline = new Date(BaseTime.getTime() + CheckInTime + SubtractedTime);
      }

      CreatedMatches.push(
        new Match({
          id: MatchId,
          matchid: MatchNum,
          secret: Secret,
          deadline: Deadline,
          phaseid: PhaseId,
          groupid: 0,
          roundid: Round,
          playedgamecount: 0,
          status: Status,
          tournamentid: TournamentId,
          users: Users,
        })
      );
    }

    TeamsRemaining =
      Tournament.MinPlayersPerMatch === Tournament.MaxPlayersPerMatch && Tournament.MaxPlayersPerMatch === 2
        ? MatchCount
        : MatchCount * Tournament.MinPlayersPerMatch;

    if (CreatedMatches.length > 0) {
      LastDeadline = CreatedMatches[CreatedMatches.length - 1].deadline;
    }
  }

  await InitializePositions(TournamentId, PhaseId, Tournament.PartySize, FirstRoundUsers);
  return CreatedMatches;
}

async function GenerateRoundRobinGroup(
  Tournament: ITournament,
  Teams: TeamUser[][],
  PhaseId: number,
  GroupId: number,
  TournamentId: string,
  RoundConfigs: Map<number, RoundConfig>,
  PhaseStart: Date
): Promise<IMatch[]> {
  const ValidTeams = Teams.filter((T) => T.length > 0);
  if (ValidTeams.length < 2) return [];

  const ShuffledTeams = ShuffleArray(ValidTeams);
  const CreatedMatches: IMatch[] = [];
  const PhaseConfig = Tournament.Phases[PhaseId - 1];
  const TotalRounds = PhaseConfig.RoundCount || 1;
  const MaxPossiblePlayers = ShuffledTeams.length;

  for (let Round = 1; Round <= TotalRounds; Round++) {
    const Config = RoundConfigs.get(Round) || { MinGameLength: 8, MaxLength: 12, MaxGameCount: 1 };
    const MatchCount = Math.ceil(MaxPossiblePlayers / Tournament.MaxPlayersPerMatch);

    for (let MatchNum = 0; MatchNum < MatchCount; MatchNum++) {
      const GroupPart = GroupId === 0 ? "0" : GroupId.toString();
      const MatchId = `${TournamentId}${PhaseId}${Round}${GroupId}${MatchNum + 1}`;
      const Secret = await generateMatchSecret();
      const Users: TeamUser[] = [];

      if (Round === 1) {
        const TeamsInMatch: TeamUser[][] = [];
        for (let Slot = 0; Slot < Tournament.MaxPlayersPerMatch; Slot++) {
          const TeamIndex = MatchNum * Tournament.MaxPlayersPerMatch + Slot;
          if (TeamIndex < ShuffledTeams.length) {
            TeamsInMatch.push(ShuffledTeams[TeamIndex]);
          }
        }

        for (let Slot = 0; Slot < TeamsInMatch.length; Slot++) {
          const TeamId = (Slot + 1).toString();
          const TeamWithIds = TeamsInMatch[Slot].map((U) => ({ ...U, "@team-id": TeamId }));
          Users.push(...TeamWithIds);
        }
      }

      const ValidTeamCount = Round === 1 ? new Set(Users.map((U) => U["@team-id"]).filter((T) => T)).size : 0;
      let Status: TournamentMatchStatus;

      if (Round === 1) {
        if (ValidTeamCount === Tournament.MaxPlayersPerMatch) {
          Status = TournamentMatchStatus.GameReady;
        } else if (ValidTeamCount >= Tournament.MinPlayersPerMatch) {
          Status = TournamentMatchStatus.WaitingForOpponent;
        } else if (ValidTeamCount >= 1) {
          Status = TournamentMatchStatus.WaitingForOpponent;
        } else {
          Status = TournamentMatchStatus.Created;
        }
      } else {
        Status = TournamentMatchStatus.Created;
      }

      let Deadline: Date;
      if (Status === TournamentMatchStatus.GameReady) {
        const GameCount = Config.MaxGameCount;
        const TotalMinutes = GameCount * Config.MinGameLength;
        const AdjustedMinutes = TotalMinutes === Config.MaxLength ? TotalMinutes - 1 : TotalMinutes;
        const SubtractedTime = AdjustedMinutes * 60 * 1000 + 15000;
        const CheckInTime = 5 * 60 * 1000;

        const BaseTime =
          Round === 1 ? PhaseStart : new Date(PhaseStart.getTime() + Config.MaxLength * 60 * 1000 * (Round - 1));

        Deadline = new Date(BaseTime.getTime() + CheckInTime + SubtractedTime);
      } else {
        Deadline = new Date(PhaseStart.getTime() + Config.MaxLength * 60 * 1000 * Round);
      }

      CreatedMatches.push(
        new Match({
          id: MatchId,
          matchid: MatchNum + 1,
          secret: Secret,
          deadline: Deadline,
          phaseid: PhaseId,
          groupid: GroupId,
          roundid: Round,
          playedgamecount: 0,
          status: Status,
          tournamentid: TournamentId,
          users: Users,
        })
      );
    }
  }

  return CreatedMatches;
}

async function GenerateRoundRobin(
  Tournament: ITournament,
  Teams: TeamUser[][],
  PhaseId: number,
  TournamentId: string,
  RoundConfigs: Map<number, RoundConfig>,
  PhaseStart: Date
): Promise<IMatch[]> {
  const PhaseConfig = Tournament.Phases[PhaseId - 1];
  if (Teams.length < 2) return [];
  const CreatedMatches: IMatch[] = [];

  if (PhaseConfig.IsPhase) {
    const GroupCount = PhaseConfig.GroupCount || 1;

    if (GroupCount > 1) {
      const Groups: TeamUser[][][] = Array.from({ length: GroupCount }, () => []);

      for (let I = 0; I < Teams.length; I++) {
        Groups[I % GroupCount].push(Teams[I]);
      }

      for (let GroupId = 1; GroupId <= GroupCount; GroupId++) {
        const GroupTeams = Groups[GroupId - 1];
        if (GroupTeams.length < 2) continue;

        const GroupMatches = await GenerateRoundRobinGroup(
          Tournament,
          GroupTeams,
          PhaseId,
          GroupId,
          TournamentId,
          RoundConfigs,
          PhaseStart
        );
        CreatedMatches.push(...GroupMatches);

        const GroupUserIds = new Set<string>();
        GroupTeams.forEach((Team) => Team.forEach((User) => GroupUserIds.add(User["@user-id"])));

        if (GroupUserIds.size > 0) {
          await InitializePositions(TournamentId, PhaseId, Tournament.PartySize, GroupUserIds, GroupId);
        }
      }
    } else {
      const Matches = await GenerateRoundRobinGroup(
        Tournament,
        Teams,
        PhaseId,
        1,
        TournamentId,
        RoundConfigs,
        PhaseStart
      );
      CreatedMatches.push(...Matches);

      const UserIds = new Set<string>();
      Teams.forEach((Team) => Team.forEach((User) => UserIds.add(User["@user-id"])));
      await InitializePositions(TournamentId, PhaseId, Tournament.PartySize, UserIds, 1);
    }
  } else {
    const Matches = await GenerateRoundRobinGroup(
      Tournament,
      Teams,
      PhaseId,
      0,
      TournamentId,
      RoundConfigs,
      PhaseStart
    );
    CreatedMatches.push(...Matches);

    const UserIds = new Set<string>();
    Teams.forEach((Team) => Team.forEach((User) => UserIds.add(User["@user-id"])));
    await InitializePositions(TournamentId, PhaseId, Tournament.PartySize, UserIds, 0);
  }

  return CreatedMatches;
}

async function UpdateTeamPositions(
  TournamentId: string,
  PhaseId: number,
  CurrentRound: number,
  SortedTeams: Array<{ teamId: string; userIds: string[]; teamScore: number; points: number }>,
  MinQualify: number
): Promise<void> {
  const AllUserIds = SortedTeams.flatMap((T) => T.userIds);
  const Users = await BackboneUser.find({ UserId: { $in: AllUserIds } }).lean();

  const AllPartyMembers = new Set<string>(AllUserIds);
  for (const User of Users) {
    const TournamentData = GetTournamentData(User, TournamentId);
    if (TournamentData?.PartyMembers) {
      for (const Member of TournamentData.PartyMembers) {
        if (Member.UserId) AllPartyMembers.add(Member.UserId);
      }
    }
  }

  const AllRelevantUsers = await BackboneUser.find({ UserId: { $in: Array.from(AllPartyMembers) } }).lean();
  const Updates: any[] = [];

  const UserPlacementMap = new Map<string, number>();
  for (let I = 0; I < SortedTeams.length; I++) {
    const Team = SortedTeams[I];
    for (const UserId of Team.userIds) {
      UserPlacementMap.set(UserId, I + 1);
    }
  }

  for (const User of AllRelevantUsers) {
    const TournamentData = GetTournamentData(User, TournamentId);
    if (!TournamentData) continue;
    if (!TournamentData.UserPosition) TournamentData.UserPosition = [];

    let Position = TournamentData.UserPosition.find((P: any) => P.phaseid === PhaseId && P.groupid === 0);
    if (!Position) {
      Position = {
        phaseid: PhaseId,
        rankposition: 0,
        sameposition: 0,
        matchloses: 0,
        totalpoints: 0,
        totalrounds: 0,
        groupid: 0,
      };
      TournamentData.UserPosition.push(Position);
    }

    const Placement = UserPlacementMap.get(User.UserId);
    if (!Placement) continue;

    Position.totalrounds = CurrentRound;
    const IsEliminated = Placement > MinQualify;

    if (IsEliminated) {
      Position.matchloses += 1;
      Position.totalpoints -= Placement - MinQualify;
    } else {
      Position.totalpoints += MinQualify - Placement + 1;
    }

    Position.rankposition = Placement;
    Position.sameposition = 0;

    Updates.push({
      updateOne: {
        filter: { UserId: User.UserId },
        update: { $set: { [`Tournaments.${TournamentId}.UserPosition`]: TournamentData.UserPosition } },
      },
    });
  }

  if (Updates.length > 0) {
    await BackboneUser.bulkWrite(Updates, { ordered: false });
  }
}

export async function GenerateBracketMatches(Tournament: ITournament): Promise<void> {
  const PhaseId = Tournament.CurrentPhaseId || 1;
  const TournamentId = Tournament.TournamentId.toString();

  const ExistingGeneration = ActiveGenerations.get(TournamentId);
  if (ExistingGeneration) return ExistingGeneration;

  const GenerationTask = (async () => {
    try {
      const ExistingCount = await Match.countDocuments({ tournamentid: TournamentId, phaseid: PhaseId });
      if (ExistingCount > 0) return;

      const PhaseConfig = Tournament.Phases[PhaseId - 1];
      if (!PhaseConfig) return;

      const PhaseStartTime =
        PhaseId === 1 ? new Date(Tournament.StartTime) : Tournament.CurrentPhaseStarted || new Date();

      const Query = {
        [`Tournaments.${TournamentId}`]: { $exists: true },
        [`Tournaments.${TournamentId}.SignedUp`]: true,
      };

      if (PhaseId > 1) {
        Object.assign(Query, {
          $or: [
            { [`Tournaments.${TournamentId}.KnockedOut`]: { $exists: false } },
            { [`Tournaments.${TournamentId}.KnockedOut`]: false },
          ],
        });
      }

      const Users = await BackboneUser.find(Query).lean();
      const RoundConfigs = GetRoundConfigs(Tournament, PhaseId);
      let Teams: TeamUser[][] = [];
      let CreatedMatches: IMatch[] = [];

      const PhaseType = Number(PhaseConfig.PhaseType);
      const PhaseMaxTeams = PhaseConfig.MaxTeams || Math.floor(Users.length / Tournament.PartySize);

      if (PhaseType === TournamentPhaseType.RoundRobin) {
        Teams = await BuildTeams(Users, TournamentId, Tournament.PartySize);
        CreatedMatches = await GenerateRoundRobin(
          Tournament,
          Teams,
          PhaseId,
          TournamentId,
          RoundConfigs,
          PhaseStartTime
        );
      } else if (PhaseType === TournamentPhaseType.Arena) {
        Teams = await BuildTeams(Users, TournamentId, Tournament.PartySize);
        CreatedMatches = await GenerateRoundRobin(
          Tournament,
          Teams,
          PhaseId,
          TournamentId,
          RoundConfigs,
          PhaseStartTime
        );
      } else {
        const MaxTeams = Math.min(PhaseMaxTeams, 256);
        Teams = await BuildTeams(Users, TournamentId, Tournament.PartySize, MaxTeams);
        while (Teams.length < MaxTeams) Teams.push([]);
        CreatedMatches = await GenerateSingleElimination(
          Tournament,
          Teams,
          PhaseId,
          TournamentId,
          RoundConfigs,
          PhaseStartTime
        );
      }

      if (CreatedMatches.length > 0) {
        await SaveMatchesToDatabase(CreatedMatches, TournamentId);
      }
    } catch (Error) {
      throw Error;
    } finally {
      ActiveGenerations.delete(TournamentId);
    }
  })();

  ActiveGenerations.set(TournamentId, GenerationTask);
  return GenerationTask;
}

async function QualifyFromBracket(User: IBackboneUser, Tournament: ITournament): Promise<void> {
  const UserTournamentData = User.Tournaments.get(Tournament.TournamentId.toString());
  if (!UserTournamentData?.UserMatch) return;

  const PhaseId = Tournament.CurrentPhaseId || 1;
  const PhaseConfig = Tournament.Phases[PhaseId - 1];
  const CurrentMatch = UserTournamentData.UserMatch;
  const MatchId = CurrentMatch.id;

  if (ProcessedMatches.has(MatchId)) return;
  ProcessedMatches.add(MatchId);

  const DatabaseMatch = await Match.findOne({ id: CurrentMatch.id });
  if (!DatabaseMatch) return;

  const AllTeamIds = new Set<string>();
  for (const User of DatabaseMatch.users) {
    if (User["@team-id"]) AllTeamIds.add(User["@team-id"]);
  }

  const TeamScores = new Map<string, { points: number; teamScore: number; userIds: string[] }>();
  for (const TeamId of AllTeamIds) {
    const TeamUsers = DatabaseMatch.users.filter((U) => U["@team-id"] === TeamId);
    const UserIds = TeamUsers.map((U) => U["@user-id"]);
    TeamScores.set(TeamId, { points: 0, teamScore: 0, userIds: UserIds });
  }

  for (const User of DatabaseMatch.users) {
    if (User["@team-id"]) {
      const TeamData = TeamScores.get(User["@team-id"])!;
      const MatchPoints = parseInt(User["@match-points"] || "0");
      const TeamScore = parseInt(User["@team-score"] || "0");
      TeamData.points += MatchPoints;
      TeamData.teamScore = Math.max(TeamData.teamScore, TeamScore);
    }
  }

  const SortedTeams = Array.from(TeamScores.entries())
    .sort((A, B) => {
      if (B[1].teamScore !== A[1].teamScore) return B[1].teamScore - A[1].teamScore;
      return B[1].points - A[1].points;
    })
    .map(([TeamId, Data]) => ({ teamId: TeamId, ...Data }));

  if (SortedTeams.length === 0) return;

  const NextRound = CurrentMatch.roundid + 1;
  const NextMatches = await Match.find({
    tournamentid: Tournament.TournamentId.toString(),
    phaseid: PhaseId,
    roundid: NextRound,
    groupid: 0,
  }).lean();

  const IsLastRound = NextMatches.length === 0;
  const MinQualify = Math.max(1, Math.floor(Tournament.MaxPlayersPerMatch / 2));

  let QualifyingTeams: string[];
  let EliminatedTeams: string[];

  if (IsLastRound) {
    QualifyingTeams = [SortedTeams[0].teamId];
    EliminatedTeams = SortedTeams.slice(1).map((T) => T.teamId);
  } else {
    QualifyingTeams = SortedTeams.slice(0, MinQualify).map((T) => T.teamId);
    EliminatedTeams = SortedTeams.slice(MinQualify).map((T) => T.teamId);
  }

  const QualifyingUserIds = new Set<string>();
  const EliminatedUserIds = new Set<string>();

  for (const Team of SortedTeams) {
    if (QualifyingTeams.includes(Team.teamId)) {
      Team.userIds.forEach((Id) => QualifyingUserIds.add(Id));
    } else if (EliminatedTeams.includes(Team.teamId)) {
      Team.userIds.forEach((Id) => EliminatedUserIds.add(Id));
    }
  }

  const AllEliminatedPartyMembers = new Set<string>();
  for (const UserId of EliminatedUserIds) {
    const PartyMembers = await GetAllPartyMembers(UserId, Tournament.TournamentId.toString());
    for (const MemberId of PartyMembers) {
      AllEliminatedPartyMembers.add(MemberId);
    }
  }

  await Match.updateOne(
    { id: CurrentMatch.id },
    { $set: { status: TournamentMatchStatus.Closed, users: DatabaseMatch.users } }
  );

  const UpdatedMatch = await Match.findOne({ id: CurrentMatch.id }).lean();
  if (!UpdatedMatch) return;

  const MatchCopy = {
    id: UpdatedMatch.id,
    secret: UpdatedMatch.secret,
    deadline: UpdatedMatch.deadline,
    matchid: UpdatedMatch.matchid,
    phaseid: UpdatedMatch.phaseid,
    groupid: UpdatedMatch.groupid,
    roundid: UpdatedMatch.roundid,
    playedgamecount: UpdatedMatch.playedgamecount,
    status: UpdatedMatch.status,
    tournamentid: UpdatedMatch.tournamentid,
    users: UpdatedMatch.users,
  };

  const EliminatedUsers = Array.from(AllEliminatedPartyMembers);
  const QualifiedUsers = Array.from(QualifyingUserIds);

  const PhaseTypeNum = Number(PhaseConfig.PhaseType) || TournamentPhaseType.SingleEliminationBracket;
  const PhaseType = TournamentPhaseType[PhaseTypeNum] as keyof typeof TournamentPhaseType;

  if (PhaseType !== "RoundRobin" && PhaseType !== "Arena") {
    await UpdateTeamPositions(
      Tournament.TournamentId.toString(),
      PhaseId,
      CurrentMatch.roundid,
      SortedTeams,
      MinQualify
    );
  }

  const EliminatedUpdates = EliminatedUsers.map((Id) => ({
    updateOne: {
      filter: { UserId: Id, [`Tournaments.${Tournament.TournamentId}`]: { $exists: true } },
      update: {
        $set: {
          [`Tournaments.${Tournament.TournamentId}.KnockedOut`]: true,
          [`Tournaments.${Tournament.TournamentId}.UserMatch`]: null,
        },
        $push: { [`Tournaments.${Tournament.TournamentId}.UserMatches`]: MatchCopy },
      },
    },
  }));

  if (EliminatedUpdates.length > 0) {
    await BackboneUser.bulkWrite(EliminatedUpdates, { ordered: false });
  }

  const IsLastPhase = PhaseId === Tournament.Phases.length;

  if (IsLastPhase && IsLastRound) {
    const AllQualifiedPartyMembers = new Set<string>();
    for (const UserId of QualifiedUsers) {
      const PartyMembers = await GetAllPartyMembers(UserId, Tournament.TournamentId.toString());
      for (const MemberId of PartyMembers) {
        AllQualifiedPartyMembers.add(MemberId);
      }
    }

    const Winners = [];
    for (const UserId of AllQualifiedPartyMembers) {
      const WinnerUser = await BackboneUser.findOne({ UserId });
      if (WinnerUser) Winners.push({ nick: WinnerUser.Username, userId: UserId });
    }

    if (Winners.length > 0) {
      await Tournament.updateOne(
        { TournamentId: Tournament.TournamentId },
        { $addToSet: { Winners: { $each: Winners } }, $set: { Status: TournamentStatus.Finished } }
      );
      const { GenerateHallOfFame } = await import("../../Modules/HallOfFame");
      const winnerIds = Array.from(AllQualifiedPartyMembers);
      await GenerateHallOfFame(Tournament, winnerIds);
    }
  }

  const AllQualifiedPartyMembers = new Set<string>();
  for (const UserId of QualifiedUsers) {
    const PartyMembers = await GetAllPartyMembers(UserId, Tournament.TournamentId.toString());
    for (const MemberId of PartyMembers) {
      AllQualifiedPartyMembers.add(MemberId);
    }
  }

  const QualifiedUpdates = Array.from(AllQualifiedPartyMembers).map((Id) => ({
    updateOne: {
      filter: { UserId: Id, [`Tournaments.${Tournament.TournamentId}`]: { $exists: true } },
      update: {
        $set: { [`Tournaments.${Tournament.TournamentId}.UserMatch`]: null },
        $push: { [`Tournaments.${Tournament.TournamentId}.UserMatches`]: MatchCopy },
      },
    },
  }));

  if (QualifiedUpdates.length > 0) {
    await BackboneUser.bulkWrite(QualifiedUpdates, { ordered: false });
  }

  ProcessedMatches.delete(MatchId);
}

async function AssignNextMatchFromBracket(User: IBackboneUser, Tournament: ITournament): Promise<IMatch | null> {
  const UserTournamentData = User.Tournaments.get(Tournament.TournamentId.toString());
  if (!UserTournamentData) return null;

  if (UserTournamentData.PartyMembers && UserTournamentData.PartyMembers.length > 0) {
    const CurrentMember = UserTournamentData.PartyMembers.find((M: any) => M.UserId === User.UserId);
    if (!CurrentMember?.IsPartyLeader) return null;
  }

  const TournamentId = Tournament.TournamentId.toString();
  const PhaseId = Tournament.CurrentPhaseId || 1;
  const LockKey = `${TournamentId}-${PhaseId}-${User.UserId}`;

  if (BracketAssignmentLocks.has(LockKey)) {
    return BracketAssignmentLocks.get(LockKey)!;
  }

  const Task = (async () => {
    try {
      const PartyIds = new Set<string>([User.UserId]);
      if (UserTournamentData.PartyMembers) {
        for (const Member of UserTournamentData.PartyMembers) {
          if (Member?.UserId) PartyIds.add(Member.UserId);
        }
      }
      const PartyArray = Array.from(PartyIds);

      const FreshUser = await BackboneUser.findOne({ UserId: User.UserId }).lean();
      if (!FreshUser) return null;

      const FreshData = (FreshUser.Tournaments as any).get
        ? (FreshUser.Tournaments as any).get(TournamentId)
        : FreshUser.Tournaments[TournamentId];

      if (!FreshData) return null;
      if (FreshData.KnockedOut) return null;

      const PhaseConfig = Tournament.Phases[PhaseId - 1];
      const TypeNum = Number(PhaseConfig.PhaseType) || TournamentPhaseType.SingleEliminationBracket;
      const PhaseType = TournamentPhaseType[TypeNum] as keyof typeof TournamentPhaseType;

      if (PhaseType !== "RoundRobin" && PhaseType !== "Arena") {
        const CurrentPosition = FreshData.UserPosition?.find((P: any) => P.phaseid === PhaseId && P.groupid === 0);
        if (CurrentPosition && CurrentPosition.matchloses > 0) return null;
      }

      if (FreshData?.UserMatch) {
        return {
          id: FreshData.UserMatch.id,
          secret: FreshData.UserMatch.secret,
          deadline: FreshData.UserMatch.deadline,
          matchid: FreshData.UserMatch.matchid,
          phaseid: FreshData.UserMatch.phaseid,
          groupid: FreshData.UserMatch.groupid,
          roundid: FreshData.UserMatch.roundid,
          playedgamecount: FreshData.UserMatch.playedgamecount,
          status: FreshData.UserMatch.status,
          tournamentid: FreshData.UserMatch.tournamentid,
          users: FreshData.UserMatch.users,
        } as IMatch;
      }

      const LastMatch = FreshData?.UserMatches?.[FreshData.UserMatches.length - 1];
      if (!LastMatch) return null;

      const NextRound = LastMatch.roundid + 1;

      const ExistingMatch = await Match.findOne({
        tournamentid: TournamentId,
        phaseid: PhaseId,
        roundid: NextRound,
        groupid: 0,
        "users.@user-id": { $in: PartyArray },
      }).lean();

      if (ExistingMatch) {
        const MatchData = {
          id: ExistingMatch.id,
          secret: ExistingMatch.secret,
          deadline: ExistingMatch.deadline,
          matchid: ExistingMatch.matchid,
          phaseid: ExistingMatch.phaseid,
          groupid: ExistingMatch.groupid,
          roundid: ExistingMatch.roundid,
          playedgamecount: ExistingMatch.playedgamecount,
          status: ExistingMatch.status,
          tournamentid: ExistingMatch.tournamentid,
          users: ExistingMatch.users,
        };

        await BackboneUser.updateMany(
          { UserId: { $in: PartyArray }, [`Tournaments.${TournamentId}`]: { $exists: true } },
          { $set: { [`Tournaments.${TournamentId}.UserMatch`]: MatchData } }
        );

        return MatchData as IMatch;
      }

      const DatabaseMatch = await Match.findOne({ id: LastMatch.id }).lean();
      if (!DatabaseMatch) return null;

      const AllTeamIds = new Set<string>();
      for (const User of DatabaseMatch.users) {
        if (User["@team-id"]) AllTeamIds.add(User["@team-id"]);
      }

      const TeamScores = new Map<string, { points: number; teamScore: number; userIds: string[] }>();
      for (const TeamId of AllTeamIds) {
        const TeamUsers = DatabaseMatch.users.filter((U) => U["@team-id"] === TeamId);
        const UserIds = TeamUsers.map((U) => U["@user-id"]);
        TeamScores.set(TeamId, { points: 0, teamScore: 0, userIds: UserIds });
      }

      for (const User of DatabaseMatch.users) {
        if (User["@team-id"]) {
          const TeamData = TeamScores.get(User["@team-id"])!;
          const MatchPoints = parseInt(User["@match-points"] || "0");
          const TeamScore = parseInt(User["@team-score"] || "0");
          TeamData.points += MatchPoints;
          TeamData.teamScore = Math.max(TeamData.teamScore, TeamScore);
        }
      }

      const SortedTeams = Array.from(TeamScores.entries())
        .sort((A, B) => {
          if (B[1].teamScore !== A[1].teamScore) return B[1].teamScore - A[1].teamScore;
          return B[1].points - A[1].points;
        })
        .map(([TeamId, Data]) => ({ teamId: TeamId, ...Data }));

      const MinQualify = Math.max(1, Math.floor(Tournament.MaxPlayersPerMatch / 2));
      const QualifyingTeams = SortedTeams.slice(0, MinQualify).map((T) => T.teamId);

      const UserTeamId = DatabaseMatch.users.find((U) => U["@user-id"] === User.UserId)?.["@team-id"];
      if (!UserTeamId || !QualifyingTeams.includes(UserTeamId)) return null;

      const SortedNextMatches = await Match.find({
        tournamentid: TournamentId,
        phaseid: PhaseId,
        roundid: NextRound,
        groupid: 0,
      }).sort({ matchid: 1 });

      if (SortedNextMatches.length === 0) return null;

      const QualifyingTeamUsers = new Map<string, TeamUser[]>();
      for (const User of DatabaseMatch.users) {
        if (QualifyingTeams.includes(User["@team-id"])) {
          if (!QualifyingTeamUsers.has(User["@team-id"])) {
            QualifyingTeamUsers.set(User["@team-id"], []);
          }
          QualifyingTeamUsers.get(User["@team-id"])!.push(User);
        }
      }

      const SortedQualifyingTeams = QualifyingTeams.map((TeamId) => QualifyingTeamUsers.get(TeamId)!);

      const BaseSlotIndex = (LastMatch.matchid - 1) * MinQualify;

      let MyTeamIndex = -1;
      for (let i = 0; i < SortedQualifyingTeams.length; i++) {
        const TeamUsers = SortedQualifyingTeams[i];
        if (TeamUsers.some((U) => U["@user-id"] === User.UserId)) {
          MyTeamIndex = i;
          break;
        }
      }

      if (MyTeamIndex === -1) return null;

      const TeamUsers = SortedQualifyingTeams[MyTeamIndex];
      const AbsoluteSlotIndex = BaseSlotIndex + MyTeamIndex;
      const TargetMatchIndex = Math.floor(AbsoluteSlotIndex / Tournament.MaxPlayersPerMatch);
      const SlotInTargetMatch = AbsoluteSlotIndex % Tournament.MaxPlayersPerMatch;

      const TargetMatch = SortedNextMatches[TargetMatchIndex];
      if (!TargetMatch) return null;

      const MatchLockKey = `match-${TargetMatch.id}`;

      while (MatchModificationLocks.has(MatchLockKey)) {
        await MatchModificationLocks.get(MatchLockKey);
      }

      const ModifyTask = (async () => {
        try {
          const CurrentMatch = await Match.findOne({ id: TargetMatch.id }).lean();
          if (!CurrentMatch) return;

          const AlreadyInMatch = CurrentMatch.users.some((U: any) => PartyArray.includes(U["@user-id"]));
          if (AlreadyInMatch) return;

          const DoubleCheckUser = await BackboneUser.findOne({ UserId: User.UserId }).lean();
          if (!DoubleCheckUser) return;

          const DoubleCheckData = (DoubleCheckUser.Tournaments as any).get
            ? (DoubleCheckUser.Tournaments as any).get(TournamentId)
            : DoubleCheckUser.Tournaments[TournamentId];

          if (!DoubleCheckData) return;
          if (DoubleCheckData.KnockedOut) return;

          if (PhaseType !== "RoundRobin" && PhaseType !== "Arena") {
            const DoubleCheckPosition = DoubleCheckData.UserPosition?.find(
              (P: any) => P.phaseid === PhaseId && P.groupid === 0
            );
            if (DoubleCheckPosition && DoubleCheckPosition.matchloses > 0) return;
          }

          const NewTeamId = (SlotInTargetMatch + 1).toString();

          const UniqueUsers = Array.from(new Map(TeamUsers.map((u) => [u["@user-id"], u])).values()).slice(
            0,
            Tournament.PartySize
          );

          const NewUsers = UniqueUsers.map((U: any) => ({
            "@user-id": U["@user-id"],
            "@team-id": NewTeamId,
            "@checked-in": "0",
            "@nick": U["@nick"],
            "@user-score": "0",
            "@team-score": "0",
            "@user-points": "0",
            "@team-points": "0",
            "@match-points": "0",
            "@match-winner": "0",
          }));

          await Match.updateOne(
            {
              id: TargetMatch.id,
              "users.@user-id": { $nin: PartyArray },
            },
            {
              $push: { users: { $each: NewUsers } },
            }
          );

          const UpdatedMatch = await Match.findOne({ id: TargetMatch.id });
          if (!UpdatedMatch) return;

          const UniqueTeams = new Set(
            UpdatedMatch.users.map((U: any) => U["@team-id"]).filter((Id: string) => Id !== "")
          ).size;

          const OldStatus = UpdatedMatch.status;
          let NewStatus = OldStatus;
          let ShouldUpdateDeadline = false;

          if (UniqueTeams === Tournament.MaxPlayersPerMatch) {
            NewStatus = TournamentMatchStatus.GameReady;
            ShouldUpdateDeadline = true;
          } else if (UniqueTeams >= 1) {
            NewStatus = TournamentMatchStatus.WaitingForOpponent;
          } else {
            NewStatus = TournamentMatchStatus.Created;
          }

          UpdatedMatch.status = NewStatus;

          if (ShouldUpdateDeadline) {
            const RoundConfigs = GetRoundConfigs(Tournament, PhaseId);
            const Config = RoundConfigs.get(NextRound) || { MinGameLength: 8, MaxLength: 12, MaxGameCount: 1 };
            const GameCount = Config.MaxGameCount;
            const TotalMinutes = GameCount * Config.MinGameLength;
            const AdjustedMinutes = TotalMinutes === Config.MaxLength ? TotalMinutes - 1 : TotalMinutes;
            const SubtractedTime = AdjustedMinutes * 60 * 1000 + 15000;
            const CheckInTime = 5 * 60 * 1000;
            UpdatedMatch.deadline = new Date(Date.now() + CheckInTime + SubtractedTime);
          }

          await UpdatedMatch.save();

          if (ShouldUpdateDeadline) {
            const FinalMatchData = await Match.findOne({ id: TargetMatch.id }).lean();
            if (FinalMatchData) {
              const AllMatchUserIds = FinalMatchData.users.map((U: any) => U["@user-id"]);
              const MatchDataForUsers = {
                id: FinalMatchData.id,
                secret: FinalMatchData.secret,
                deadline: FinalMatchData.deadline,
                matchid: FinalMatchData.matchid,
                phaseid: FinalMatchData.phaseid,
                groupid: FinalMatchData.groupid,
                roundid: FinalMatchData.roundid,
                playedgamecount: FinalMatchData.playedgamecount,
                status: FinalMatchData.status,
                tournamentid: FinalMatchData.tournamentid,
                users: FinalMatchData.users,
              };

              await BackboneUser.updateMany(
                { UserId: { $in: AllMatchUserIds }, [`Tournaments.${TournamentId}`]: { $exists: true } },
                { $set: { [`Tournaments.${TournamentId}.UserMatch`]: MatchDataForUsers } }
              );
            }
          }
        } finally {
          MatchModificationLocks.delete(MatchLockKey);
        }
      })();

      MatchModificationLocks.set(MatchLockKey, ModifyTask);
      await ModifyTask;

      const FinalMatch = await Match.findOne({ id: TargetMatch.id }).lean();
      if (!FinalMatch) return null;

      const MyTeamInMatch = FinalMatch.users.some((U: any) => PartyArray.includes(U["@user-id"]));
      if (!MyTeamInMatch) return null;

      const MatchData = {
        id: FinalMatch.id,
        secret: FinalMatch.secret,
        deadline: FinalMatch.deadline,
        matchid: FinalMatch.matchid,
        phaseid: FinalMatch.phaseid,
        groupid: FinalMatch.groupid,
        roundid: FinalMatch.roundid,
        playedgamecount: FinalMatch.playedgamecount,
        status: FinalMatch.status,
        tournamentid: FinalMatch.tournamentid,
        users: FinalMatch.users,
      };

      await BackboneUser.updateMany(
        { UserId: { $in: PartyArray }, [`Tournaments.${TournamentId}`]: { $exists: true } },
        { $set: { [`Tournaments.${TournamentId}.UserMatch`]: MatchData } }
      );

      return MatchData as IMatch;
    } catch (Err) {
      throw Err;
    } finally {
      BracketAssignmentLocks.delete(LockKey);
    }
  })();

  BracketAssignmentLocks.set(LockKey, Task);
  return Task;
}

export async function Qualify(User: IBackboneUser, Tournament: ITournament): Promise<void> {
  const UserTournamentData = User.Tournaments.get(Tournament.TournamentId.toString());
  if (!UserTournamentData?.UserMatch) return;
  const PhaseId = Tournament.CurrentPhaseId || 1;
  const PhaseConfig = Tournament.Phases[PhaseId - 1];
  if (!PhaseConfig) return;
  const PhaseType = Number(PhaseConfig.PhaseType);
  const CurrentMatch = UserTournamentData.UserMatch;
  const DatabaseMatch = await Match.findOne({ id: CurrentMatch.id });
  if (!DatabaseMatch) return;
  const HasWinner = DatabaseMatch.users.some((U: any) => U["@match-winner"] === "1");
  if (!HasWinner) {
    const UserTeamId = DatabaseMatch.users.find((U: any) => U["@user-id"] === User.UserId)?.["@team-id"];
    if (UserTeamId) {
      for (const MatchUser of DatabaseMatch.users) {
        if (MatchUser["@team-id"] === UserTeamId) {
          MatchUser["@match-winner"] = "1";
          MatchUser["@match-points"] = "1";
          MatchUser["@team-score"] = "1";
        } else {
          MatchUser["@match-winner"] = "0";
          MatchUser["@match-points"] = "0";
          MatchUser["@team-score"] = "0";
        }
      }

      await DatabaseMatch.save();

      const FreshMatch = await Match.findOne({ id: CurrentMatch.id }).lean();
      if (FreshMatch) {
        UserTournamentData.UserMatch = {
          id: FreshMatch.id,
          secret: FreshMatch.secret,
          deadline: FreshMatch.deadline,
          matchid: FreshMatch.matchid,
          phaseid: FreshMatch.phaseid,
          groupid: FreshMatch.groupid,
          roundid: FreshMatch.roundid,
          playedgamecount: FreshMatch.playedgamecount,
          status: FreshMatch.status,
          tournamentid: FreshMatch.tournamentid,
          users: FreshMatch.users,
        };
      }
    }
  }
  if (PhaseType === TournamentPhaseType.RoundRobin || PhaseType === TournamentPhaseType.Arena) {
    await QualifyPhase(User, Tournament);
  } else {
    await QualifyFromBracket(User, Tournament);
  }
}
export async function GetUserMatch(User: IBackboneUser, Tournament: ITournament): Promise<IUserMatch | null> {
  const PhaseId = Tournament.CurrentPhaseId || 1;
  const UserTournamentData = User.Tournaments.get(Tournament.TournamentId.toString());
  if (!UserTournamentData || UserTournamentData.KnockedOut) return null;
  const UserPosition = UserTournamentData.UserPosition?.find((P: any) => P.phaseid === PhaseId);
  const GroupId = UserPosition?.groupid || 0;
  const LastClosedMatch = await Match.findOne({
    "users.@user-id": User.UserId,
    tournamentid: Tournament.TournamentId.toString(),
    phaseid: PhaseId,
    groupid: GroupId,
    status: { $in: [TournamentMatchStatus.Closed, TournamentMatchStatus.GameFinished] },
  })
    .sort({ roundid: -1 })
    .select("roundid")
    .lean();
  const MinRound = LastClosedMatch ? LastClosedMatch.roundid + 1 : 1;
  const FoundMatch = await Match.findOne({
    "users.@user-id": User.UserId,
    tournamentid: Tournament.TournamentId.toString(),
    phaseid: PhaseId,
    groupid: GroupId,
    roundid: { $gte: MinRound },
    status: {
      $nin: [TournamentMatchStatus.Closed, TournamentMatchStatus.GameFinished, TournamentMatchStatus.GameInProgress],
    },
  })
    .sort({ roundid: 1, matchid: 1 })
    .lean();
  if (FoundMatch) {
    return {
      id: FoundMatch.id,
      secret: FoundMatch.secret,
      deadline: FoundMatch.deadline,
      matchid: FoundMatch.matchid,
      phaseid: FoundMatch.phaseid,
      groupid: FoundMatch.groupid,
      roundid: FoundMatch.roundid,
      playedgamecount: FoundMatch.playedgamecount,
      status: FoundMatch.status,
      users: JSON.parse(JSON.stringify(FoundMatch.users)),
      tournamentid: FoundMatch.tournamentid,
    };
  }
  return null;
}

export async function AssignNextMatchIfNeeded(User: IBackboneUser, Tournament: ITournament): Promise<IMatch | null> {
  const UserInfo = User.Tournaments.get(Tournament.TournamentId.toString());
  if (!UserInfo || UserInfo.KnockedOut) return null;
  const PhaseId = Tournament.CurrentPhaseId || 1;
  const PhaseConfig = Tournament.Phases[PhaseId - 1];
  if (!PhaseConfig) return null;
  const PhaseType = Number(PhaseConfig.PhaseType);
  if (PhaseType === TournamentPhaseType.RoundRobin || PhaseType === TournamentPhaseType.Arena) {
    return await CreateOrAssignMatch(User, Tournament);
  } else {
    return await AssignNextMatchFromBracket(User, Tournament);
  }
}
export async function GetTournamentMatches(
  TournamentId: string,
  PhaseId: number,
  GroupId: number,
  FromRound: number,
  ToRound: number,
  MaxResults: number,
  Page: number
) {
  const Skip = (Page - 1) * MaxResults;
  const Phase = PhaseId || 1;
  const Query: any = { tournamentid: TournamentId, phaseid: Phase, groupid: GroupId };
  if (FromRound > 0 && ToRound > 0) {
    Query.roundid = { $gte: FromRound, $lte: ToRound };
  }
  const [Matches, Total] = await Promise.all([
    Match.find(Query).sort({ roundid: 1, matchid: 1 }).skip(Skip).limit(MaxResults).lean(),
    Match.countDocuments(Query),
  ]);
  const FormattedMatches = Matches.map((M) => ({
    id: M.id,
    secret: M.secret,
    deadline: M.deadline,
    matchid: M.matchid,
    phaseid: M.phaseid,
    groupid: M.groupid,
    roundid: M.roundid,
    playedgamecount: M.playedgamecount,
    status: M.status,
    users: M.users,
    tournamentid: M.tournamentid,
  }));
  return {
    pagination: {
      totalResultCount: Total,
      maxResults: MaxResults, 
      currentPage: Page 
  },
    matches: FormattedMatches,
  };
} 
