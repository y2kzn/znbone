import { Router } from "express";
import j from "joi";
import { LPUser } from "../../Models/LPUser";
import { BackboneUser } from "../../Models/BackboneUser";
import { msg } from "../../Modules/Logger";
import { AppId } from "../../Modules/Constants";
import { GetStarDatabase } from "../../Handlers/Server";
import { SyncNicknameInTournamentData } from "../../Modules/NicknameSync";

const App = Router();

const ChangeNickSchema = j
  .object({
    backbone_app_id: j.string().required().valid(AppId),
    "x-unity-version": j.string().required(),
  })
  .unknown(true);

const ChangeNickBodySchema = j
  .object({
    accessToken: j.string().required(),
    nickName: j.string().required(),
  })
  .unknown(true);

App.post(
  "/userChangeNick",
  async (req, res) => {
  const nickNameStr = req.body?.nickName?.toString?.();
  msg(
    "[ChangeNick] request received " +
      JSON.stringify({
        nickNameLength: nickNameStr ? nickNameStr.length : null,
        hasNickName: !!req.body?.nickName,
        hasAccessToken: !!req.body?.accessToken,
        unityVersion: req.headers?.["x-unity-version"] ?? null,
      })
  );
  const LoginProviderUser = await LPUser.findOne({
    AccessToken: req.body.accessToken,
  });

  if (!LoginProviderUser) {
    msg("[ChangeNick] no LPUser found for provided accessToken");
    return res.status(401).json({});
  }

  const DatabaseUser = await BackboneUser.findOne({ UserId: LoginProviderUser.UserId });
  if (!DatabaseUser) {
    msg("[ChangeNick] no BackboneUser found for UserId: " + LoginProviderUser.UserId);
    return res.status(401).json({});
  }

  const StarDb = GetStarDatabase();
  const Users = StarDb ? StarDb.collection("Users") : null;

  if (req.body.nickName.toString().length > 32 && req.body.nickName.toString().includes("<size>")) {
    msg("possible username spoof detected. username: " + req.body.nickName.toString());
    return res.status(401).json({});
  }

  let StarUser: any = null;
  let lookupKey: any = {};
  if (Users) {
    const numericUserId = Number(LoginProviderUser.UserId || DatabaseUser.UserId);
    if (Number.isFinite(numericUserId)) {
      lookupKey = { id: numericUserId };
      StarUser = await Users.findOne(lookupKey);
    }
    if (!StarUser && LoginProviderUser.DeviceIdentifier) {
      lookupKey = { deviceId: LoginProviderUser.DeviceIdentifier };
      StarUser = await Users.findOne(lookupKey);
    }
  }
  msg(
    "[ChangeNick] StarUser lookup " +
      JSON.stringify({
        ...lookupKey,
        found: !!StarUser,
      })
  );
  if (!StarUser) {
    msg("[ChangeNick] StarUser not found; skipping username validation");
  }

  msg(
    "[ChangeNick] username check " +
      JSON.stringify({
        bodyUsername: req.body?.username ?? null,
        starUsername: StarUser?.username ?? null,
      })
  );

  if (StarUser && req.body?.username && req.body.username !== StarUser.username) {
    msg("possible username spoof detected. username: " + req.body.nickName.toString());
    return res.status(401).json({});
  }

  if (LoginProviderUser.Nickname != req.body.nickName.toString()) {
    const newNickname = req.body.nickName.toString();
    const userId = DatabaseUser.UserId;
    msg(
      "[ChangeNick] nickname update start " +
        JSON.stringify({
          userId,
          oldNickname: LoginProviderUser.Nickname,
          newNickname,
          tournaments: DatabaseUser.Tournaments?.size ?? 0,
        })
    );

    LoginProviderUser.Nickname = newNickname;
    DatabaseUser.Username = newNickname;

    let updatedMembers = 0;
    let updatedUserMatches = 0;
    DatabaseUser.Tournaments.forEach((tournamentData) => {
      tournamentData.PartyMembers.forEach((member) => {
        if (member.UserId === userId) {
          member.Username = newNickname;
          updatedMembers += 1;
        }
      });
      if (tournamentData.UserMatch?.users?.length) {
        let changed = false;
        tournamentData.UserMatch.users = tournamentData.UserMatch.users.map((u) => {
          if (u["@user-id"] === userId && u["@nick"] !== newNickname) {
            changed = true;
            return { ...u, "@nick": newNickname };
          }
          return u;
        });
        if (changed) updatedUserMatches += 1;
      }
      if (tournamentData.UserMatches?.length) {
        tournamentData.UserMatches.forEach((match) => {
          if (!match?.users?.length) return;
          let changed = false;
          match.users = match.users.map((u) => {
            if (u["@user-id"] === userId && u["@nick"] !== newNickname) {
              changed = true;
              return { ...u, "@nick": newNickname };
            }
            return u;
          });
          if (changed) updatedUserMatches += 1;
        });
      }
    });

    await LoginProviderUser.save();
    await DatabaseUser.save();
    const updateManyResult = await BackboneUser.updateMany(
      { [`Tournaments.$[].PartyMembers`]: { $elemMatch: { UserId: userId } } },
      { $set: { "Tournaments.$[].PartyMembers.$[member].Username": newNickname } },
      { arrayFilters: [{ "member.UserId": userId }] }
    );
    msg(
      "[ChangeNick] nickname update done " +
        JSON.stringify({
          userId,
          updatedMembers,
          updatedUserMatches,
          updateManyResult: {
            matchedCount: (updateManyResult as any)?.matchedCount ?? null,
            modifiedCount: (updateManyResult as any)?.modifiedCount ?? null,
          },
        })
    );
    await SyncNicknameInTournamentData(userId, newNickname);
  } else {
    msg("[ChangeNick] nickname unchanged for userId: " + DatabaseUser.UserId);
  }

  return res.status(200).json({
    nickName: req.body.nickName,
  });
  }
);

export default {
  App,
  DefaultAPI: "/api/v1",
};
