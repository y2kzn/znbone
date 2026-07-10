import { Router } from "express";
import j from "joi";
import { LPUser } from "../../Models/LPUser";
import { BackboneUser } from "../../Models/BackboneUser";
import { Tournament } from "../../Models/Tournament";
import { AppId } from "../../Modules/Constants";

const App = Router();

const CreateCodeSchema = j
  .object({
    backbone_app_id: j.string().required().valid(AppId),
    "x-unity-version": j.string().required(),
    access_token: j.string().required(),
  })
  .unknown(true);

const CreateBodySchema = j
  .object({
    tournamentId: j.number().required(),
    recreate: j.number().required().valid(0, 1),
    accessToken: j.string().required(),
  })
  .unknown(true);

const GeneratePartyCode = (): string => {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
};

const TournamentCreatePartyCodeStatus = {
  Unknown: -1,
  NotAttempted: 0,
  Ok: 1,
  InvalidTournamentId: 2,
};

App.post(
  "/tournamentPartyCreateCode",
  async (req, res) => {
    try {
      const TournamentId = req.body.tournamentId.toString();
      const LoginProviderUser = await LPUser.findOne({
        AccessToken: req.body.accessToken,
      });

      if (!LoginProviderUser) {
        return res.status(200).json({
          status: TournamentCreatePartyCodeStatus.InvalidTournamentId,
          partyCode: "",
          tournamentId: TournamentId,
        });
      }

      const [DatabaseTournament, DatabaseUser] = await Promise.all([
        Tournament.findOne({ TournamentId }),
        BackboneUser.findOne({ UserId: LoginProviderUser.UserId }),
      ]);

      if (!DatabaseTournament || !DatabaseUser?.Tournaments) {
        return res.status(200).json({
          status: TournamentCreatePartyCodeStatus.InvalidTournamentId,
          partyCode: "",
          tournamentId: TournamentId,
        });
      }

      let TournamentData = DatabaseUser.Tournaments.get(TournamentId);
      if (!TournamentData) {
        DatabaseUser.Tournaments.set(TournamentId, {
          SignedUp: false,
          InviteId: "",
          Status: 0,
          AcceptedAt: new Date(),
          PartyCode: "",
          PartyMembers: [],
          UserMatch: null,
          UserMatches: [],
          UserPosition: [
            {
              groupid: 0,
              matchloses: 0,
              phaseid: DatabaseTournament.CurrentPhaseId,
              rankposition: 0,
              sameposition: 0,
              totalpoints: 0,
              totalrounds: 0,
            },
          ],
          FinalPlace: 0,
        });
        TournamentData = DatabaseUser.Tournaments.get(TournamentId);
      }

      if (!TournamentData!.PartyCode || req.body.recreate === 1) {
        TournamentData!.PartyCode = await GeneratePartyCode();
      }

      if (
        !TournamentData!.PartyMembers.some(
          (member) => member.UserId === DatabaseUser.UserId,
        )
      ) {
        TournamentData!.PartyMembers.push({
          UserId: DatabaseUser.UserId,
          Username: DatabaseUser.Username,
          Status: 1,
          IsPartyLeader: true,
          IsKicked: false,
        });
      }

      await DatabaseUser.save();

      res.status(200).json({
        status: TournamentCreatePartyCodeStatus.Ok,
        partyCode: TournamentData!.PartyCode,
        tournamentId: TournamentId,
      });
    } catch (Error) {
      res.status(200).json({
        status: TournamentCreatePartyCodeStatus.Unknown,
        partyCode: "",
        tournamentId: req.body.tournamentId?.toString() || "",
      });
    }
  },
);

export default {
  App,
  DefaultAPI: "/api/v1",
};

