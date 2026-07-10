import { Router } from "express";
import {
  TournamentAcceptPartyStatus,
  TournamentUserStatus,
} from "../../Backbone/Config";
import j from "joi";
import { LPUser } from "../../Models/LPUser";
import { BackboneUser } from "../../Models/BackboneUser";
import { Tournament } from "../../Models/Tournament";
import { AppId } from "../../Modules/Constants";

const App = Router();

const JoinCodeSchema = j
  .object({
    backbone_app_id: j.string().required().valid(AppId),
    "x-unity-version": j.string().required(),
    access_token: j.string().required(),
  })
  .unknown(true);

const JoinBodySchema = j
  .object({
    tournamentId: j.number().required(),
    partyCode: j.string().required(),
    accessToken: j.string().required(),
  })
  .unknown(true);

App.post(
  "/tournamentPartyJoinByCode",
  async (req, res) => {
    try {
      const TournamentId = req.body.tournamentId.toString();
      const PartyCode = req.body.partyCode.toUpperCase();

      const [DatabaseTournament, LoginProviderUser] = await Promise.all([
        Tournament.findOne({ TournamentId }),
        LPUser.findOne({ AccessToken: req.body.accessToken }),
      ]);

      if (!DatabaseTournament || !LoginProviderUser) {
        return res.status(200).json({
          status: TournamentAcceptPartyStatus.UserIsNotSignedUp,
          tournamentId: TournamentId,
        });
      }

      const [DatabaseUser, PartyLeader] = await Promise.all([
        BackboneUser.findOne({ UserId: LoginProviderUser.UserId }),
        BackboneUser.findOne({
          UserId: { $ne: LoginProviderUser.UserId },
          [`Tournaments.${TournamentId}.PartyCode`]: PartyCode,
          [`Tournaments.${TournamentId}.SignedUp`]: true,
        }),
      ]);

      if (!DatabaseUser?.Tournaments) {
        return res.status(200).json({
          status: TournamentAcceptPartyStatus.UserIsNotSignedUp,
          tournamentId: TournamentId,
        });
      }

      const UserTournamentData = DatabaseUser.Tournaments.get(TournamentId);

      if (!UserTournamentData?.SignedUp) {
        return res.status(200).json({
          status: TournamentAcceptPartyStatus.UserIsNotSignedUp,
          tournamentId: TournamentId,
        });
      }

      if (UserTournamentData.PartyCode) {
        return res.status(200).json({
          status: TournamentAcceptPartyStatus.NotAttempted,
          tournamentId: TournamentId,
        });
      }

      const PartyLeaderTournamentData =
        PartyLeader?.Tournaments.get(TournamentId);

      if (!PartyLeaderTournamentData) {
        return res.status(200).json({
          status: TournamentAcceptPartyStatus.InviteNotExits,
          tournamentId: TournamentId,
        });
      }

      const HasPartyLeader = PartyLeaderTournamentData.PartyMembers.some(
        (member) => member.IsPartyLeader,
      );
      if (!HasPartyLeader) {
        return res.status(200).json({
          status: TournamentAcceptPartyStatus.PartyNoLongerExits,
          tournamentId: TournamentId,
        });
      }

      const IsAlreadyInParty = PartyLeaderTournamentData.PartyMembers.some(
        (member) => member.UserId.toString() === DatabaseUser.UserId.toString(),
      );

      if (IsAlreadyInParty) {
        return res.status(200).json({
          status: TournamentAcceptPartyStatus.Unknown,
          tournamentId: TournamentId,
        });
      }

      if (
        PartyLeaderTournamentData.PartyMembers.length >=
        DatabaseTournament.PartySize
      ) {
        return res.status(200).json({
          status: TournamentAcceptPartyStatus.PartyIsFull,
          tournamentId: TournamentId,
        });
      }

      const NewMember = {
        UserId: DatabaseUser.UserId,
        Username: DatabaseUser.Username,
        Status: TournamentUserStatus.Confirmed,
        IsPartyLeader: false,
        IsKicked: false,
      };

      PartyLeaderTournamentData.PartyMembers.push(NewMember);
      UserTournamentData.PartyCode = PartyCode;
      UserTournamentData.PartyMembers = PartyLeaderTournamentData.PartyMembers;

      const UpdatedPartyMembers = PartyLeaderTournamentData.PartyMembers;
      const AllPartyMemberIds = UpdatedPartyMembers.map((m) => m.UserId);

      const OtherMembersUpdate = BackboneUser.updateMany(
        {
          UserId: {
            $in: AllPartyMemberIds,
            $nin: [PartyLeader.UserId, DatabaseUser.UserId],
          },
          [`Tournaments.${TournamentId}`]: { $exists: true },
        },
        {
          $set: {
            [`Tournaments.${TournamentId}.PartyMembers`]: UpdatedPartyMembers,
          },
        },
      );

      await Promise.all([
        PartyLeader.save(),
        DatabaseUser.save(),
        OtherMembersUpdate,
      ]);

      res.status(200).json({
        status: TournamentAcceptPartyStatus.Ok,
        tournamentId: TournamentId,
      });
    } catch (Error) {
      res.status(200).json({
        status: TournamentAcceptPartyStatus.Unknown,
        tournamentId: req.body.tournamentId?.toString() || "",
      });
    }
  },
);

export default {
  App,
  DefaultAPI: "/api/v1",
};

