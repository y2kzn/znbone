  import { TournamentMatchStatus, TournamentPhaseType, TournamentStatus } from "../../Config";
  import { BackboneUser, IBackboneUser } from "../../../Models/BackboneUser";
  import { ITournament, Tournament } from "../../../Models/Tournament";
  import { Match, IMatch } from "../../../Models/Matches";
  import { GetNextPhaseStarted } from "../../Settings/Properties";
  import { GenerateBracketMatches, GetTournamentData } from "../GetMatches";
  import { GetRoundConfigs } from "../../Settings/Rules";
  import * as crypto from "crypto";

  const AssignmentLocks = new Map<string, Promise<IMatch | null>>();

  export async function GetAllPartyMembers(UserId: string, TournamentId: string): Promise<Set<string>> {
    const Members = new Set<string>([UserId]);
    const User = await BackboneUser.findOne({ UserId }).lean();
    if (!User) return Members;

    const Data = (User.Tournaments as any).get
      ? (User.Tournaments as any).get(TournamentId)
      : User.Tournaments[TournamentId];

    if (Data?.PartyMembers) {
      for (const Member of Data.PartyMembers) {
        if (Member?.UserId) Members.add(Member.UserId);
      }
    }
    return Members;
  }


  export async function CreateOrAssignMatch(User: IBackboneUser, Tournament: ITournament): Promise<IMatch | null> {
    const PhaseId = Tournament.CurrentPhaseId || 1;
    const TournamentId = Tournament.TournamentId.toString();
    const UserInfo = User.Tournaments.get(TournamentId);
    if (!UserInfo) return null;

    const PhaseConfig = Tournament.Phases[PhaseId - 1];
    if (!PhaseConfig) return null;

    if (UserInfo.PartyMembers && UserInfo.PartyMembers.length > 0) {
      const CurrentMember = UserInfo.PartyMembers.find((M: any) => M.UserId === User.UserId);
      if (!CurrentMember?.IsPartyLeader) return null;
    }

    const LockKey = `${TournamentId}-${PhaseId}-${User.UserId}`;
    if (AssignmentLocks.has(LockKey)) return AssignmentLocks.get(LockKey)!;

    const Task = (async () => {
      try {
        const UserPosition = UserInfo.UserPosition?.find((P: any) => P.phaseid === PhaseId);
        const GroupId = UserPosition?.groupid || 0;

        const PartyIds = new Set<string>([User.UserId]);
        if (UserInfo.PartyMembers) {
          for (const Member of UserInfo.PartyMembers) {
            if (Member?.UserId) PartyIds.add(Member.UserId);
          }
        }
        const PartyArray = Array.from(PartyIds);

        if (PartyArray.length !== Tournament.PartySize) return null;

        const ActiveMatch = await Match.findOne({
          tournamentid: TournamentId,
          phaseid: PhaseId,
          groupid: GroupId,
          "users.@user-id": { $in: PartyArray },
          status: { $nin: [TournamentMatchStatus.Closed, TournamentMatchStatus.GameFinished] },
        })
          .sort({ roundid: 1, matchid: 1 })
          .lean();

        if (ActiveMatch) {
          return {
            id: ActiveMatch.id,
            secret: ActiveMatch.secret,
            deadline: ActiveMatch.deadline,
            matchid: ActiveMatch.matchid,
            phaseid: ActiveMatch.phaseid,
            groupid: ActiveMatch.groupid,
            roundid: ActiveMatch.roundid,
            playedgamecount: ActiveMatch.playedgamecount,
            status: ActiveMatch.status,
            tournamentid: ActiveMatch.tournamentid,
            users: ActiveMatch.users,
          } as IMatch;
        }

        const LastCompleted = await Match.findOne({
          tournamentid: TournamentId,
          phaseid: PhaseId,
          groupid: GroupId,
          "users.@user-id": { $in: PartyArray },
          status: { $in: [TournamentMatchStatus.Closed, TournamentMatchStatus.GameFinished] },
        })
          .sort({ roundid: -1 })
          .select("roundid")
          .lean();

        const NextRoundId = (LastCompleted?.roundid || 0) + 1;

        const Available = await Match.find({
          tournamentid: TournamentId,
          phaseid: PhaseId,
          groupid: GroupId,
          roundid: NextRoundId,
          "users.@user-id": { $nin: PartyArray },
          status: { $in: [TournamentMatchStatus.Created, TournamentMatchStatus.WaitingForOpponent] },
        })
          .select("id users status matchid")
          .sort({ matchid: 1 })
          .lean();

        if (Available.length === 0) return null;

        const MaxTeams = Tournament.MaxPlayersPerMatch;
        const UserPoints = UserPosition?.totalpoints || 0;

        const AllMatchUserIds = new Set<string>();
        for (const M of Available) {
          for (const U of M.users) {
            AllMatchUserIds.add(U["@user-id"]);
          }
        }

        const OpponentUsers = await BackboneUser.find({
          UserId: { $in: Array.from(AllMatchUserIds) },
        })
          .select("UserId Tournaments")
          .lean();

        const OpponentPoints = new Map<string, number>();
        for (const OppUser of OpponentUsers) {
          const OppData = (OppUser.Tournaments as any).get
            ? (OppUser.Tournaments as any).get(TournamentId)
            : OppUser.Tournaments[TournamentId];
          if (OppData) {
            const OppPos = OppData.UserPosition?.find((P: any) => P.phaseid === PhaseId && P.groupid === GroupId);
            if (OppPos) {
              OpponentPoints.set(OppUser.UserId, OppPos.totalpoints || 0);
            }
          }
        }

        const ScoredMatches = Available.map((M) => {
          const Teams = new Set(M.users.map((U: any) => U["@team-id"]).filter((T: string) => T));
          if (Teams.size >= MaxTeams) return { match: M, score: -999999 };

          const HasConflict = M.users.some((U: any) => PartyIds.has(U["@user-id"]));
          if (HasConflict) return { match: M, score: -999999 };

          if (M.users.length === 0) return { match: M, score: 10000 };

          const MatchUserIds = M.users.map((U: any) => U["@user-id"]);
          const AvgPoints =
            MatchUserIds.reduce((Sum, Id) => Sum + (OpponentPoints.get(Id) || 0), 0) / MatchUserIds.length;
          const Diff = Math.abs(UserPoints - AvgPoints);

          return { match: M, score: 10000 - Diff };
        });

        ScoredMatches.sort((A, B) => B.score - A.score);

        let Selected: any = null;
        for (const Item of ScoredMatches) {
          if (Item.score > -999999) {
            Selected = Item.match;
            break;
          }
        }

        if (!Selected) {
          for (const M of Available) {
            const Teams = new Set(M.users.map((U: any) => U["@team-id"]).filter((T: string) => T));
            if (Teams.size >= MaxTeams) continue;

            const HasConflict = M.users.some((U: any) => PartyIds.has(U["@user-id"]));
            if (HasConflict) continue;

            Selected = M;
            break;
          }
        }

        if (!Selected) return null;

        const existingTeamIds = Selected.users
          .map((U: any) => U["@team-id"])
          .filter((T: string) => T && T !== "");
        
        let NewTeamId = "";
        for (let i = 1; i <= MaxTeams; i++) {
          const teamId = i.toString();
          if (!existingTeamIds.includes(teamId)) {
            NewTeamId = teamId;
            break;
          }
        }
        
        if (!NewTeamId) return null;

        const NewUsers = Array.from(PartyIds).map((Id) => {
          const UserData = Id === User.UserId ? User : UserInfo.PartyMembers?.find((M: any) => M.UserId === Id);
          return {
            "@user-id": Id,
            "@team-id": NewTeamId,
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

        const UniqueTeams = new Set(
          [...Selected.users, ...NewUsers].map((U: any) => U["@team-id"]).filter((T: string) => T)
        ).size;

        const MinTeams = Tournament.MinPlayersPerMatch;
        const NewStatus =
          UniqueTeams >= MinTeams ? TournamentMatchStatus.GameReady : TournamentMatchStatus.WaitingForOpponent;

        const UpdateQuery: any = { $push: { users: { $each: NewUsers } }, $set: { status: NewStatus } };

        if (NewStatus === TournamentMatchStatus.GameReady) {
          const RoundConfigs = GetRoundConfigs(Tournament, PhaseId);
          const Config = RoundConfigs.get(NextRoundId) || { MinGameLength: 8, MaxLength: 12, MaxGameCount: 1 };
          const GameCount = Config.MaxGameCount;
          const TotalMinutes = GameCount * Config.MinGameLength;
          const AdjustedMinutes = TotalMinutes === Config.MaxLength ? TotalMinutes - 1 : TotalMinutes;
          const SubtractedTime = AdjustedMinutes * 60 * 1000 + 15000;
          const CheckInTime = 5 * 60 * 1000;
          UpdateQuery.$set.deadline = new Date(Date.now() + CheckInTime + SubtractedTime);
        }

        const Updated = await Match.findOneAndUpdate(
          {
            id: Selected.id,
            "users.@user-id": { $nin: PartyArray },
            "users.@team-id": { $ne: NewTeamId },
            status: { $in: [TournamentMatchStatus.Created, TournamentMatchStatus.WaitingForOpponent] },
          },
          UpdateQuery,
          { new: true }
        ).lean();

        if (!Updated) {
          const Retry = await Match.findOne({
            tournamentid: TournamentId,
            phaseid: PhaseId,
            groupid: GroupId,
            roundid: NextRoundId,
            "users.@user-id": { $in: PartyArray },
            status: { $nin: [TournamentMatchStatus.Closed, TournamentMatchStatus.GameFinished] },
          }).lean();

          if (Retry) {
            return {
              id: Retry.id,
              secret: Retry.secret,
              deadline: Retry.deadline,
              matchid: Retry.matchid,
              phaseid: Retry.phaseid,
              groupid: Retry.groupid,
              roundid: Retry.roundid,
              playedgamecount: Retry.playedgamecount,
              status: Retry.status,
              tournamentid: Retry.tournamentid,
              users: Retry.users,
            } as IMatch;
          }
          return null;
        }

        const MatchData = {
          id: Updated.id,
          secret: Updated.secret,
          deadline: Updated.deadline,
          matchid: Updated.matchid,
          phaseid: Updated.phaseid,
          groupid: Updated.groupid,
          roundid: Updated.roundid,
          playedgamecount: Updated.playedgamecount,
          status: Updated.status,
          tournamentid: Updated.tournamentid,
          users: Updated.users,
        };

        const AllUserIds = Updated.users.map((U: any) => U["@user-id"]);
        await BackboneUser.updateMany(
          { UserId: { $in: AllUserIds }, [`Tournaments.${TournamentId}`]: { $exists: true } },
          { $set: { [`Tournaments.${TournamentId}.UserMatch`]: MatchData } }
        );

        return MatchData as IMatch;
      } catch (Err) {
        throw Err;
      } finally {
        AssignmentLocks.delete(LockKey);
      }
    })();

    AssignmentLocks.set(LockKey, Task);
    return Task;
  }

  async function GetLeaderId(UserId: string, TournamentId: string): Promise<string> {
    const User = await BackboneUser.findOne({ UserId }).lean();
    if (!User) return UserId;

    const Data = (User.Tournaments as any).get
      ? (User.Tournaments as any).get(TournamentId)
      : User.Tournaments[TournamentId];
    if (!Data?.PartyMembers?.length) return UserId;

    const Leader = Data.PartyMembers.find((M: any) => M.IsPartyLeader);
    return Leader ? Leader.UserId : UserId;
  }

  async function UpdatePositions(TournamentId: string, PhaseId: number, GroupId: number) {
    const Matches = await Match.find({
      tournamentid: TournamentId,
      phaseid: PhaseId,
      groupid: GroupId,
      status: { $in: [TournamentMatchStatus.Closed, TournamentMatchStatus.GameFinished] },
    }).lean();

    const Stats = new Map<
      string,
      {
        Points: number;
        Wins: number;
        Loses: number;
        Rounds: number;
        Members: Set<string>;
        GameWins: number;
        GameLoses: number;
        LoseWeight: number;
      }
    >();

    for (const Match of Matches) {
      const Teams = new Map<string, any[]>();
      for (const U of Match.users) {
        const TeamId = U["@team-id"];
        if (!TeamId) continue;
        if (!Teams.has(TeamId)) Teams.set(TeamId, []);
        Teams.get(TeamId)!.push(U);
      }

      for (const [TeamId, TeamUsers] of Teams.entries()) {
        if (TeamUsers.length === 0) continue;

        const Points = parseInt(TeamUsers[0]["@match-points"] || "0");
        const TeamScore = parseInt(TeamUsers[0]["@team-score"] || "0");
        const UserScore = parseInt(TeamUsers[0]["@user-score"] || "0");
        const Score = Math.max(TeamScore, UserScore);
        const Winner = TeamUsers.some((U) => U["@match-winner"] === "1");

        const FirstId = TeamUsers[0]["@user-id"];
        const Leader = await GetLeaderId(FirstId, TournamentId);
        const Members = await GetAllPartyMembers(Leader, TournamentId);

        if (!Stats.has(Leader)) {
          Stats.set(Leader, {
            Points: 0,
            Wins: 0,
            Loses: 0,
            Rounds: 0,
            Members: Members,
            GameWins: 0,
            GameLoses: 0,
            LoseWeight: 0,
          });
        }

        const Stat = Stats.get(Leader)!;
        Stat.Rounds += 1;

        if (Winner) {
          Stat.Wins += 1;
          Stat.Points += Points > 0 ? Points : 1;
          Stat.GameWins += Score > 0 ? Score : 1;
        } else {
          Stat.Loses += 1;
          let OpponentScore = 0;
          for (const [OtherTeam, OtherUsers] of Teams.entries()) {
            if (OtherTeam !== TeamId) {
              const OtherWinner = OtherUsers.some((U) => U["@match-winner"] === "1");
              if (OtherWinner) {
                const OtherTeamScore = parseInt(OtherUsers[0]["@team-score"] || "0");
                const OtherUserScore = parseInt(OtherUsers[0]["@user-score"] || "0");
                OpponentScore = Math.max(OtherTeamScore, OtherUserScore);
                break;
              }
            }
          }
          Stat.GameLoses += OpponentScore > 0 ? OpponentScore : 1;
          Stat.LoseWeight += Stat.Rounds;
        }
      }
    }

    const Rankings = Array.from(Stats.entries()).map(([Leader, Stat]) => ({
      Leader,
      Members: Stat.Members,
      Points: Stat.Points,
      Wins: Stat.Wins,
      Loses: Stat.Loses,
      Rounds: Stat.Rounds,
      GameWins: Stat.GameWins,
      GameLoses: Stat.GameLoses,
      LoseWeight: Stat.LoseWeight,
    }));

    Rankings.sort((A, B) => {
      if (B.Points !== A.Points) return B.Points - A.Points;
      if (B.Wins !== A.Wins) return B.Wins - A.Wins;
      if (A.Loses !== B.Loses) return A.Loses - B.Loses;
      if (B.GameWins !== A.GameWins) return B.GameWins - A.GameWins;
      if (A.GameLoses !== B.GameLoses) return A.GameLoses - B.GameLoses;
      if (A.LoseWeight !== B.LoseWeight) return A.LoseWeight - B.LoseWeight;
      return 0;
    });

    const AllIds = new Set<string>();
    for (const Rank of Rankings) {
      for (const Mid of Rank.Members) AllIds.add(Mid);
    }

    const Users = await BackboneUser.find({ UserId: { $in: Array.from(AllIds) } }).lean();
    const UserMap = new Map(Users.map((U) => [U.UserId, U]));
    const Ops: any[] = [];

    for (let I = 0; I < Rankings.length; I++) {
      const Team = Rankings[I];
      const Rank = I + 1;

      for (const MemberId of Team.Members) {
        const User = UserMap.get(MemberId);
        if (!User) continue;

        const Data = (User.Tournaments as any).get
          ? (User.Tournaments as any).get(TournamentId)
          : User.Tournaments[TournamentId];
        if (!Data) continue;
        if (!Data.UserPosition) Data.UserPosition = [];

        let Entry = Data.UserPosition.find((P: any) => P.phaseid === PhaseId && P.groupid === GroupId);

        if (!Entry) {
          Entry = {
            phaseid: PhaseId,
            rankposition: Rank,
            sameposition: 0,
            matchloses: Team.Loses,
            totalpoints: Team.Points,
            totalrounds: Team.Rounds,
            groupid: GroupId,
          };
          Data.UserPosition.push(Entry);
        } else {
          Entry.rankposition = Rank;
          Entry.sameposition = 0;
          Entry.matchloses = Team.Loses;
          Entry.totalpoints = Team.Points;
          Entry.totalrounds = Team.Rounds;
        }

        Ops.push({
          updateOne: {
            filter: { UserId: MemberId },
            update: { $set: { [`Tournaments.${TournamentId}`]: Data } },
          },
        });
      }
    }

    if (Ops.length > 0) await BackboneUser.bulkWrite(Ops);
  }

  export async function CheckPhases(T: ITournament): Promise<void> {
    const Now = new Date();
    if (!T.NextPhaseStarted || Now < T.NextPhaseStarted) return;

    const Current = T.CurrentPhaseId;
    const Phase = T.Phases[Current - 1];
    if (!Phase) return;

    const Next = Current + 1;
    const NextPhase = T.Phases[Next - 1];
    if (!NextPhase) return;

    const QualTime = new Date(T.NextPhaseStarted.getTime() - 2 * 60 * 1000);
    const ShouldQual = Now >= QualTime;

    const TypeNum = Number(Phase.PhaseType) || TournamentPhaseType.SingleEliminationBracket;
    const Type = TournamentPhaseType[TypeNum] as keyof typeof TournamentPhaseType;

    if ((Type === "RoundRobin" || Type === "Arena") && ShouldQual && Phase.IsPhase && Phase.GroupCount) {
      await QualifyGroups(T, Current, Next);
    }

    const Delay = await GetNextPhaseStarted(T, Next);
    await Tournament.updateOne(
      { TournamentId: T.TournamentId },
      { $set: { CurrentPhaseId: Next, CurrentPhaseStarted: new Date(), NextPhaseStarted: new Date(Date.now() + Delay) } }
    );

    const Updated = await Tournament.findOne({ TournamentId: T.TournamentId });
    if (Updated) await GenerateBracketMatches(Updated);
  }

  async function QualifyGroups(T: ITournament, Current: number, Next: number): Promise<void> {
    const CurrentPhase = T.Phases[Current - 1];
    const NextPhase = T.Phases[Next - 1];
    if (!CurrentPhase.IsPhase || !CurrentPhase.GroupCount || !NextPhase) return;

    const Groups = CurrentPhase.GroupCount;
    const NextMax = NextPhase.MaxTeams || 0;
    const PerGroup = Math.floor(NextMax / Groups);

    const Promises = [];
    for (let G = 1; G <= Groups; G++) {
      Promises.push(QualifyTop(T.TournamentId.toString(), Current, G, PerGroup));
    }
    await Promise.all(Promises);
  }

  export async function QualifyTop(TournamentId: string, PhaseId: number, GroupId: number, Count: number): Promise<void> {
    await UpdatePositions(TournamentId, PhaseId, GroupId);

    const Users = await BackboneUser.find({
      [`Tournaments.${TournamentId}.SignedUp`]: true,
      [`Tournaments.${TournamentId}.UserPosition`]: { $elemMatch: { phaseid: PhaseId, groupid: GroupId } },
    }).lean();

    interface TeamData {
      Leader: string;
      Members: Set<string>;
      Rank: number;
      Points: number;
      Loses: number;
      Rounds: number;
    }

    const TeamMap = new Map<string, TeamData>();
    const Done = new Set<string>();

    for (const User of Users) {
      const Leader = await GetLeaderId(User.UserId, TournamentId);
      if (Done.has(Leader)) continue;
      Done.add(Leader);

      const LeaderUser = await BackboneUser.findOne({ UserId: Leader }).lean();
      if (!LeaderUser) continue;

      const Data = (LeaderUser.Tournaments as any).get
        ? (LeaderUser.Tournaments as any).get(TournamentId)
        : LeaderUser.Tournaments[TournamentId];
      if (!Data) continue;

      const Pos = Data.UserPosition?.find((P: any) => P.phaseid === PhaseId && P.groupid === GroupId);
      if (!Pos) continue;

      const Members = await GetAllPartyMembers(Leader, TournamentId);
      TeamMap.set(Leader, {
        Leader,
        Members,
        Rank: Pos.rankposition || 9999,
        Points: Pos.totalpoints || 0,
        Loses: Pos.matchloses || 0,
        Rounds: Pos.totalrounds || 0,
      });
    }

    const Sorted = Array.from(TeamMap.values()).sort((A, B) => {
      if (A.Rank !== B.Rank) return A.Rank - B.Rank;
      if (A.Points !== B.Points) return B.Points - A.Points;
      if (A.Loses !== B.Loses) return A.Loses - B.Loses;
      return B.Rounds - A.Rounds;
    });

    const Qualified = Sorted.slice(0, Math.min(Count, Sorted.length));
    const Eliminated = Sorted.slice(Qualified.length);

    const QualIds = new Set<string>();
    for (const Team of Qualified) {
      for (const Mid of Team.Members) QualIds.add(Mid);
    }

    const ElimIds = new Set<string>();
    for (const Team of Eliminated) {
      for (const Mid of Team.Members) ElimIds.add(Mid);
    }

    const AllIds = new Set([...QualIds, ...ElimIds]);
    const AllUsers = await BackboneUser.find({ UserId: { $in: Array.from(AllIds) } }).lean();
    const Ops: any[] = [];

    for (const User of AllUsers) {
      const Data = (User.Tournaments as any).get
        ? (User.Tournaments as any).get(TournamentId)
        : User.Tournaments[TournamentId];
      if (!Data) continue;

      if (QualIds.has(User.UserId)) {
        Data.KnockedOut = false;
        Ops.push({
          updateOne: {
            filter: { UserId: User.UserId },
            update: { $set: { [`Tournaments.${TournamentId}`]: Data } },
          },
        });
      } else if (ElimIds.has(User.UserId)) {
        Data.KnockedOut = true;
        Data.UserMatch = null;
        Ops.push({
          updateOne: {
            filter: { UserId: User.UserId },
            update: { $set: { [`Tournaments.${TournamentId}`]: Data } },
          },
        });
      }
    }

    if (Ops.length > 0) await BackboneUser.bulkWrite(Ops);
  }

  export async function QualifyPhase(User: IBackboneUser, Tournament: ITournament) {
    const Info = User.Tournaments.get(Tournament.TournamentId.toString());
    if (!Info || !Info.UserMatch) return;

    const PhaseId = Tournament.CurrentPhaseId || 1;
    const PhaseConfig = Tournament.Phases[PhaseId - 1];
    if (!PhaseConfig) return;

    const TypeNum = Number(PhaseConfig.PhaseType) || TournamentPhaseType.SingleEliminationBracket;
    const Type = TournamentPhaseType[TypeNum] as keyof typeof TournamentPhaseType;
    if (Type !== "RoundRobin" && Type !== "Arena") return;

    const DbMatch = await Match.findOne({ id: Info.UserMatch.id }).lean();
    if (!DbMatch) return;

    const RoundId = DbMatch.roundid;
    const GroupId = DbMatch.groupid;
    const TournamentId = Tournament.TournamentId.toString();

    const AllTeams = new Set<string>();
    for (const U of DbMatch.users) {
      if (U["@team-id"]) AllTeams.add(U["@team-id"]);
    }

    const TeamScores = new Map<string, { Score: number; HasWinner: boolean }>();
    for (const TeamId of AllTeams) {
      const TeamUsers = DbMatch.users.filter((U) => U["@team-id"] === TeamId);
      const HasWinner = TeamUsers.some((U) => U["@match-winner"] === "1");
      const Score = TeamUsers.reduce((Sum, U) => Sum + parseInt(U["@team-score"] || "0"), 0);
      TeamScores.set(TeamId, { Score, HasWinner });
    }

    const Sorted = Array.from(TeamScores.entries())
      .sort((A, B) => {
        if (A[1].HasWinner !== B[1].HasWinner) return A[1].HasWinner ? -1 : 1;
        return B[1].Score - A[1].Score;
      })
      .map(([TeamId]) => TeamId);

    const Winners: string[] = [];
    const Losers: string[] = [];

    if (Sorted.length > 0) {
      const TopScore = TeamScores.get(Sorted[0])!.Score;
      const TopWinner = TeamScores.get(Sorted[0])!.HasWinner;

      for (const TeamId of Sorted) {
        const Data = TeamScores.get(TeamId)!;
        if (Data.Score === TopScore && Data.HasWinner === TopWinner) {
          Winners.push(TeamId);
        } else {
          Losers.push(TeamId);
        }
      }
    }

    const WinIds = new Set<string>();
    const LoseIds = new Set<string>();

    for (const U of DbMatch.users) {
      if (Winners.includes(U["@team-id"])) {
        WinIds.add(U["@user-id"]);
        U["@match-points"] = "1";
        U["@match-winner"] = "1";
        if (!U["@team-score"] || U["@team-score"] === "0") U["@team-score"] = "1";
      } else if (Losers.includes(U["@team-id"])) {
        LoseIds.add(U["@user-id"]);
        U["@match-points"] = "0";
        U["@match-winner"] = "0";
        if (!U["@team-score"]) U["@team-score"] = "0";
      }
    }

    const WinMembers = new Set<string>();
    for (const Id of WinIds) {
      const Members = await GetAllPartyMembers(Id, TournamentId);
      for (const Mid of Members) WinMembers.add(Mid);
    }

    const LoseMembers = new Set<string>();
    for (const Id of LoseIds) {
      const Members = await GetAllPartyMembers(Id, TournamentId);
      for (const Mid of Members) LoseMembers.add(Mid);
    }

    await Match.updateOne({ id: DbMatch.id }, { $set: { status: TournamentMatchStatus.Closed, users: DbMatch.users } });

    const Updated = await Match.findOne({ id: DbMatch.id }).lean();
    if (!Updated) return;

    const MatchCopy = {
      id: Updated.id,
      secret: Updated.secret,
      deadline: Updated.deadline,
      matchid: Updated.matchid,
      phaseid: Updated.phaseid,
      groupid: Updated.groupid,
      roundid: Updated.roundid,
      playedgamecount: Updated.playedgamecount,
      status: Updated.status,
      tournamentid: Updated.tournamentid,
      users: Updated.users,
    };

    await UpdatePositions(TournamentId, PhaseId, GroupId);

    const TotalRounds = PhaseConfig.RoundCount || Tournament.RoundCount;
    const IsLast = RoundId === TotalRounds;

    let NextMatch = null;
    if (!IsLast) {
      NextMatch = await Match.findOne({
        tournamentid: TournamentId,
        phaseid: PhaseId,
        groupid: GroupId,
        roundid: RoundId + 1,
        "users.@user-id": { $in: Array.from(WinMembers) },
        status: { $nin: [TournamentMatchStatus.Closed, TournamentMatchStatus.GameFinished] },
      })
        .sort({ matchid: 1 })
        .lean();
    }

    const NextCopy = NextMatch ? { ...JSON.parse(JSON.stringify(NextMatch)), deadline: NextMatch.deadline } : null;

    const WinOps: any[] = [];
    for (const Id of WinMembers) {
      const UserDoc = await BackboneUser.findOne({ UserId: Id }).lean();
      if (!UserDoc) continue;

      const Data = (UserDoc.Tournaments as any).get
        ? (UserDoc.Tournaments as any).get(TournamentId)
        : UserDoc.Tournaments[TournamentId];
      if (!Data) continue;

      if (!Data.UserMatches) Data.UserMatches = [];
      const Has = Data.UserMatches.some((M: any) => M.id === MatchCopy.id);
      if (!Has) Data.UserMatches.push(MatchCopy);

      Data.UserMatch = NextCopy;
      WinOps.push({
        updateOne: {
          filter: { UserId: Id },
          update: { $set: { [`Tournaments.${TournamentId}`]: Data } },
        },
      });
    }

    const LoseOps: any[] = [];
    for (const Id of LoseMembers) {
      const UserDoc = await BackboneUser.findOne({ UserId: Id }).lean();
      if (!UserDoc) continue;

      const Data = (UserDoc.Tournaments as any).get
        ? (UserDoc.Tournaments as any).get(TournamentId)
        : UserDoc.Tournaments[TournamentId];
      if (!Data) continue;

      if (!Data.UserMatches) Data.UserMatches = [];
      const Has = Data.UserMatches.some((M: any) => M.id === MatchCopy.id);
      if (!Has) Data.UserMatches.push(MatchCopy);

      Data.UserMatch = null;
      LoseOps.push({
        updateOne: {
          filter: { UserId: Id },
          update: { $set: { [`Tournaments.${TournamentId}`]: Data } },
        },
      });
    }

    if (WinOps.length > 0) await BackboneUser.bulkWrite(WinOps);
    if (LoseOps.length > 0) await BackboneUser.bulkWrite(LoseOps);

    const IsFinalPhase = PhaseId === Tournament.Phases.length;

    if (IsFinalPhase && IsLast) {
      const AllDone =
        (await Match.countDocuments({
          tournamentid: TournamentId,
          phaseid: PhaseId,
          groupid: GroupId,
          roundid: RoundId,
          status: { $nin: [TournamentMatchStatus.Closed, TournamentMatchStatus.GameFinished] },
        })) === 0;

      if (AllDone) {
        await UpdatePositions(TournamentId, PhaseId, GroupId);

        const TopUsers = await BackboneUser.find({
          [`Tournaments.${TournamentId}.SignedUp`]: true,
          [`Tournaments.${TournamentId}.UserPosition`]: { $elemMatch: { phaseid: PhaseId, groupid: GroupId } },
        }).lean();

        const TeamMap = new Map<
          string,
          { Leader: string; Members: Set<string>; Rank: number; Points: number; Loses: number }
        >();

        for (const TopUser of TopUsers) {
          const Data = (TopUser.Tournaments as any).get
            ? (TopUser.Tournaments as any).get(TournamentId)
            : TopUser.Tournaments[TournamentId];
          const Pos = Data?.UserPosition?.find((P: any) => P.phaseid === PhaseId && P.groupid === GroupId);
          if (!Pos) continue;

          const Members = await GetAllPartyMembers(TopUser.UserId, TournamentId);
          const Leader = await GetLeaderId(TopUser.UserId, TournamentId);

          if (!TeamMap.has(Leader)) {
            TeamMap.set(Leader, {
              Leader,
              Members,
              Rank: Pos.rankposition || 9999,
              Points: Pos.totalpoints || 0,
              Loses: Pos.matchloses || 0,
            });
          }
        }

        const Sorted = Array.from(TeamMap.values()).sort((A, B) => {
          if (A.Rank !== B.Rank) return A.Rank - B.Rank;
          if (A.Points !== B.Points) return B.Points - A.Points;
          return A.Loses - B.Loses;
        });

        if (Sorted.length > 0) {
          const WinTeam = Sorted[0];
          const TourWinners = [];

          for (const Mid of WinTeam.Members) {
            const WinUser = await BackboneUser.findOne({ UserId: Mid }).lean();
            if (WinUser) TourWinners.push({ nick: WinUser.Username, userId: Mid });
          }

          if (TourWinners.length > 0) {
            await Tournament.updateOne(
              { TournamentId: Tournament.TournamentId },
              { $addToSet: { Winners: { $each: TourWinners } }, $set: { Status: TournamentStatus.Finished } }
            );
            const { GenerateHallOfFame } = await import("../../../Modules/HallOfFame");
            const winnerIds = TourWinners.map((w: any) => w.userId);
            await GenerateHallOfFame(Tournament, winnerIds);
          }
        }
      }
    }
  }
