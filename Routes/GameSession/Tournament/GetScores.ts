import { Router } from "express";
import j from "joi";
import { GetScores } from "../../Backbone/Logic/GetScores";
import { AppId } from "../../Modules/Constants";


const App = Router();
const GetScoresSchema = j
  .object({
    backbone_app_id: j.string().required().valid(AppId),
    "x-unity-version": j.string().required(),
    access_token: j.string().required(),
  })
  .unknown(true);

const GetScoresBodySchema = j
  .object({
    tournamentId: j.number().required(),
    phaseId: j.number().required(),
    groupId: j.number().required(), 
    maxResults: j.number().required(),
    page: j.number().required(),
    accessToken: j.string().required(),
  })
  .unknown(true);

App.post(
  "/tournamentGetScores",
  async (req, res) => {
    try {
      const Data = await GetScores(
        req.body.tournamentId.toString(),
        req.body.phaseId,
        req.body.groupId,
        req.body.maxResults,
        req.body.page
      );
      res.json(Data).status(200);
    } catch (e: any) {
      if (e?.message?.startsWith("invalid tournamentid")) return res.status(404).json({});
      throw e;
    }
  }
);
export default {
  App,
  DefaultAPI: "/api/v1",
};

