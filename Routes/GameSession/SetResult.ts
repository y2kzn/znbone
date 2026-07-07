import { Router } from "express";
import { ForService, ServiceType } from "../../Modules/Service";
import { BackboneUser } from "../../Models/BackboneUser";
import { XMLParser } from "fast-xml-parser";
import { Tournament } from "../../Models/Tournament";
import { TournamentMatchStatus } from "../../Backbone/Config";
import { Match } from "../../Models/Matches";
import { Qualify } from "../../Backbone/Logic/GetMatches";

const App = Router();
App.use(ForService(ServiceType.Public));

App.post("/gameSessionSetResult", async (Req, Res) => {
  try {
    const { gameSessionId, gameSessionData, accessToken } = Req.body;

    if (!gameSessionId || !accessToken || !gameSessionData) {
      return Res.status(400).json({});
    }

    let DecodedXML: string;
    try {
      DecodedXML = Buffer.from(gameSessionData, "base64").toString("utf-8");
      if (!DecodedXML.trim().startsWith("<")) {
        DecodedXML = decodeURIComponent(gameSessionData);
      }
    } catch {
      return Res.status(400).json({});
    }

    const Parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      parseAttributeValue: true,
    });

    const ParsedXML = Parser.parse(DecodedXML);

    if (!ParsedXML?.data?.["game-session"]) {
      return Res.status(400).json({});
    }

    const ResultData = ParsedXML.data["game-session"];
    let Users = ResultData.user || [];
    if (!Array.isArray(Users)) {
      Users = [Users];
    }

    const MatchId = ResultData["tournament-match-id"];
    const FoundMatch = await Match.findOne({ id: MatchId });

    if (!FoundMatch) {
      return Res.status(404).json({});
    }

    if (FoundMatch.status !== TournamentMatchStatus.GameInProgress) {
      return Res.status(200).json({});
    }

    const DatabaseTournament = await Tournament.findOne({
      TournamentId: FoundMatch.tournamentid,
    });

    if (!DatabaseTournament) {
      return Res.status(404).json({});
    }

    type IUserResult = {
      UserId: string;
      TeamId: string;
      Place: string;
    };
    const UserResults: IUserResult[] = [];

    for (let I = 0; I < Users.length; I++) {
      const User = Users[I];
      const UserId = User["user-id"].toString();
      const Place = User.place ? User.place.toString() : (I + 1).toString();
      const TeamId = User["team-id"].toString();
      UserResults.push({
        UserId: UserId,
        TeamId: TeamId,
        Place: Place,
      });
    }

    const InvalidUsers = UserResults.filter(
      (Result) => !FoundMatch.users.some((MatchUser) => MatchUser["@user-id"].toString() === Result.UserId)
    );

    if (InvalidUsers.length > 0) {
      return Res.status(400).json({});
    }

    const TeamPlacements = new Map<string, number>();
    for (const Result of UserResults) {
      const CurrentPlace = TeamPlacements.get(Result.TeamId);
      const Place = parseInt(Result.Place);
      if (!CurrentPlace || Place < CurrentPlace) {
        TeamPlacements.set(Result.TeamId, Place);
      }
    }

    const SortedTeams = Array.from(TeamPlacements.entries())
      .sort((A, B) => A[1] - B[1])
      .map(([TeamId, Place]) => ({ TeamId, Place }));

    const NumTeams = SortedTeams.length;

    const NextRoundMatches = await Match.find({
      tournamentid: FoundMatch.tournamentid,
      phaseid: FoundMatch.phaseid,
      roundid: FoundMatch.roundid + 1,
      groupid: FoundMatch.groupid,
    });

    const IsLastRound = NextRoundMatches.length === 0;
    const TeamsPerMatch = DatabaseTournament.MaxPlayersPerMatch;
    const QualifyingTeamCount = IsLastRound ? 1 : Math.max(1, Math.floor(TeamsPerMatch / 2));
    const WinningTeamIds = new Set(SortedTeams.slice(0, QualifyingTeamCount).map((T) => T.TeamId));

    const TeamPoints = new Map<string, number>();
    for (let I = 0; I < SortedTeams.length; I++) {
      const Team = SortedTeams[I];
      const Points = NumTeams - I;
      TeamPoints.set(Team.TeamId, Points);
    }

    for (const MatchUser of FoundMatch.users) {
      const TeamId = MatchUser["@team-id"];
      const IsWinner = WinningTeamIds.has(TeamId);
      const TeamPoint = TeamPoints.get(TeamId) || 0;

      MatchUser["@match-winner"] = IsWinner ? "1" : "0";
      MatchUser["@match-points"] = IsWinner ? "1" : "0";
      MatchUser["@team-score"] = TeamPoint.toString();
    }

    const UpdateResult = await Match.updateOne(
      { id: MatchId, status: TournamentMatchStatus.GameInProgress },
      { $set: { status: TournamentMatchStatus.GameFinished, users: FoundMatch.users } }
    );

    if (UpdateResult.modifiedCount === 0) {
      return Res.status(200).json({});
    }

    const AllMatchUserIds = FoundMatch.users.map((U) => U["@user-id"]);
    const AllMatchUsers = await BackboneUser.find({ UserId: { $in: AllMatchUserIds } });

    const WinningUserIds = FoundMatch.users.filter((U) => WinningTeamIds.has(U["@team-id"])).map((U) => U["@user-id"]);

    const WinningUsers = AllMatchUsers.filter((U) => WinningUserIds.includes(U.UserId));

    if (WinningUsers.length > 0) {
      for (const Winner of WinningUsers) {
        await Qualify(Winner, DatabaseTournament);
      }
    }

    return Res.status(200).json({});
  } catch (Err) {
    console.log(Err);
    return Res.status(500).json({});
  }
});

export default {
  App,
  DefaultAPI: "/api/v1",
};
