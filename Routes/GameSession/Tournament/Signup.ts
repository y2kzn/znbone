import { Router } from "express";
import j from "joi";
import { GenerateInviteId } from "../../Modules/Extensions";
import { Tournament } from "../../Models/Tournament";
import { LPUser } from "../../Models/LPUser";
import { BackboneUser } from "../../Models/BackboneUser";
import { RemoveGems, CheckGems } from "../../Handlers/Database";
import { AppId } from "../../Modules/Constants";
import { TournamentUserStatus, TournamentSignUpStatus, TournamentStatus } from "../../Backbone/Config";

const App = Router();

const TournamentSignupSchema = j.object({
  backbone_app_id: j.string().required().valid(AppId),
  "x-unity-version": j.string().required(),
  access_token: j.string().required(),
}).unknown(true);

const SignupBodySchema = j.object({
  tournamentId: j.number().required(),
  accessToken: j.string().required(),
}).unknown(true);

App.post("/tournamentSignup",
  async (req, res) => {
    const TournamentId = req.body.tournamentId.toString();
    const AccessToken = req.body.accessToken.toString();
    
    const LoginProviderUser = await LPUser.findOne({ AccessToken }).lean();
    if (!LoginProviderUser) return res.status(401).json({ message: "Unauthorized" });

    const [CheckTournament, DatabaseUser] = await Promise.all([
      Tournament.findOne({ TournamentId }).lean(),
      BackboneUser.findOne({ UserId: LoginProviderUser.UserId })
    ]);

    if (!CheckTournament) return res.status(200).json({
      status: TournamentSignUpStatus.InvalidTournamentIdOrData,
      inviteId: null,
      inviteStatus: TournamentUserStatus.Invited,
      tournamentId: TournamentId,
    });

    if (!DatabaseUser) return res.status(401).json({ message: "Unauthorized" });

    const ExistingTournamentInfo = DatabaseUser.Tournaments.get(TournamentId);
    if (ExistingTournamentInfo?.SignedUp) return res.status(200).json({
      status: TournamentSignUpStatus.Ok,
      inviteId: ExistingTournamentInfo.InviteId,
      inviteStatus: TournamentUserStatus.Confirmed,
      tournamentId: TournamentId,
    });

    const Now = new Date();
    if (Now < CheckTournament.SignupStart || Now > CheckTournament.StartTime) return res.status(200).json({
      status: TournamentSignUpStatus.NotOpenedForSignUp,
      inviteId: null,
      inviteStatus: TournamentUserStatus.Invited,
      tournamentId: TournamentId,
    });

    if (CheckTournament.CurrentInvites >= CheckTournament.MaxInvites) return res.status(200).json({
      status: TournamentSignUpStatus.TournamentIsFull,
      inviteId: null,
      inviteStatus: TournamentUserStatus.Invited,
      tournamentId: TournamentId,
    });

    let gemsCheckPromise;
    if (CheckTournament.EntryFee > 0) {
      gemsCheckPromise = CheckGems(LoginProviderUser.UserId, CheckTournament.EntryFee);
    }

    const hasSufficientGems = gemsCheckPromise ? await gemsCheckPromise : true;
    if (!hasSufficientGems) return res.status(200).json({
      status: TournamentSignUpStatus.NotEnoughtForEntry,
      inviteId: null,
      inviteStatus: TournamentUserStatus.Invited,
      tournamentId: TournamentId,
    });

    const DatabaseTournament = await Tournament.findOneAndUpdate(
      { TournamentId, CurrentInvites: { $lt: CheckTournament.MaxInvites } },
      { $inc: { CurrentInvites: 1 } },
      { new: true }
    );

    if (!DatabaseTournament) return res.status(200).json({
      status: TournamentSignUpStatus.TournamentIsFull,
      inviteId: null,
      inviteStatus: TournamentUserStatus.Invited,
      tournamentId: TournamentId,
    });

    const InviteId = GenerateInviteId();
    DatabaseUser.Tournaments.set(TournamentId, {
      SignedUp: true,
      InviteId: InviteId.toString(),
      Status: TournamentUserStatus.Confirmed,
      AcceptedAt: Now,
      PartyMembers: [{
        UserId: DatabaseUser.UserId,
        Username: DatabaseUser.Username,
        Status: 1,
        IsPartyLeader: true,
        IsKicked: false,
      }],
      PartyCode: "",
      UserMatch: null,
      UserMatches: [],
      UserPosition: [{
        groupid: 0,
        matchloses: 0,
        phaseid: DatabaseTournament.CurrentPhaseId,
        rankposition: 0,
        sameposition: 0,
        totalpoints: 0,
        totalrounds: 0,
      }],
      FinalPlace: 0,
    });

    const UpdatePromises = [];

    if (DatabaseTournament.EntryFee > 0) {
      const removeGemsPromise = RemoveGems(DatabaseTournament.EntryFee, LoginProviderUser.UserId);
      const userSavePromise = DatabaseUser.save();
      
      const [gemsRemoved] = await Promise.all([removeGemsPromise, userSavePromise]);
      
      if (!gemsRemoved) {
        UpdatePromises.push(
          Tournament.updateOne({ TournamentId }, { $inc: { CurrentInvites: -1 } })
        );
        UpdatePromises.push(
          BackboneUser.updateOne(
            { UserId: DatabaseUser.UserId },
            { $unset: { [`Tournaments.${TournamentId}`]: "" } }
          )
        );
        
        await Promise.all(UpdatePromises);
        return res.status(200).json({
          status: TournamentSignUpStatus.NotEnoughtForEntry,
          inviteId: null,
          inviteStatus: TournamentUserStatus.Invited,
          tournamentId: TournamentId,
        });
      }
    } else {
      UpdatePromises.push(DatabaseUser.save());
      await Promise.all(UpdatePromises);
    }

    return res.status(200).json({
      status: TournamentSignUpStatus.Ok,
      inviteId: InviteId.toString(),
      inviteStatus: TournamentUserStatus.Confirmed,
      tournamentId: TournamentId,
    });
  }
);

export default { App, DefaultAPI: "/api/v1" };
