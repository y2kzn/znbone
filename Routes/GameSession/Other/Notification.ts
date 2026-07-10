import { Router } from "express";
import j from "joi";
import { AppId } from "../../Modules/Constants";

const App = Router();
const NotificationSchema = j
  .object({
    backbone_app_id: j.string().required().valid(AppId),
    "x-unity-version": j.string().required(),
    access_token: j.string().required(),
  })
  .unknown(true);

App.post("/notificationGetActive", async (req, res) => {
  return res.json().status(200);
});
export default {
  App,
  DefaultAPI: "/api/v1",
};

