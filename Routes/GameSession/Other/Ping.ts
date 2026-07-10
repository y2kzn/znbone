import { Router } from "express";
import j from "joi";
import { AppId } from "../../Modules/Constants";

const App = Router();
const PingSchema = j
  .object({
    backbone_app_id: j.string().required().valid(AppId),
    "x-unity-version": j.string().required(),
  })
  .unknown(true);

App.get("/ping", async (req, res) => {
  return res.status(200).json({});
});
export default {
  App,
  DefaultAPI: "/api/v1",
};

