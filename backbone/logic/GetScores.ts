import { AddGems } from "../../Handlers/Database";
import { BackboneUser } from "../../Models/BackboneUser";
import { Match } from "../../Models/Matches";
import { Tournament } from "../../Models/Tournament";
import {
  TournamentMatchStatus,
  TournamentStatus,
  TournamentPhaseType,
} from "../Config";
import { GetStarDatabase } from "../../Handlers/Server";

interface ScoreUser {
  "@user-id": string;
  "@status": string;
  "@checked-in": string;
  "@is-party-leader": string;
  "@nick": string;
}

interface Score {
  partyid: string;
  phaseid: number;
  groupid: number;
  checkin: boolean;
  position: number;
  totalpoints: number;
  matchwins: number;
  matchloses: number;
  gamewins: number;
  gameloses: number;
  stat1sum: number;
  stat2sum: number;
  loseweight: number;
  totalrounds: number;
  seed: number;
  users: ScoreUser[];
}

export async function GetScores(
  TournamentId: string,
  PhaseId: number,
  GroupId: number,
  MaxResults: number,
  Page: number,
) {
  const Skip = (Page - 1) * MaxResults;
  const ActualPhaseId = PhaseId || 1;
  const TournamentIdStr = TournamentId.toString();

  const [TournamentDoc, AllMatches, AllBackboneUsers] = await Promise.all([
    Tournament.findOne({ TournamentId: TournamentIdStr }).lean(),
    Match.find({
      tournamentid: TournamentIdStr,
      phaseid: ActualPhaseId,
      groupid: GroupId,
    }).lean(),
    BackboneUser.find({
      [`Tournaments.${TournamentIdStr}`]: { $exists: true },
    })
      .select("UserId Username Tournaments")
      .lean(),
  ]);

  if (!TournamentDoc)
    throw new Error(`invalid tournamentid: ${TournamentIdStr}`);

  const PhaseConfig = TournamentDoc.Phases[ActualPhaseId - 1];
  const IsFinalPhase = PhaseConfig?.IsPhase === false;
  const PhaseTypeNum =
    Number(PhaseConfig?.PhaseType) ||
    TournamentPhaseType.SingleEliminationBracket;

  const UserMap = new Map<string, any>();
  AllBackboneUsers.forEach((BBUser) => {
    const TournamentData = (BBUser.Tournaments as any).get
      ? (BBUser.Tournaments as any).get(TournamentIdStr)
      : (BBUser.Tournaments as any)[TournamentIdStr];
    if (TournamentData)
      UserMap.set(BBUser.UserId, {
        user: BBUser,
        tournamentData: TournamentData,
      });
  });

  const TeamScoreMap = new Map<string, any>();
  let LastRoundNumber = 0;
  AllMatches.forEach((m) => {
    if (m.roundid > LastRoundNumber) LastRoundNumber = m.roundid;
  });
  const LastRoundMatches = AllMatches.filter(
    (m) => m.roundid === LastRoundNumber,
  );
  const AllLastRoundClosed =
    LastRoundMatches.length > 0 &&
    LastRoundMatches.every(
      (m) =>
        m.status === TournamentMatchStatus.Closed ||
        m.status === TournamentMatchStatus.GameFinished,
    );

  AllMatches.forEach((MatchDoc) => {
    if (!MatchDoc.users?.length) return;

    const TeamMap = new Map<string, any[]>();
    MatchDoc.users.forEach((User) => {
      const TeamId = User["@team-id"];
      if (TeamId) {
        if (!TeamMap.has(TeamId)) TeamMap.set(TeamId, []);
        TeamMap.get(TeamId)!.push(User);
      }
    });

    TeamMap.forEach((TeamUsers, TeamId) => {
      if (!TeamUsers.length) return;

      let PartyLeaderUserId = TeamUsers[0]["@user-id"];
      let PartyId = TeamUsers[0]["@team-id"];

      TeamUsers.forEach((TeamUser) => {
        const UserData = UserMap.get(TeamUser["@user-id"]);
        if (UserData?.tournamentData?.PartyMembers?.length) {
          const Leader = UserData.tournamentData.PartyMembers.find(
            (pm: any) => pm.IsPartyLeader,
          );
          if (Leader) PartyLeaderUserId = Leader.UserId;
          PartyId = UserData.tournamentData.InviteId?.toString() || PartyId;
        }
      });

      if (!TeamScoreMap.has(PartyId)) {
        const SortedUsers = [...TeamUsers].sort((a, b) => {
          const aIsLeader = a["@user-id"] === PartyLeaderUserId;
          const bIsLeader = b["@user-id"] === PartyLeaderUserId;
          if (aIsLeader !== bIsLeader) return aIsLeader ? -1 : 1;
          return a["@user-id"].localeCompare(b["@user-id"]);
        });

        TeamScoreMap.set(PartyId, {
          partyid: PartyId,
          phaseid: ActualPhaseId,
          groupid: GroupId,
          checkin: false,
          position: 0,
          totalpoints: 0,
          matchwins: 0,
          matchloses: 0,
          gamewins: 0,
          gameloses: 0,
          stat1sum: 0,
          stat2sum: 0,
          loseweight: 0,
          totalrounds: 0,
          seed: 0,
          users: SortedUsers.map((u) => ({
            "@user-id": u["@user-id"],
            "@status": "1",
            "@checked-in": u["@checked-in"],
            "@is-party-leader": u["@user-id"] === PartyLeaderUserId ? "1" : "0",
            "@nick": u["@nick"],
          })),
        });
      }

      const ScoreEntry = TeamScoreMap.get(PartyId);
      const IsCheckedIn = TeamUsers.some((u) => u["@checked-in"] === "1");
      if (IsCheckedIn) ScoreEntry.checkin = true;

      if (
        MatchDoc.status === TournamentMatchStatus.Closed ||
        MatchDoc.status === TournamentMatchStatus.GameFinished
      ) {
        ScoreEntry.totalrounds += 1;
        let IsWinnerFinal = TeamUsers.some((u) => u["@match-winner"] === "1");

        if (!IsWinnerFinal) {
          TeamUsers.forEach((TeamUser) => {
            const UserData = UserMap.get(TeamUser["@user-id"]);
            if (UserData?.tournamentData?.UserMatches) {
              const UserMatch = UserData.tournamentData.UserMatches.find(
                (um: any) => um.id === MatchDoc.id,
              );
              if (
                UserMatch?.users?.some(
                  (u: any) =>
                    u["@user-id"] === TeamUser["@user-id"] &&
                    u["@match-winner"] === "1",
                )
              ) {
                IsWinnerFinal = true;
              }
            }
          });
        }

        const TeamScore = parseInt(TeamUsers[0]["@team-score"] || "0");
        const UserScore = parseInt(TeamUsers[0]["@user-score"] || "0");
        const ActualScore = Math.max(TeamScore, UserScore);
        const MatchPoints = parseInt(TeamUsers[0]["@match-points"] || "0");

        if (IsWinnerFinal) {
          ScoreEntry.matchwins += 1;
          ScoreEntry.totalpoints += MatchPoints > 0 ? MatchPoints : 1;
          ScoreEntry.gamewins += ActualScore > 0 ? ActualScore : 1;
        } else {
          ScoreEntry.matchloses += 1;
          let OpponentScore = 0;
          TeamMap.forEach((OtherTeamUsers, OtherTeamId) => {
            if (
              OtherTeamId !== TeamId &&
              OtherTeamUsers.some((u) => u["@match-winner"] === "1")
            ) {
              const OtherTeamScore = parseInt(
                OtherTeamUsers[0]["@team-score"] || "0",
              );
              const OtherUserScore = parseInt(
                OtherTeamUsers[0]["@user-score"] || "0",
              );
              OpponentScore = Math.max(OtherTeamScore, OtherUserScore);
            }
          });
          ScoreEntry.gameloses += OpponentScore > 0 ? OpponentScore : 1;
          ScoreEntry.loseweight += ScoreEntry.totalrounds;
        }
      }
    });
  });

  const Scores = Array.from(TeamScoreMap.values());
  Scores.sort((a, b) => {
    if (b.totalpoints !== a.totalpoints) return b.totalpoints - a.totalpoints;
    if (b.matchwins !== a.matchwins) return b.matchwins - a.matchwins;
    if (a.matchloses !== b.matchloses) return a.matchloses - b.matchloses;
    if (b.gamewins !== a.gamewins) return b.gamewins - a.gamewins;
    if (a.gameloses !== b.gameloses) return a.gameloses - b.gameloses;
    return a.loseweight - b.loseweight;
  });

  Scores.forEach((score, i) => (score.position = i + 1));

  const UpdatePromises: Promise<any>[] = [];
  const ProcessedParties = new Set<string>();

  const prizeSettings = TournamentDoc.Prizes;

  if (
    IsFinalPhase &&
    AllLastRoundClosed &&
    LastRoundMatches.length > 0 &&
    Scores[0]?.matchwins > 0 &&
    TournamentDoc.Winners.length === 0
  ) {
    const TopScore = Scores[0];
    const Winners = [];
    const AllWinnerUsers = new Set<string>();

    TopScore.users.forEach((User) => {
      const UserId = User["@user-id"];
      const UserData = UserMap.get(UserId);
      if (UserData) {
        Winners.push({ nick: User["@nick"], userId: UserId });
        AllWinnerUsers.add(UserId);

        if (TournamentDoc.PartySize > 1) {
          UserData.tournamentData?.PartyMembers?.forEach((Member: any) => {
            if (Member.UserId && Member.UserId !== UserId) {
              const MemberBBUser = AllBackboneUsers.find(
                (u) => u.UserId === Member.UserId,
              );
              if (MemberBBUser) {
                AllWinnerUsers.add(Member.UserId);
              }
            }
          });
        }
      }
    });

    if (Winners.length > 0) {
      const updatedTournament = await Tournament.findOneAndUpdate(
        { TournamentId: TournamentIdStr, Winners: { $size: 0 } },
        { $set: { Winners: Winners, Status: TournamentStatus.Finished, FinishedAt: new Date() } },
        { new: false },
      );

      if (!updatedTournament) return { pagination: { totalResultCount: Scores.length, maxResults: MaxResults, currentPage: Page }, scores: Scores.slice(Skip, Skip + MaxResults) };

      const allWinnerIdsArray = Array.from(AllWinnerUsers);
      
      const prizeAmount = TournamentDoc.EntryFee > 0 && prizeSettings 
        ? prizeSettings.find((p: any) => p.position === 1)?.amount || 0 
        : 0;

      await Promise.all(
        allWinnerIdsArray.map((WinnerUserId) =>
          BackboneUser.updateOne(
            { UserId: WinnerUserId },
            { $inc: { TournamentsWon: 1 } },
          ).catch(() => null)
        ),
      );

      if (prizeAmount > 0) {
        await Promise.all(
          allWinnerIdsArray.map((WinnerUserId) =>
            AddGems(prizeAmount, WinnerUserId).catch(() => null)
          ),
        );
      }

      if (TopScore.position === 1) {
        try {
          const FirstWinnerUserId = TopScore.users[0]["@user-id"];
          GetStarDatabase()
            .collection("Users")
            .updateOne({ id: parseInt(FirstWinnerUserId) }, { $inc: { age: 1 } })
            .catch(() => null);
        } catch {}
      }
    }
  }

  const IsTournamentEnded = TournamentDoc.Status === TournamentStatus.Finished;

  Scores.forEach((Score) => {
    if (ProcessedParties.has(Score.partyid)) return;
    ProcessedParties.add(Score.partyid);

    const PartyUserIds = new Set<string>();
    Score.users.forEach((User) => {
      const UserId = User["@user-id"];
      if (UserId) {
        PartyUserIds.add(UserId);
        const UserData = UserMap.get(UserId);
        if (UserData && TournamentDoc.PartySize > 1) {
          UserData.tournamentData?.PartyMembers?.forEach((Member: any) => {
            if (Member?.UserId) PartyUserIds.add(Member.UserId);
          });
        }
      }
    });

    PartyUserIds.forEach((UserId) => {
      UpdatePromises.push(
        BackboneUser.updateOne(
          {
            UserId: UserId,
            [`Tournaments.${TournamentIdStr}.UserPosition.phaseid`]:
              ActualPhaseId,
          },
          {
            $set: {
              [`Tournaments.${TournamentIdStr}.UserPosition.$[pos].rankposition`]:
                Score.position,
              [`Tournaments.${TournamentIdStr}.UserPosition.$[pos].sameposition`]: 0,
              [`Tournaments.${TournamentIdStr}.UserPosition.$[pos].totalpoints`]:
                Score.totalpoints,
              [`Tournaments.${TournamentIdStr}.UserPosition.$[pos].matchloses`]:
                Score.matchloses,
              [`Tournaments.${TournamentIdStr}.UserPosition.$[pos].totalrounds`]:
                Score.totalrounds,
            },
          },
          {
            arrayFilters: [
              { "pos.phaseid": ActualPhaseId, "pos.groupid": GroupId },
            ],
          },
        ).catch(() => null),
      );
    });
  });

  if (IsTournamentEnded && TournamentDoc.Winners.length === 0) {
    const ProcessedFinalPlaces = new Set<string>();

    Scores.forEach((Score) => {
      Score.users.forEach((User) => {
        const UserId = User["@user-id"];
        const UserData = UserMap.get(UserId);
        if (UserData) {
          const TournamentData = UserData.tournamentData;
          const IsLeader =
            TournamentDoc.PartySize === 1 ||
            TournamentData?.PartyMembers?.some(
              (m: any) => m.IsPartyLeader && m.UserId === UserId,
            );

          if (IsLeader && !ProcessedFinalPlaces.has(Score.partyid)) {
            ProcessedFinalPlaces.add(Score.partyid);

            const partyUserIds = new Set<string>();
            partyUserIds.add(UserId);

            const FinalPlaceField = `Tournaments.${TournamentIdStr}.FinalPlace`;

            UpdatePromises.push(
              BackboneUser.updateOne(
                { UserId: UserId },
                { $set: { [FinalPlaceField]: Score.position } },
              ).catch(() => null),
            );

            if (TournamentDoc.PartySize > 1 && TournamentData?.PartyMembers) {
              TournamentData.PartyMembers.forEach((Member: any) => {
                if (Member?.UserId && Member.UserId !== UserId) {
                  UpdatePromises.push(
                    BackboneUser.updateOne(
                      { UserId: Member.UserId },
                      { $set: { [FinalPlaceField]: Score.position } },
                    ).catch(() => null),
                  );
                  partyUserIds.add(Member.UserId);
                }
              });
            }
          }
        }
      });
    });
  }

  if (UpdatePromises.length > 0) {
    try {
      await Promise.all(UpdatePromises);
    } catch {}
  }

  const TotalCount = Scores.length;
  const PaginatedScores = Scores.slice(Skip, Skip + MaxResults);

  return {
    pagination: {
      totalResultCount: TotalCount,
      maxResults: MaxResults,
      currentPage: Page,
    },
    scores: PaginatedScores,
  };
}