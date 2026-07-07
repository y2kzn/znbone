import { Router } from "express";
import { ForService, ServiceType } from "../../Modules/Service";
import { XMLParser } from "fast-xml-parser";
import { Match } from "../../Models/Matches";
import { LPUser } from "../../Models/LPUser";
import { TournamentMatchStatus } from "../../Backbone/Config";
import { dbg } from "../../Modules/Logger";

const App = Router();
App.use(ForService(ServiceType.Public));

App.post("/gameSessionCreate", async (req, res) => {
  try {
    const { gameSessionData } = req.body;
    const AccessToken = req.body?.accessToken;

    if (!AccessToken || !gameSessionData) {
      dbg("gameSessionCreate: missing accessToken or gameSessionData");
      return res.status(400).json({});
    }

    let DecodedXML: string;
    try {
      DecodedXML = Buffer.from(gameSessionData, "base64").toString("utf-8");
      if (!DecodedXML.trim().startsWith("<")) {
        DecodedXML = decodeURIComponent(gameSessionData);
      }
    } catch {
      return res.status(400).json({});
    }

    const Parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      parseAttributeValue: true,
    });

    const ParsedXML = Parser.parse(DecodedXML);

    if (!ParsedXML?.data?.["game-session"]) {
      dbg("gameSessionCreate: invalid xml payload");
      return res.status(400).json({});
    }

    const SessionData = ParsedXML.data["game-session"];
    const MatchId = SessionData["tournament-match-id"];
    const DatabaseMatch = await Match.findOne({ id: MatchId });

    if (!DatabaseMatch) {
      dbg(`gameSessionCreate: match not found id=${MatchId}`);
      return res.status(404).json({});
    }

    const LoginProviderUser = await LPUser.findOne({ AccessToken: AccessToken }).lean();
    if (!LoginProviderUser) {
      dbg("gameSessionCreate: invalid accessToken");
      return res.status(200).json({});
    }

    const MatchUser = DatabaseMatch.users.find(
      (u) => u["@user-id"] === LoginProviderUser.UserId
    );

    if (!MatchUser) {
      dbg(`gameSessionCreate: user not in match id=${MatchId}`);
      return res.status(200).json({});
    }

    if (MatchUser["@checked-in"] !== "1") {
      dbg(`gameSessionCreate: user not checked-in id=${MatchId}`);
      return res.status(200).json({});
    }

    if (DatabaseMatch.status !== TournamentMatchStatus.GameReady) {
      dbg(
        `gameSessionCreate: match not ready id=${MatchId} status=${DatabaseMatch.status}`
      );
      return res.status(200).json({});
    }

    const CheckedInUsers = DatabaseMatch.users.filter((u) => u["@checked-in"] === "1");
    
    const teamIds = CheckedInUsers.map(u => u["@team-id"]);
    const uniqueTeamIds = [...new Set(teamIds)];
    
    const allTeamsHavePlayers = uniqueTeamIds.every(teamId => {
      const teamCount = CheckedInUsers.filter(u => u["@team-id"] === teamId).length;
      return teamCount > 0;
    });

    if (allTeamsHavePlayers && uniqueTeamIds.length >= 2) {
      dbg(
        `gameSessionCreate: starting match id=${MatchId} teams=${uniqueTeamIds.length} checkedIn=${CheckedInUsers.length}/${DatabaseMatch.users.length}`
      );
      DatabaseMatch.status = TournamentMatchStatus.GameInProgress;
      await DatabaseMatch.save();
    } else {
      dbg(
        `gameSessionCreate: not enough checkins id=${MatchId} teams=${uniqueTeamIds.length} checkedIn=${CheckedInUsers.length}/${DatabaseMatch.users.length}`
      );
    }

    const SessionId = parseInt(MatchId).toString();
    const Response = { id: SessionId };

    return res.status(200).json(Response);
  } catch {
    return res.status(500).json({});
  }
});

export default {
  App,
  DefaultAPI: "/api/v1",
};
