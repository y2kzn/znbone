import { Router } from "express";
import j from "joi";
import { LPUser } from "../../Models/LPUser";
import { BackboneUser } from "../../Models/BackboneUser";
import { msg } from "../../Modules/Logger";
import { JWT_SECRET } from "../../Backbone/Config";
import { MongoServerError } from "mongodb";
import jwt from "jsonwebtoken";
import { AppId } from "../../Modules/Constants";
import { GetStarDatabase } from "../../Handlers/Server";

const App = Router();

const LoginSchema = j
  .object({
    backbone_app_id: j.string().required().valid(AppId),
    "x-unity-version": j.string().required(),
  })
  .unknown(true);

const LoginBodySchema = j
  .object({
    createNewUser: j.number().required(),
    userId: j.number().required(),
    deviceId: j.string().required(),
    deviceName: j.string().required(),
    devicePlatform: j.number().required(),
    nickName: j.string().required(),
    clientToken: j.string().required(),
  })
  .unknown(true);

App.post(
  "/userLogin:Provider",
  async (req, res) => {
    try {
      const Payload = {
        userid: req.body.userId,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
      };
      const RefreshPayload = {
        userid: req.body.userId,
        iat: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
        exp: Math.floor(Date.now() / 1000) + 14 * 24 * 60 * 60,
      };

      const ExpireAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const AccessToken = jwt.sign(Payload, JWT_SECRET);
      const RefreshToken = jwt.sign(RefreshPayload, JWT_SECRET);

      const [ExistingUserByUserId, ExistingUserByDeviceId ] = await Promise.all([
        LPUser.findOne({ UserId: req.body.userId }),
        LPUser.findOne({ DeviceIdentifier: req.body.deviceId })
      ]);

      if (ExistingUserByUserId) {
        if (ExistingUserByUserId.DeviceIdentifier !== req.body.deviceId) {
          if (
            ExistingUserByDeviceId &&
            ExistingUserByDeviceId.UserId !== req.body.userId.toString()
          ) {
            await LPUser.deleteOne({ DeviceIdentifier: req.body.deviceId });
          }
        }

        ExistingUserByUserId.Nickname = req.body.nickName; 
        ExistingUserByUserId.DeviceIdentifier = req.body.deviceId; 
        ExistingUserByUserId.DeviceName = req.body.deviceName;
        ExistingUserByUserId.DevicePlatform = req.body.devicePlatform;
        ExistingUserByUserId.ClientToken = req.body.clientToken;
        ExistingUserByUserId.AccessToken = AccessToken;
        ExistingUserByUserId.ExpireAt = ExpireAt;
        ExistingUserByUserId.RefreshToken = RefreshToken;

        await ExistingUserByUserId.save();

        return res.status(200).json({
          accessToken: AccessToken,
          expireAt: ExpireAt,
          refreshToken: RefreshToken,
        });
      }

      if (ExistingUserByDeviceId) {
        ExistingUserByDeviceId.UserId = req.body.userId.toString();
        ExistingUserByDeviceId.Nickname = req.body.nickName;
        ExistingUserByDeviceId.DeviceName = req.body.deviceName;
        ExistingUserByDeviceId.DevicePlatform = req.body.devicePlatform;
        ExistingUserByDeviceId.ClientToken = req.body.clientToken;
        ExistingUserByDeviceId.AccessToken = AccessToken;
        ExistingUserByDeviceId.ExpireAt = ExpireAt;
        ExistingUserByDeviceId.RefreshToken = RefreshToken;

        await ExistingUserByDeviceId.save();

        return res.status(200).json({
          accessToken: AccessToken,
          expireAt: ExpireAt,
          refreshToken: RefreshToken,
        });
      }

      if (req.body.createNewUser) {
        const NewUser = new LPUser({
          Nickname: req.body.nickName, 
          UserId: req.body.userId.toString(),
          DeviceIdentifier: req.body.deviceId,
          DeviceName: req.body.deviceName,
          DevicePlatform: req.body.devicePlatform,
          ClientToken: req.body.clientToken,
          AccessToken: AccessToken,
          ExpireAt: ExpireAt,
          RefreshToken: RefreshToken,
        });

        await NewUser.save();

        return res.status(200).json({
          accessToken: AccessToken,
          expireAt: ExpireAt,
          refreshToken: RefreshToken,
        });
      }

      return res.status(401).json({});
    } catch (err: any) {
      console.error("Erro no userLoginExternal:", err); 
      return res.status(500).json({});
    }
  }
);

export default {
  App,
  DefaultAPI: "/api/v1",
};
