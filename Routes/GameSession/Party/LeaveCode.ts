import { Router } from "express";
import {
  TournamentAcceptPartyStatus,
  TournamentCreatePartyCodeStatus,
} from "../../Backbone/Config";
import j from "joi";
import { LPUser } from "../../Models/LPUser";
import { BackboneUser } from "../../Models/BackboneUser";
import { Tournament } from "../../Models/Tournament";
import { AppId } from "../../Modules/Constants";

const App = Router();

const LeaveCodeSchema = j
  .object({
    backbone_app_id: j.string().required().valid(AppId),
    "x-unity-version": j.string().required(),
    access_token: j.string().required(),
  })
  .unknown(true);

const LeaveBodySchema = j
  .object({
    tournamentId: j.number().required(),
    removeUserId: j.string().required(),
    accessToken: j.string().required(),
  })
  .unknown(true);

App.post(
  "/tournamentPartyRemoveUser",
  async (req, res) => {
    try {
      const { accessToken, tournamentId, removeUserId } = req.body;
      const tournamentIdStr = tournamentId.toString();

      const [LoginProviderUser, DatabaseTournament] = await Promise.all([
        LPUser.findOne({ AccessToken: accessToken }),
        Tournament.findOne({ TournamentId: tournamentId }),
      ]);

      if (!LoginProviderUser || !DatabaseTournament) {
        return res.json({
          status: TournamentAcceptPartyStatus.InviteNotExits,
          tournamentId,
        });
      }

      if (new Date() >= new Date(DatabaseTournament.StartTime)) {
        return res.json({
          status: TournamentCreatePartyCodeStatus.NotAttempted,
          tournamentId,
        });
      }

      const DatabaseUser = await BackboneUser.findOne({
        UserId: LoginProviderUser.UserId,
      });
      const TournamentInfo = DatabaseUser?.Tournaments.get(tournamentIdStr);

      if (!DatabaseUser || !TournamentInfo?.PartyMembers) {
        return res.json({
          status: TournamentCreatePartyCodeStatus.Unknown,
          tournamentId,
        });
      }

      const isLeader =
        TournamentInfo.PartyMembers.find((m) => m.IsPartyLeader)?.UserId ===
        DatabaseUser.UserId;
      const isSelfRemoval = DatabaseUser.UserId === removeUserId;

      if (!isSelfRemoval && !isLeader) {
        return res.json({
          status: TournamentCreatePartyCodeStatus.Unknown,
          tournamentId,
        });
      }

      const memberUserIds = TournamentInfo.PartyMembers.map((m) => m.UserId);
      const membersToUpdate = await BackboneUser.find({
        UserId: { $in: memberUserIds },
        [`Tournaments.${tournamentId}`]: { $exists: true },
      });

      const updatePromises = membersToUpdate.map(async (member) => {
        const memberTournamentInfo = member.Tournaments.get(tournamentIdStr);
        if (!memberTournamentInfo) return;

        if (member.UserId === removeUserId) {
          memberTournamentInfo.PartyCode = "";
          memberTournamentInfo.PartyMembers = [
            {
              UserId: member.UserId,
              Username: member.Username,
              Status: 1,
              IsPartyLeader: true,
              IsKicked: false,
            },
          ];
        } else {
          memberTournamentInfo.PartyMembers =
            memberTournamentInfo.PartyMembers.filter(
              (m) => m.UserId !== removeUserId,
            );

          if (
            isSelfRemoval &&
            isLeader &&
            memberTournamentInfo.PartyMembers.length > 0
          ) {
            memberTournamentInfo.PartyMembers[0].IsPartyLeader = true;
          }
        }

        return member.save();
      });

      await Promise.all(updatePromises.filter((p) => p));

      res.json({
        status: TournamentCreatePartyCodeStatus.Ok,
        tournamentId,
      });
    } catch {
      res.json({
        status: TournamentCreatePartyCodeStatus.Unknown,
        tournamentId: req.body?.tournamentId ?? "",
      });
    }
  },
);

export default {
  App,
  DefaultAPI: "/api/v1",
};

